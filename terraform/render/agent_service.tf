# Render-managed web service for the FleetGraph agent (TRO-316 / FG-11).
#
# See variables.tf's "Agent service" section header comment for the target-
# platform decision (Render, not AWS) and why it deviates from a literal
# reading of "the terraform/ssm.tf pattern."
#
# Deployed in THIS SAME Render root as the `ship` web service
# (web_service.tf) — one provider block, one state, one `terraform plan` —
# rather than a second Terraform root. `scripts/check-single-tf-root.sh`'s
# guard is AWS-specific (`provider "aws" {`) and does not apply here; see
# README.md's "Why this directory is inside terraform/" for the full
# reasoning, which is identical for this file.
resource "render_web_service" "agent" {
  name           = var.agent_service_name
  plan           = var.agent_service_plan
  region         = var.region
  environment_id = var.environment_id

  runtime_source = {
    docker = {
      repo_url        = var.repo_url
      branch          = var.git_branch
      dockerfile_path = var.agent_dockerfile_path
      context         = var.agent_docker_context
      auto_deploy     = true
    }
  }

  # Same rationale as render_web_service.ship in web_service.tf: these are
  # Render-assigned/computed fields this config deliberately does not manage.
  #
  # maintenance_mode and pull_request_previews_enabled added 2026-08-04
  # (TRO-341/FG-23): a plain env_vars-only update against this free-tier
  # service failed with "Error updating service ... maintenance mode can
  # only be configured for non-free tier services" — the provider re-sends
  # this computed field's current value (enabled=false) on every update
  # regardless of whether it changed, and Render's API rejects that field
  # existing in the payload at all for a free-tier service. web_service.tf
  # already carries pull_request_previews_enabled in its own ignore_changes
  # for the identical drift reason (see its "Warning: Deprecated attribute"
  # on every plan) — agent_service.tf just hadn't hit an update yet to
  # surface the gap.
  lifecycle {
    ignore_changes = [
      notification_override,
      previews,
      pull_request_previews_enabled,
      root_directory,
      runtime_source.docker.auto_deploy_trigger,
      maintenance_mode,
    ]
  }

  health_check_path = var.agent_health_check_path

  env_vars = {
    PORT     = { value = tostring(var.agent_port) }
    NODE_ENV = { value = "production" }

    # Derived from the `ship` web service resource this same root manages —
    # never a literal — so a redeploy of `ship` (a fresh generated slug on a
    # clean-machine apply; see web_service.tf's `cors_origin` doc comment for
    # the identical caveat) does not silently strand this value.
    SHIP_API_BASE_URL = { value = render_web_service.ship.url }
    # Sensitive input — see variables.tf. Per-user token, not a service
    # account (FLEETGRAPH.MD "Deployment model").
    SHIP_API_TOKEN = { value = var.ship_api_token }

    # Model provider: Anthropic API directly (TRO-313's settled decision).
    # Sensitive input, never a literal.
    ANTHROPIC_API_KEY = { value = var.anthropic_api_key }

    # LangSmith tracing on from the first invocation (TRO-313 / FG-2).
    LANGCHAIN_TRACING_V2 = { value = "true" }
    LANGCHAIN_PROJECT    = { value = var.langchain_project }
    LANGCHAIN_ENDPOINT   = { value = var.langchain_endpoint }
    LANGSMITH_API_KEY    = { value = var.langsmith_api_key }

    # Shared secret the agent's own POST /chat and GET /inbox check on every
    # request before either touches the graph or item store (agent/src/
    # server.ts, via agent/src/config.ts's agentInternalSecret) — must match
    # web_service.tf's copy of the same variable exactly, or every call from
    # api/ gets rejected with 401. TRO-347: previously set only via the
    # Render REST API (see this resource's lifecycle.ignore_changes comment
    # above for why `terraform apply` can't reach this resource on the free
    # tier) — never declared here, so a clean-machine apply silently deployed
    # this service without it. Sensitive input, never a literal — see
    # variables.tf.
    AGENT_INTERNAL_SECRET = { value = var.agent_internal_secret }
  }
}
