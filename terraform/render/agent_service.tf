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
  lifecycle {
    ignore_changes = [
      notification_override,
      previews,
      pull_request_previews_enabled,
      root_directory,
      runtime_source.docker.auto_deploy_trigger,
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
  }
}
