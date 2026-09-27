# Sized environments: GPU environments (aws-gpu-t4 g4dn.xlarge, aws-gpu-l4 g6.xlarge,
# aws-gpu-a10g g5.xlarge in lib/machine-catalog.mjs). Same path as the CPU environment in
# cpu.tf: public IPv4, the shared per-job /32 SSH group, IMDSv2, a host key generated on the
# box, and Codex installed at bootstrap. The worker overrides the instance type and the root
# volume per job; the ManageOnlyApprovedAgentCloudDemoCPU policy in cpu.tf allows only the
# catalog GPU types through this template and root volumes up to 100 GiB.
#
# Additive: the SSM-only g6 template `agentcloud-demo-g6` (main.tf) and its policy are
# unchanged. Applying this file creates no instance. Every GPU size is 4 vCPU, so one fits
# the account's 4-vCPU "Running On-Demand G and VT instances" quota (L-DB2E81BA); a larger
# GPU size needs a quota increase first.

variable "gpu_env_ami_id" {
  type        = string
  description = "Deep Learning Base OSS Nvidia Driver GPU AMI (Amazon Linux 2023) x86_64, 20260925 build (owner 898082745236, 75 GiB root snapshot). Resolved from /aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-amazon-linux-2023/latest/ami-id on 2026-09-27; re-verify before apply or launch."
  default     = "ami-0aa6adb5fc746dff3"
}

resource "aws_launch_template" "gpu_env" {
  name = "agentcloud-demo-gpu-env"
  # The AMI ships the NVIDIA driver; bootstrap fails unless nvidia-smi sees a GPU.
  image_id = var.gpu_env_ami_id
  # Default only; the worker sets the job's catalog GPU type.
  instance_type          = "g4dn.xlarge"
  update_default_version = true

  # The on-box self-destruct timer (`shutdown -P +N` in user data) then terminates the
  # instance, and delete_on_termination removes its volume.
  instance_initiated_shutdown_behavior = "terminate"

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
    device_name = var.gpu_root_device
    ebs {
      # The AMI's root snapshot is 75 GiB; the catalog's GPU disk minimum is 100 GiB.
      volume_size           = 100
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

output "gpu_env_launch_template_id" {
  value = aws_launch_template.gpu_env.id
}
