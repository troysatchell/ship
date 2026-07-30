terraform {
  required_version = ">= 1.9.0"

  required_providers {
    render = {
      source = "render-oss/render"
      # Exact pin, not a `~>` range: verified as the latest stable release on
      # the public registry on 2026-07-30 (registry.terraform.io/v1/providers/render-oss/render).
      version = "1.9.1"
    }
  }
}

# Credentials are never literals here. `api_key` is a sensitive variable that
# defaults to null; when null, the provider itself falls back to the
# RENDER_API_KEY environment variable (documented behavior — see
# https://registry.terraform.io/providers/render-oss/render/latest/docs).
# The intended workflow is `set -a; source .env; set +a` before any
# `terraform` command, so the key is never written to a .tf/.tfvars file or a
# shell history entry with the value inline.
provider "render" {
  api_key  = var.render_api_key
  owner_id = var.render_owner_id
}
