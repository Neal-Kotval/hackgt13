# HAC-125: AWS CPU environment (profile `aws-cpu`) that the desktop app opens over SSH.
# Sized environments: every CPU size in lib/machine-catalog.mjs (aws-cpu t3.medium,
# aws-cpu-medium t3.xlarge, aws-cpu-large m7i.2xlarge) launches through this template; the
# worker overrides the instance type and the root volume size per job. GPU environments use
# the template in gpu-env.tf. The worker policy below allows exactly the catalog's types.
#
# Additive only: nothing here modifies the GPU launch template, the existing worker
# policy, the budget guard, or the expiry guard. Applying this file creates no instance.
#
# Desktop SSH path (see AWS_SETUP.md, "CPU environment"): the instance gets a public
# IPv4 address from the selected subnet. Its SSH security group starts with no inbound
# rules. For each approved job the worker adds one tcp/22 rule from the requester's
# /32, tagged with the job ID, and revokes it at teardown. SSM stays available for the
# worker to read the on-box host public key and bootstrap state; the host private key
# is generated on the box and never leaves it.

variable "cpu_ami_id" {
  type        = string
  description = "Amazon Linux 2023 x86_64 AMI for the CPU environment. Resolved from /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 on 2026-09-26; re-verify before apply or launch."
  default     = "ami-0fef201115eefe936"
}

variable "cpu_root_device" {
  type    = string
  default = "/dev/xvda"
}

resource "aws_security_group" "cpu_ssh" {
  name        = "agentcloud-demo-cpu-ssh"
  description = "AgentCloud CPU environment SSH; worker-managed per-job /32 rules only"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Project = "AgentCloudDemo" }

  # Per-job ingress rules are created and revoked by the worker, never by Terraform.
  # Terraform removes the default allow-all egress rule; egress comes from the SSM group.
  lifecycle {
    ignore_changes = [ingress]
  }
}

locals {
  # Must equal the instance types in lib/machine-catalog.mjs, per launch template.
  catalog_cpu_instance_types = ["t3.medium", "t3.xlarge", "m7i.2xlarge"]
  catalog_gpu_instance_types = ["g4dn.xlarge", "g6.xlarge", "g5.xlarge"]
  # Largest root volume the catalog offers (diskOptionsGib).
  catalog_max_disk_gib = 100
}

resource "aws_launch_template" "cpu" {
  name          = "agentcloud-demo-cpu"
  image_id      = var.cpu_ami_id
  instance_type = "t3.medium"
  # RunInstances uses $Default; keep it on the latest version after any change here.
  update_default_version = true

  # The on-box self-destruct timer (`shutdown -P +N` in user data) then terminates the
  # instance, and delete_on_termination removes its volume.
  instance_initiated_shutdown_behavior = "terminate"

  # No credit specification here: m7i.2xlarge has no CPU credits. The worker requests
  # standard credits in RunInstances for T3 sizes, which avoids T3 Unlimited surplus charges.

  iam_instance_profile {
    arn = aws_iam_instance_profile.instance.arn
  }
  vpc_security_group_ids = [aws_security_group.instance.id, aws_security_group.cpu_ssh.id]
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  block_device_mappings {
    device_name = var.cpu_root_device
    ebs {
      volume_size           = 20
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
      AgentCloudProfile    = "aws-cpu"
    }
  }
  tag_specifications {
    resource_type = "volume"
    tags = {
      Project              = "AgentCloudDemo"
      AgentCloudAutoExpire = "true"
      AgentCloudProfile    = "aws-cpu"
    }
  }
  tags = { Project = "AgentCloudDemo" }
}

