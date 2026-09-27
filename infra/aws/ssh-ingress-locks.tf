# All installs sharing the SSH group serialize ownership changes, including the
# last-consumer rule deletion. Application leases expire explicitly; DynamoDB TTL
# is intentionally disabled because asynchronous TTL deletion can delete a lease.
resource "aws_dynamodb_table" "ssh_ingress_locks" {
  name         = "agentcloud-ssh-ingress-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "group_id"
  attribute {
    name = "group_id"
    type = "S"
  }
  server_side_encryption { enabled = true }
  tags = { Project = "AgentCloudDemo" }
}

resource "aws_iam_role_policy" "worker_ssh_ingress_lock" {
  name = "SerializeAgentCloudSshIngress"
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
      Resource = aws_dynamodb_table.ssh_ingress_locks.arn
      Condition = {
        "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = [aws_security_group.cpu_ssh.id, "${aws_security_group.cpu_ssh.id}/*"] }
      }
    }]
  })
}
