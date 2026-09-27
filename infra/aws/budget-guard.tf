# HAC-115: automatic launch block at the monthly budget.
# AWS has no general hard spending cap for this account. When actual gross spend
# (before credits) reaches 100% of AgentCloud-Demo-Gross-25, AWS Budgets attaches a
# deny policy to the GPU worker role so AgentCloud cannot launch or start instances.
# Running instances stay bounded by the expiry guard. Budget data can lag by hours,
# and the root user and other roles are not restricted by this action.

resource "aws_iam_policy" "budget_launch_deny" {
  name        = "agentcloud-budget-launch-deny"
  description = "Attached by AWS Budgets when the AgentCloud monthly budget is exceeded"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "BudgetExceededDenyLaunch"
      Effect   = "Deny"
      Action   = ["ec2:RunInstances", "ec2:StartInstances", "ec2:CreateVolume"]
      Resource = "*"
    }]
  })
  tags = { Project = "AgentCloudDemo" }
}

resource "aws_iam_role" "budget_action" {
  name = "agentcloud-budget-action"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "budgets.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = var.account_id } }
    }]
  })
  tags = { Project = "AgentCloudDemo" }
}

# The Budgets service may only attach or detach this one deny policy on the worker role.
resource "aws_iam_role_policy" "budget_action" {
  name = "attach-launch-deny-to-worker"
  role = aws_iam_role.budget_action.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
      Resource  = aws_iam_role.worker.arn
      Condition = { ArnEquals = { "iam:PolicyARN" = aws_iam_policy.budget_launch_deny.arn } }
    }]
  })
}

resource "aws_budgets_budget_action" "launch_deny" {
  budget_name        = aws_budgets_budget.demo.name
  action_type        = "APPLY_IAM_POLICY"
  approval_model     = "AUTOMATIC"
  notification_type  = "ACTUAL"
  execution_role_arn = aws_iam_role.budget_action.arn

  action_threshold {
    action_threshold_type  = "PERCENTAGE"
    action_threshold_value = 100
  }

  definition {
    iam_action_definition {
      policy_arn = aws_iam_policy.budget_launch_deny.arn
      roles      = [aws_iam_role.worker.name]
    }
  }

  subscriber {
    address           = var.owner_email
    subscription_type = "EMAIL"
  }
}