# A separate inline policy on the existing worker role, so the GPU policy is unchanged.
# The HAC-115 budget action already denies RunInstances/StartInstances/CreateVolume on
# this role, so it also blocks CPU and GPU environment launches at the monthly budget.
# It covers both sized-environment templates (CPU and gpu-env): each template may launch
# only its catalog instance types, and every root volume is at most 100 GiB.
resource "aws_iam_role_policy" "worker_cpu" {
  name = "ManageOnlyApprovedAgentCloudDemoCPU"
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadSecurityGroupRules"
        Effect   = "Allow"
        Action   = "ec2:DescribeSecurityGroupRules"
        Resource = "*"
      },
      {
        Sid      = "LaunchOnlyCatalogCpuTypesThroughPinnedCpuTemplate"
        Effect   = "Allow"
        Action   = "ec2:RunInstances"
        Resource = "arn:aws:ec2:us-east-1:${var.account_id}:instance/*"
        Condition = { StringEquals = {
          "ec2:LaunchTemplate" = aws_launch_template.cpu.arn
          "ec2:InstanceType"   = local.catalog_cpu_instance_types
        } }
      },
      {
        Sid      = "LaunchOnlyCatalogGpuTypesThroughPinnedGpuEnvTemplate"
        Effect   = "Allow"
        Action   = "ec2:RunInstances"
        Resource = "arn:aws:ec2:us-east-1:${var.account_id}:instance/*"
        Condition = { StringEquals = {
          "ec2:LaunchTemplate" = aws_launch_template.gpu_env.arn
          "ec2:InstanceType"   = local.catalog_gpu_instance_types
        } }
      },
      {
        Sid    = "UsePinnedEnvironmentTemplatesAndLaunchResources"
        Effect = "Allow"
        Action = "ec2:RunInstances"
        Resource = [
          "arn:aws:ec2:us-east-1::image/${var.cpu_ami_id}",
          "arn:aws:ec2:us-east-1::image/${var.gpu_env_ami_id}",
          "arn:aws:ec2:us-east-1:${var.account_id}:network-interface/*",
          "arn:aws:ec2:us-east-1:${var.account_id}:subnet/${var.gpu_subnet_id}",
          aws_security_group.instance.arn,
          aws_security_group.cpu_ssh.arn,
          aws_launch_template.cpu.arn,
          aws_launch_template.gpu_env.arn
        ]
        Condition = { StringEquals = { "ec2:LaunchTemplate" = [aws_launch_template.cpu.arn, aws_launch_template.gpu_env.arn] } }
      },
      {
        Sid      = "CreateRootVolumesUpTo100GiBThroughEnvironmentTemplates"
        Effect   = "Allow"
        Action   = "ec2:RunInstances"
        Resource = "arn:aws:ec2:us-east-1:${var.account_id}:volume/*"
        Condition = {
          StringEquals          = { "ec2:LaunchTemplate" = [aws_launch_template.cpu.arn, aws_launch_template.gpu_env.arn] }
          NumericLessThanEquals = { "ec2:VolumeSize" = local.catalog_max_disk_gib }
        }
      },
      {
        Sid    = "ManagePerJobSshRulesOnCpuGroupOnly"
        Effect = "Allow"
        Action = ["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress"]
        Resource = [
          aws_security_group.cpu_ssh.arn,
          "arn:aws:ec2:us-east-1:${var.account_id}:security-group-rule/*"
        ]
      },
      {
        Sid      = "MaintainManagedSshRuleOwners"
        Effect   = "Allow"
        Action   = ["ec2:CreateTags", "ec2:DeleteTags"]
        Resource = "arn:aws:ec2:us-east-1:${var.account_id}:security-group-rule/*"
        Condition = {
          StringEquals              = { "ec2:ResourceTag/Project" = "AgentCloudDemo" }
          "ForAllValues:StringLike" = { "aws:TagKeys" = ["AgentCloudOwner:*", "AgentCloudJobId"] }
        }
      },
      {
        Sid       = "TagSshRulesOnCreateOnly"
        Effect    = "Allow"
        Action    = "ec2:CreateTags"
        Resource  = "arn:aws:ec2:us-east-1:${var.account_id}:security-group-rule/*"
        Condition = { StringEquals = { "ec2:CreateAction" = "AuthorizeSecurityGroupIngress" } }
      }
    ]
  })
}

output "cpu_launch_template_id" {
  value = aws_launch_template.cpu.id
}

output "cpu_ssh_security_group_id" {
  value = aws_security_group.cpu_ssh.id
}
