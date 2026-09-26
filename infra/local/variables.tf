variable "docker_host" {
  description = "Local Docker engine Unix socket. Docker Desktop may use unix:///Users/<user>/.docker/run/docker.sock."
  type        = string
  default     = "unix:///var/run/docker.sock"

  validation {
    condition     = startswith(var.docker_host, "unix:///")
    error_message = "Use an absolute local Unix socket; remote Docker hosts are not supported by this local root."
  }
}

variable "port" {
  description = "Loopback port for the local backend; must be free before starting it."
  type        = number
  default     = 3002

  validation {
    condition     = var.port >= 1024 && var.port <= 65535 && floor(var.port) == var.port
    error_message = "Choose an integer port between 1024 and 65535."
  }
}
