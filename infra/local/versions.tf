terraform {
  required_version = ">= 1.6, < 2.0"

  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.6.2"
    }
  }
}

# A Unix socket keeps this root attached to a local Docker engine.
provider "docker" {
  host = var.docker_host
}
