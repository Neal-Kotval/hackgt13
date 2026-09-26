locals {
  teammate_iam_users = {
    NathanBai    = "Nathan Bai"
    AarushMathad = "Aarush Mathad"
  }
}

resource "aws_iam_group" "teammate_admins" {
  name = "agentcloud-teammate-admins"
}

resource "aws_iam_group_policy_attachment" "teammate_admins" {
  group      = aws_iam_group.teammate_admins.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

resource "aws_iam_user" "teammate" {
  for_each = local.teammate_iam_users
  name     = each.key

  tags = {
    Name = each.value
  }
}

resource "aws_iam_group_membership" "teammates" {
  name  = "agentcloud-teammate-admins"
  group = aws_iam_group.teammate_admins.name
  users = [for user in aws_iam_user.teammate : user.name]
}

resource "aws_iam_user_login_profile" "teammate" {
  for_each                = aws_iam_user.teammate
  user                    = each.value.name
  pgp_key                 = filebase64("${path.module}/iam-invite-public.gpg")
  password_length         = 32
  password_reset_required = true
}

output "teammate_encrypted_initial_passwords" {
  description = "PGP-encrypted first-login passwords; decrypt locally and deliver to each user privately."
  value = {
    for name, profile in aws_iam_user_login_profile.teammate :
    name => profile.encrypted_password
  }
  sensitive = true
}
