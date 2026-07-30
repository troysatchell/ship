# Render-managed web service running the Ship API + frontend (docker runtime).
#
# Mirrors the hand-built `ship` service (srv-d9kf2t942hec73aofrt0) verified
# live on 2026-07-30: oregon region, docker runtime from this repo's
# Dockerfile, free plan, health check /health, URL
# https://ship-rr6m.onrender.com. `ip_allow_list` is left unset deliberately —
# it's a public-facing web service and the provider's documented default
# (0.0.0.0/0, allow all) matches the live service's verified setting.
resource "render_web_service" "ship" {
  name   = var.service_name
  plan   = var.service_plan
  region = var.region

  runtime_source = {
    docker = {
      repo_url        = var.repo_url
      branch          = var.git_branch
      dockerfile_path = var.dockerfile_path
      context         = var.docker_context
      auto_deploy     = true
    }
  }

  health_check_path = var.health_check_path

  env_vars = {
    # Derived from the database resource's own computed attribute — never a
    # literal connection string. Internal (not external) because both
    # resources share `var.region`; the existing live service is verified to
    # be configured the same way (an internal DATABASE_URL, no TLS needed).
    DATABASE_URL = {
      value = render_postgres.ship.connection_info.internal_connection_string
    }
    # Sensitive input variable — see variables.tf. Never a literal.
    SESSION_SECRET = {
      value = var.session_secret
    }
    CORS_ORIGIN = {
      value = var.cors_origin
    }
  }
}
