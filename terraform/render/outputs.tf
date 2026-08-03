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

# --- Agent service (TRO-316 / FG-11) -----------------------------------------

output "agent_service_url" {
  description = "Public URL of the deployed FleetGraph agent service — this is what /health and /ready are reachable at."
  value       = render_web_service.agent.url
}

output "agent_service_id" {
  description = "Render web service ID (srv-...) for the agent. Needed for `terraform import` if ever adopting a hand-built instance."
  value       = render_web_service.agent.id
}

# Deliberately no output for anthropic_api_key / langsmith_api_key /
# ship_api_token — same reasoning as above: sensitive, never printed.
