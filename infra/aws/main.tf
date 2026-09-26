data "aws_caller_identity" "current" {}
data "aws_vpc" "default" {
  default = true
}

# Imported after the original 4-vCPU request was submitted. AWS must approve it;
# Terraform does not interpret this declaration as approval or retry the case.
resource "aws_servicequotas_service_quota" "gpu" {
  service_code = "ec2"
  quota_code   = "L-DB2E81BA"
  value        = 4

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_budgets_budget" "demo" {
  name         = "AgentCloud-Demo-Gross-25"
  budget_type  = "COST"
  limit_amount = "25"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit             = false
    include_refund             = false
    include_tax                = true
    include_subscription       = true
    include_upfront            = true
    include_recurring          = true
    include_other_subscription = true
    include_support            = true
    include_discount           = true
    use_blended                = false
    use_amortized              = false
  }

  dynamic "notification" {
    for_each = toset([50, 80, 100])
    content {
      comparison_operator        = "GREATER_THAN"
      notification_type          = "ACTUAL"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      subscriber_email_addresses = [var.owner_email]
    }
  }
}

resource "aws_iam_role" "instance" {
  name = "agentcloud-demo-instance"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = { Project = "AgentCloudDemo" }
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instance" {
  name = "agentcloud-demo-instance"
  role = aws_iam_role.instance.name
}

resource "aws_security_group" "instance" {
  name        = "agentcloud-demo-ssm"
  description = "AgentCloud demo SSM HTTPS egress only"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Project = "AgentCloudDemo" }
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.instance.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
  description       = "Systems Manager HTTPS endpoints"
}

resource "aws_launch_template" "gpu" {
  name          = "agentcloud-demo-g6"
  image_id      = var.gpu_ami_id
  instance_type = "g6.xlarge"

  iam_instance_profile {
    arn = aws_iam_instance_profile.instance.arn
  }
  vpc_security_group_ids = [aws_security_group.instance.id]
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  block_device_mappings {
    device_name = var.gpu_root_device
    ebs {
      volume_size           = 25
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }
  tag_specifications {
    resource_type = "instance"
    tags = {
      Project              = "AgentCloudDemo"
      AgentCloudAutoExpire = "true"
    }
  }
  tag_specifications {
    resource_type = "volume"
    tags = {
      Project              = "AgentCloudDemo"
      AgentCloudAutoExpire = "true"
    }
  }
  tags = { Project = "AgentCloudDemo" }
}

data "archive_file" "expiry" {
  type        = "zip"
  source_file = "${path.module}/expiry.py"
  output_path = "${path.module}/expiry.zip"
}

resource "aws_iam_role" "expiry" {
  name = "agentcloud-demo-expiry"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = { Project = "AgentCloudDemo" }
}

resource "aws_iam_role_policy_attachment" "expiry_logs" {
  role       = aws_iam_role.expiry.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "expiry" {
  name = "FindAndTerminateExpiredDemoInstances"
  role = aws_iam_role.expiry.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ec2:DescribeInstances", Resource = "*" },
      {
        Effect   = "Allow"
        Action   = "ec2:TerminateInstances"
        Resource = "arn:aws:ec2:us-east-1:${var.account_id}:instance/*"
        Condition = { StringEquals = {
          "ec2:ResourceTag/Project"              = "AgentCloudDemo"
          "ec2:ResourceTag/AgentCloudAutoExpire" = "true"
        } }
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "expiry" {
  name              = "/aws/lambda/agentcloud-demo-expiry"
  retention_in_days = 3
  tags              = { Project = "AgentCloudDemo" }
}

resource "aws_lambda_function" "expiry" {
  function_name    = "agentcloud-demo-expiry"
  role             = aws_iam_role.expiry.arn
  handler          = "expiry.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.expiry.output_path
  source_code_hash = data.archive_file.expiry.output_base64sha256
  timeout          = 60
  memory_size      = 128
  environment {
    variables = { MAX_AGE_MINUTES = "120" }
  }
  tags       = { Project = "AgentCloudDemo" }
  depends_on = [aws_iam_role_policy.expiry, aws_iam_role_policy_attachment.expiry_logs, aws_cloudwatch_log_group.expiry]
}

resource "aws_cloudwatch_event_rule" "expiry" {
  name                = "agentcloud-demo-expiry"
  description         = "Check tagged AgentCloud demo instances every five minutes"
  schedule_expression = "rate(5 minutes)"
  tags                = { Project = "AgentCloudDemo" }
}

resource "aws_cloudwatch_event_target" "expiry" {
  rule      = aws_cloudwatch_event_rule.expiry.name
  target_id = "AgentCloudDemoExpiry"
  arn       = aws_lambda_function.expiry.arn
}

resource "aws_lambda_permission" "expiry" {
  statement_id  = "AllowEventBridgeSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.expiry.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.expiry.arn
}

output "launch_template_id" {
  value = aws_launch_template.gpu.id
}

output "security_group_id" {
  value = aws_security_group.instance.id
}

output "instance_profile_arn" {
  value = aws_iam_instance_profile.instance.arn
}

output "expiry_function_arn" {
  value = aws_lambda_function.expiry.arn
}
