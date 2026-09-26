# The secret value is populated outside Terraform. Only metadata and its ARN
# enter Terraform state; never add aws_secretsmanager_secret_version here.
resource "aws_secretsmanager_secret" "runpod_expiry_key" {
  name                    = "agentcloud/runpod/expiry-guard-api-key"
  description             = "Runpod Pod list/get/delete key for independent AgentCloud expiry guard"
  recovery_window_in_days = 7
  tags                    = { Project = "AgentCloudDemo" }
}

# The initial value is deliberately stale. Lambda updates it only after a full
# successful scan and confirmed disappearance of every expired Pod.
resource "aws_ssm_parameter" "runpod_expiry_last_success" {
  name  = "/agentcloud/runpod-expiry-guard/last-success"
  type  = "String"
  value = "1970-01-01T00:00:00Z"
  tags  = { Project = "AgentCloudDemo" }

  lifecycle {
    ignore_changes = [value]
  }
}

data "archive_file" "runpod_expiry" {
  type        = "zip"
  source_file = "${path.module}/runpod_expiry.py"
  output_path = "${path.module}/runpod_expiry.zip"
}

resource "aws_iam_role" "runpod_expiry" {
  name = "agentcloud-runpod-expiry"
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

resource "aws_iam_role_policy_attachment" "runpod_expiry_logs" {
  role       = aws_iam_role.runpod_expiry.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "runpod_expiry" {
  name = "ReadRunpodGuardKeyAndPublishFreshness"
  role = aws_iam_role.runpod_expiry.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.runpod_expiry_key.arn
      },
      {
        Effect   = "Allow"
        Action   = "ssm:PutParameter"
        Resource = aws_ssm_parameter.runpod_expiry_last_success.arn
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "runpod_expiry" {
  name              = "/aws/lambda/agentcloud-runpod-expiry"
  retention_in_days = 3
  tags              = { Project = "AgentCloudDemo" }
}

resource "aws_lambda_function" "runpod_expiry" {
  function_name    = "agentcloud-runpod-expiry"
  role             = aws_iam_role.runpod_expiry.arn
  handler          = "runpod_expiry.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.runpod_expiry.output_path
  source_code_hash = data.archive_file.runpod_expiry.output_base64sha256
  timeout          = 120
  memory_size      = 128
  environment {
    variables = {
      RUNPOD_SECRET_ARN   = aws_secretsmanager_secret.runpod_expiry_key.arn
      FRESHNESS_PARAMETER = aws_ssm_parameter.runpod_expiry_last_success.name
    }
  }
  tags       = { Project = "AgentCloudDemo" }
  depends_on = [aws_iam_role_policy.runpod_expiry, aws_iam_role_policy_attachment.runpod_expiry_logs, aws_cloudwatch_log_group.runpod_expiry]
}

resource "aws_cloudwatch_event_rule" "runpod_expiry" {
  name                = "agentcloud-runpod-expiry"
  description         = "Independently check named AgentCloud Runpod Pods every five minutes"
  schedule_expression = "rate(5 minutes)"
  tags                = { Project = "AgentCloudDemo" }
}

resource "aws_cloudwatch_event_target" "runpod_expiry" {
  rule      = aws_cloudwatch_event_rule.runpod_expiry.name
  target_id = "AgentCloudRunpodExpiry"
  arn       = aws_lambda_function.runpod_expiry.arn
  retry_policy {
    maximum_event_age_in_seconds = 900
    maximum_retry_attempts       = 2
  }
  depends_on = [aws_lambda_permission.runpod_expiry]
}

resource "aws_lambda_permission" "runpod_expiry" {
  statement_id  = "AllowRunpodExpirySchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.runpod_expiry.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.runpod_expiry.arn
}

# The staging worker reads the same narrowly scoped key for Runpod operations
# and checks the independently managed cleanup guard before allocating a Pod.
resource "aws_iam_role_policy" "runpod_guard_staging_read" {
  name = "ReadAgentCloudRunpodExpiryGuard"
  role = "agentcloud-auth-staging"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = aws_ssm_parameter.runpod_expiry_last_success.arn
      },
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.runpod_expiry_key.arn
      },
      {
        Effect   = "Allow"
        Action   = ["events:DescribeRule", "events:ListTargetsByRule"]
        Resource = aws_cloudwatch_event_rule.runpod_expiry.arn
      },
      {
        Effect   = "Allow"
        Action   = "lambda:GetFunctionConfiguration"
        Resource = aws_lambda_function.runpod_expiry.arn
      }
    ]
  })
}

output "runpod_expiry_function_arn" {
  value = aws_lambda_function.runpod_expiry.arn
}

output "runpod_expiry_last_success_parameter" {
  value = aws_ssm_parameter.runpod_expiry_last_success.name
}
