variable "account_id" {
  type    = string
  default = "662660921850"
}

variable "region" {
  type    = string
  default = "us-east-1"

  validation {
    condition     = var.region == "us-east-1"
    error_message = "This staging configuration is limited to us-east-1."
  }
}

variable "subnet_id" {
  type        = string
  description = "Existing default VPC public subnet in us-east-1."
  default     = "subnet-0d76bc090d2666592"
}

variable "instance_type" {
  type    = string
  default = "t3.small"

  validation {
    condition     = var.instance_type == "t3.small"
    error_message = "The staging cost envelope currently supports only t3.small."
  }
}
