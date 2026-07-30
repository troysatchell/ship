# Render-managed PostgreSQL instance for the ship-api web service.
#
# Mirrors the hand-built `ship-db` (dpg-d9kgth6417fc7386hhh0-a) verified live
# on 2026-07-30: oregon region, pg16, free plan. `ip_allow_list` is left unset
# deliberately — the provider's documented default for render_postgres is
# "no IP addresses provided => only connections via the private network are
# allowed", which is exactly the live instance's verified internal-only
# posture (no workstation/public access).
resource "render_postgres" "ship" {
  name    = var.database_service_name
  plan    = var.database_plan
  region  = var.region
  version = var.database_version

  database_name = var.database_name
  database_user = var.database_user
}
