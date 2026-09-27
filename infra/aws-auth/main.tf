data "aws_vpc" "default" {
  default = true
}

data "aws_subnet" "selected" {
  id = var.subnet_id

  lifecycle {
    postcondition {
      condition     = self.vpc_id == data.aws_vpc.default.id && self.map_public_ip_on_launch
      error_message = "Select a default-VPC subnet with public IPv4 assignment for outbound SSM and tunnel access."
    }
  }
}

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  name = "agentcloud-auth-staging"
  tags = {
    Project     = "AgentCloud"
    Environment = "auth-staging"
    ManagedBy   = "Terraform"
  }
}

resource "aws_s3_bucket" "artifact" {
  bucket        = "${local.name}-${var.account_id}-${var.region}"
  force_destroy = false
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "artifact" {
  bucket                  = aws_s3_bucket.artifact.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifact" {
  bucket = aws_s3_bucket.artifact.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "artifact" {
  bucket = aws_s3_bucket.artifact.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        aws_s3_bucket.artifact.arn,
        "${aws_s3_bucket.artifact.arn}/*"
      ]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.artifact]
}

resource "aws_iam_role" "instance" {
  name = local.name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "artifact_read" {
  name = "artifact-read"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "${aws_s3_bucket.artifact.arn}/releases/app.tar.gz"
    }]
  })
}

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "agentcloud/auth-staging/better-auth-secret"
  description             = "Better Auth signing secret for staging; value populated outside Terraform"
  recovery_window_in_days = 0
  tags                    = local.tags
}

resource "aws_iam_role_policy" "runtime_secret_read" {
  name = "runtime-secret-read"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = aws_secretsmanager_secret.runtime.arn
    }]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = local.name
  role = aws_iam_role.instance.name
  tags = local.tags
}

resource "aws_security_group" "instance" {
  name        = "${local.name}-outbound-only"
  description = "No inbound access; outbound HTTPS for SSM, S3, packages, and tunnel"
  vpc_id      = data.aws_vpc.default.id
  tags        = local.tags
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.instance.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
  description       = "Outbound HTTPS only"
}

# HAC-166: the aws-cpu worker and the backend's Codex sessions SSH to AWS CPU environments on
# port 22 (their public IPv4). Each box's own security group still admits only this host's /32
# and the requesting employee's /32.
resource "aws_vpc_security_group_egress_rule" "aws_cpu_ssh" {
  security_group_id = aws_security_group.instance.id
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = "0.0.0.0/0"
  description       = "Outbound SSH to AgentCloud aws-cpu environments"
}

resource "aws_vpc_security_group_egress_rule" "runpod_ssh" {
  security_group_id = aws_security_group.instance.id
  ip_protocol       = "tcp"
  from_port         = 1024
  to_port           = 65535
  cidr_ipv4         = "0.0.0.0/0"
  description       = "Outbound mapped SSH port for approved Runpod Pods"
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_vpc_security_group_ingress_rule" "cloudfront_app" {
  security_group_id = aws_security_group.instance.id
  ip_protocol       = "tcp"
  from_port         = 3000
  to_port           = 3000
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
  description       = "CloudFront origin-facing servers to the app"
}

resource "aws_instance" "app" {
  ami                                  = data.aws_ssm_parameter.al2023_ami.value
  instance_type                        = var.instance_type
  subnet_id                            = data.aws_subnet.selected.id
  vpc_security_group_ids               = [aws_security_group.instance.id]
  associate_public_ip_address          = true
  iam_instance_profile                 = aws_iam_instance_profile.instance.name
  ebs_optimized                        = true
  monitoring                           = false
  instance_initiated_shutdown_behavior = "stop"
  user_data                            = <<-EOT
    #!/bin/bash
    set -eu
    cat >/etc/systemd/system/agentcloud-staging-stop.service <<'SERVICE'
    [Unit]
    Description=Stop AgentCloud staging EC2 instance after two hours
    [Service]
    Type=oneshot
    ExecStart=/usr/bin/systemctl poweroff
    SERVICE
    cat >/etc/systemd/system/agentcloud-staging-stop.timer <<'TIMER'
    [Unit]
    Description=Two-hour maximum runtime per staging boot
    [Timer]
    OnBootSec=2h
    Unit=agentcloud-staging-stop.service
    [Install]
    WantedBy=timers.target
    TIMER
    systemctl daemon-reload
    systemctl enable --now agentcloud-staging-stop.timer
  EOT

  credit_specification {
    cpu_credits = "standard"
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size           = 20
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  tags = merge(local.tags, { Name = local.name })

  depends_on = [
    aws_iam_role_policy_attachment.ssm,
    aws_iam_role_policy.artifact_read,
    aws_iam_role_policy.runtime_secret_read,
    aws_vpc_security_group_egress_rule.https,
    aws_vpc_security_group_egress_rule.runpod_ssh,
    aws_vpc_security_group_egress_rule.aws_cpu_ssh
  ]
}

resource "aws_eip" "app" {
  domain   = "vpc"
  instance = aws_instance.app.id
  tags     = local.tags
}

resource "aws_cloudfront_distribution" "app" {
  enabled = true
  # IPv4 only: CloudFront-Viewer-Address must be the IPv4 the employee also uses for SSH to
  # aws-cpu boxes (HAC-166). Boxes have no IPv6, so an IPv6 viewer address cannot be admitted.
  is_ipv6_enabled = false
  price_class     = "PriceClass_100"
  comment         = "AgentCloud shared hackathon app"

  origin {
    domain_name = aws_eip.app.public_dns
    origin_id   = "agentcloud-app"

    custom_origin_config {
      http_port              = 3000
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id         = "agentcloud-app"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
    origin_request_policy_id = "33f36d7e-f396-46d9-90e0-52428a34d9dc" # AllViewerAndCloudFrontHeaders-2022-06
    compress                 = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  depends_on = [aws_vpc_security_group_ingress_rule.cloudfront_app]
}

output "instance_id" {
  value = aws_instance.app.id
}

output "artifact_bucket_name" {
  value = aws_s3_bucket.artifact.bucket
}

output "region" {
  value = var.region
}

output "auth_secret_arn" {
  value = aws_secretsmanager_secret.runtime.arn
}

output "public_url" {
  value = "https://${aws_cloudfront_distribution.app.domain_name}"
}
