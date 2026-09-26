variable "account_id" {
  type    = string
  default = "662660921850"
}

variable "owner_email" {
  type    = string
  default = "neal.kotval@gmail.com"
}

variable "gpu_ami_id" {
  type        = string
  description = "GPU Deep Learning AMI ID, verified in us-east-1 before apply or launch."
  default     = "ami-0bf870650c1cfee60"
}

variable "gpu_root_device" {
  type    = string
  default = "/dev/xvda"
}
