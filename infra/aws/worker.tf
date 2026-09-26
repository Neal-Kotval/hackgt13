# The private auth staging instance may assume this role. Its web application
# does not receive the role session; only the separately launched worker does.
resource "aws_iam_role" "worker" {
  name = "agentcloud-demo-worker"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.account_id}:role/agentcloud-auth-staging" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = { Project = "AgentCloudDemo" }
}

# This policy is a new attachment to the Terraform-managed staging role.
# The role itself stays owned by infra/aws-auth/.
resource "aws_iam_role_policy" "staging_assume_worker" {
  name = "AssumeAgentCloudDemoWorker"
  role = "agentcloud-auth-staging"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "sts:AssumeRole"
      Resource = aws_iam_role.worker.arn
    }]
  })
}

resource "aws_iam_role_policy" "worker" {
  name = "ManageOnlyApprovedAgentCloudDemoGPU"
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadOnlyLaunchGates"
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances", "ec2:DescribeImages", "ec2:DescribeLaunchTemplates",
          "ec2:DescribeLaunchTemplateVersions", "ec2:DescribeSecurityGroups", "ec2:DescribeSubnets",
          "ec2:DescribeInstanceTypeOfferings", "ec2:DescribeVolumes",
          "servicequotas:GetServiceQuota", "freetier:GetAccountPlanState",
          "pricing:GetProducts", "budgets:ViewBudget", "lambda:GetFunctionConfiguration",
          "events:DescribeRule", "events:ListTargetsByRule",
          "ssm:DescribeInstanceInformation", "ssm:GetCommandInvocation",
          "sts:GetCallerIdentity"
        ]
        Resource = "*"
      },
      {
        Sid    = "LaunchOnlyThroughPinnedTemplate"
        Effect = "Allow"
        Action = "ec2:RunInstances"
        Resource = [
          "arn:aws:ec2:us-east-1::image/*",
          "arn:aws:ec2:us-east-1:${var.account_id}:instance/*",
          "arn:aws:ec2:us-east-1:${var.account_id}:volume/*",
          "arn:aws:ec2:us-east-1:${var.account_id}:network-interface/*",
          "arn:aws:ec2:us-east-1:${var.account_id}:subnet/*",
          "arn:aws:ec2:us-east-1:${var.account_id}:security-group/*",
          aws_launch_template.gpu.arn
        ]
        Condition = { StringEquals = {
          "ec2:LaunchTemplate" = aws_launch_template.gpu.arn
          "ec2:InstanceType"   = "g6.xlarge"
        } }
      },
      {
        Sid    = "TagOnLaunchOnly"
        Effect = "Allow"
        Action = "ec2:CreateTags"
        Resource = [
          "arn:aws:ec2:us-east-1:${var.account_id}:instance/*",
          "arn:aws:ec2:us-east-1:${var.account_id}:volume/*"
        ]
        Condition = { StringEquals = { "ec2:CreateAction" = "RunInstances" } }
      },
      {
        Sid       = "PassOnlyDemoInstanceRole"
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = aws_iam_role.instance.arn
        Condition = { StringEquals = { "iam:PassedToService" = "ec2.amazonaws.com" } }
      },
      {
        Sid      = "ManageOnlyTaggedDemoInstances"
        Effect   = "Allow"
        Action   = ["ec2:TerminateInstances", "ec2:StopInstances", "ec2:StartInstances"]
        Resource = "arn:aws:ec2:us-east-1:${var.account_id}:instance/*"
        Condition = { StringEquals = {
          "ec2:ResourceTag/Project"              = "AgentCloudDemo"
          "ec2:ResourceTag/AgentCloudAutoExpire" = "true"
        } }
      },
      {
        Sid      = "UseRunShellScriptDocument"
        Effect   = "Allow"
        Action   = "ssm:SendCommand"
        Resource = "arn:aws:ssm:us-east-1::document/AWS-RunShellScript"
      },
      {
        Sid      = "RunVerificationOnTaggedDemoInstances"
        Effect   = "Allow"
        Action   = "ssm:SendCommand"
        Resource = "arn:aws:ec2:us-east-1:${var.account_id}:instance/*"
        Condition = { StringEquals = {
          "ssm:resourceTag/Project"              = "AgentCloudDemo"
          "ssm:resourceTag/AgentCloudAutoExpire" = "true"
        } }
      }
    ]
  })
}

output "worker_role_arn" {
  value = aws_iam_role.worker.arn
}
