locals {
  repository_root = abspath("${path.module}/../..")
  backend_url     = "http://127.0.0.1:${var.port}"
  # Hash only build inputs, excluding local data, secrets, caches and Terraform state.
  source_files = setunion(
    fileset(local.repository_root, "*.json"),
    fileset(local.repository_root, "*.ts"),
    fileset(local.repository_root, "*.mjs"),
    fileset(local.repository_root, "Dockerfile"),
    fileset(local.repository_root, ".dockerignore"),
    fileset(local.repository_root, "app/**"),
    fileset(local.repository_root, "components/**"),
    fileset(local.repository_root, "lib/**"),
    fileset(local.repository_root, "public/**"),
    fileset(local.repository_root, "scripts/**"),
  )
}

resource "docker_image" "backend" {
  name         = "agentcloud-backend:local"
  keep_locally = true

  build {
    context    = local.repository_root
    dockerfile = "${local.repository_root}/Dockerfile"
  }

  triggers = {
    source = sha256(join("", [for file in sort(tolist(local.source_files)) : "${file}:${filesha256("${local.repository_root}/${file}")}"]))
  }
}

resource "docker_volume" "data" {
  name = "agentcloud-terraform-local-data"

  # Restart/replacement keeps data. An explicit reset requires removing this guard.
  lifecycle {
    prevent_destroy = true
  }
}

resource "docker_container" "backend" {
  name           = "agentcloud-terraform-local-backend"
  image          = docker_image.backend.image_id
  user           = "node"
  restart        = "unless-stopped"
  remove_volumes = false

  env = [
    "NODE_ENV=development",
    "PORT=3000",
    "HOSTNAME=0.0.0.0",
    "BETTER_AUTH_URL=${local.backend_url}",
    "AGENTCLOUD_DATA_DIR=/data",
    "AGENTCLOUD_MAIL_MODE=local",
  ]

  ports {
    internal = 3000
    external = var.port
    ip       = "127.0.0.1"
  }

  volumes {
    volume_name    = docker_volume.data.name
    container_path = "/data"
  }
}
