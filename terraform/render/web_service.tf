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

  # The live service sits in a Render environment (project grouping). Omitting
  # this made the post-import plan propose detaching it (environment_id ->
  # null) — declared so the plan is honest about membership.
  environment_id = var.environment_id

  runtime_source = {
    docker = {
      repo_url        = var.repo_url
      branch          = var.git_branch
      dockerfile_path = var.dockerfile_path
      context         = var.docker_context
      auto_deploy     = true
    }
  }

  # Render assigns these itself (or computes them post-apply); the config
  # deliberately does not manage them. Without this, every plan after import
  # shows "(known after apply)" churn on fields no one here sets.
  lifecycle {
    ignore_changes = [
      notification_override,
      previews,
      pull_request_previews_enabled,
      root_directory,
      runtime_source.docker.auto_deploy_trigger,
    ]
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

    # Agent proxy wiring (TRO-320/FG-9, TRO-323/FG-10; added to this config
    # by TRO-347). api/src/routes/agent.ts forwards browser-authenticated
    # requests to the agent service at this base URL, over a shared-secret
    # X-Internal-Secret call — the browser never talks to the agent service
    # directly. Both vars were previously live only in Render's own env-var
    # config and the operator-local `~/.ship-agent-internal-secret`; a
    # clean-machine apply recreated this service without them and every
    # /api/agent/* call 500'd. See variables.tf for why AGENT_API_BASE_URL is
    # a plain var rather than derived from render_web_service.agent.url
    # (would create a two-resource dependency cycle with agent_service.tf's
    # own SHIP_API_BASE_URL).
    AGENT_API_BASE_URL = {
      value = var.agent_api_base_url
    }
    # Sensitive input — see variables.tf. Must match agent_service.tf's copy
    # of the same variable exactly.
    AGENT_INTERNAL_SECRET = {
      value = var.agent_internal_secret
    }
  }
}
