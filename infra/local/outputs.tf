output "backend_url" {
  description = "Configured local URL; this output alone is not a health check."
  value       = local.backend_url
}

output "data_volume" {
  description = "Local persistent volume holding application records, auth and captured mail."
  value       = docker_volume.data.name
}
