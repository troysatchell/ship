# Inputs for the Render-provider deployment (TRO-299 / TF-10).
#
# Defaults on the non-secret variables reproduce the hand-built service
# recorded in `memory-bank/techContext.md` and verified live against the
# Render API on 2026-07-30 (see `terraform/render/README.md` for what was
# verified vs. taken on record). Overriding any default (e.g. `service_name`)
# points this config at a brand-new, separate Render service rather than the
# existing one — nothing here is wired to the existing resource IDs, since
# this deliverable is plan-only (see README's adoption memo).

# --- Secrets: sensitive variables, never literals -----------------------

variable "render_api_key" {
  description = <<-EOT
    Render API key used to authenticate the provider. Sensitive — never give
    this a real default. Leave unset and export RENDER_API_KEY in the process
    environment instead (`set -a; source .env; set +a`); the provider reads
    that variable automatically when this input is null. Only set this via
    -var/tfvars if you specifically need to override the environment, and
    never put the real value in a committed file.
  EOT
  type        = string
  sensitive   = true
  default     = null
}

variable "session_secret" {
  description = <<-EOT
    Value for the API's SESSION_SECRET env var (signs Express session
    cookies). Sensitive, no default — supply a real secret via a gitignored
    terraform.tfvars or -var at plan/apply time. Rotating this logs out every
    active session (see audit/terraform/baseline.md TF-6 for the equivalent
    AWS-side blast-radius note).
  EOT
  type        = string
  sensitive   = true
}

# --- Identity / non-secret configuration ---------------------------------

variable "render_owner_id" {
  description = <<-EOT
    Render user or team ID that owns the managed resources (starts `tea-`
    for a team, `usr-` for an individual). Not secret — safe to commit, per
    memory-bank/techContext.md. Default is the verified owner of the live
    `ship` service/`ship-db` database.
  EOT
  type        = string
  default     = "tea-d9kevetg1s2s73807n5g"
}

variable "region" {
  description = "Render region for both the web service and the database. Must match between them for internal (private-network) connectivity."
  type        = string
  default     = "oregon"
}

# --- Web service -----------------------------------------------------------

variable "service_name" {
  description = "Name of the Render web service."
  type        = string
  default     = "ship"
}

variable "service_plan" {
  description = "Render plan for the web service (e.g. free, starter, standard)."
  type        = string
  default     = "free"
}

variable "repo_url" {
  description = "Git repository Render builds and deploys from."
  type        = string
  default     = "https://github.com/troysatchell/ship"
}

variable "git_branch" {
  description = "Branch Render auto-deploys on push."
  type        = string
  default     = "main"
}

variable "dockerfile_path" {
  description = "Path to the Dockerfile, relative to the repo root. This service's runtime is docker: Render's build/start command fields are unused, and the Dockerfile governs (see memory-bank/techContext.md)."
  type        = string
  default     = "./Dockerfile"
}

variable "docker_context" {
  description = "Docker build context directory, relative to the repo root."
  type        = string
  default     = "."
}

variable "health_check_path" {
  description = "HTTP path Render polls to consider a deploy healthy (api/src/app.ts's /health route)."
  type        = string
  default     = "/health"
}

variable "cors_origin" {
  description = <<-EOT
    Value for the API's CORS_ORIGIN env var. Not secret, but must match the
    web service's actual public URL for the app to work — Render assigns
    that URL (a `<slug>.onrender.com` suffix) at creation time, so this
    cannot be derived from the web service resource itself without a
    dependency cycle. The default reproduces the existing live service's URL;
    a clean-machine `apply` gets a *different* generated slug and this
    variable must be updated to match afterward (see README adoption memo).
  EOT
  type        = string
  default     = "https://ship-rr6m.onrender.com"
}

# --- Postgres ----------------------------------------------------------------

variable "database_service_name" {
  description = "Name of the Render Postgres instance."
  type        = string
  default     = "ship-db"
}

variable "database_plan" {
  description = "Render plan for the Postgres instance (e.g. free, basic_256mb, pro_4gb)."
  type        = string
  default     = "free"
}

variable "database_version" {
  description = "Postgres major version."
  type        = string
  default     = "16"
}

variable "database_name" {
  description = <<-EOT
    Name of the database inside the Postgres instance. Not secret. The default
    matches the LIVE, imported instance's auto-suffixed name (`ship_34oc`),
    which Render generated at dashboard-creation time. This field forces
    REPLACEMENT (destroy + recreate = data loss) if it differs from the live
    value, so after the 2026-07-30 import the default was reconciled to
    reality. A fresh clean-machine deployment may override this with any name.
  EOT
  type        = string
  default     = "ship_34oc"
}

variable "environment_id" {
  description = <<-EOT
    Render environment (project grouping) the web service belongs to. Not
    secret. Default is the live service's verified environment; a fresh
    deployment on a clean machine may set this to another environment id or
    null (no grouping).
  EOT
  type        = string
  default     = "evm-d9kf2t7avr4c73asbmig"
}

variable "database_user" {
  description = "Name of the database user inside the Postgres instance."
  type        = string
  default     = "ship"
}
