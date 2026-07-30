output "web_service_url" {
  description = "Public URL of the Render web service."
  value       = render_web_service.ship.url
}

output "web_service_id" {
  description = "Render web service ID (srv-...). Needed for `terraform import` if adopting the existing hand-built service — see README."
  value       = render_web_service.ship.id
}

output "database_id" {
  description = "Render Postgres instance ID (dpg-...). Needed for `terraform import` if adopting the existing hand-built database — see README."
  value       = render_postgres.ship.id
}

# Deliberately no output for connection_info / DATABASE_URL / session_secret —
# those are sensitive and Terraform would otherwise print them in `terraform
# output` and CLI plan/apply summaries.
