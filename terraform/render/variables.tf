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

# --- Agent service (TRO-316 / FG-11) ----------------------------------------
#
# Target platform: Render, not AWS. This ticket's own brief says "Choose the
# target platform accordingly; do not assume an AWS apply will work" — this
# environment has never had AWS credentials this sprint
# (memory-bank/activeContext.md; re-confirmed working this ticket: `aws` CLI
# absent, no AWS_* env vars). The same memory bank's PM review (2026-08-03,
# TRO-341) independently recommends the identical target: "Render Ship
# (ship-rr6m.onrender.com) + agent + seeded Render Postgres." Reusing this
# existing, provably-plannable Render root — rather than extending the large
# AWS root in `terraform/` — is a deliberate, disclosed deviation from a
# literal reading of "the terraform/ssm.tf / .tfvars.example pattern"; the
# secrets DISCIPLINE (sensitive vars, no defaults, gitignored tfvars, no
# secrets committed) is the same either way, only the storage mechanism
# differs (Render env_vars here vs. AWS SSM Parameter Store there), because
# SSM parameters would only be usable by AWS-hosted compute this service
# doesn't run on.

variable "agent_service_name" {
  description = "Name of the Render web service for the FleetGraph agent."
  type        = string
  default     = "ship-agent"
}

variable "agent_service_plan" {
  description = "Render plan for the agent web service (e.g. free, starter, standard)."
  type        = string
  default     = "free"
}

variable "agent_port" {
  description = "Port the agent's Express server listens on (agent/src/config.ts's PORT, default 3100)."
  type        = number
  default     = 3100
}

variable "agent_dockerfile_path" {
  description = "Path to the agent's Dockerfile, relative to the repo root (docker_context)."
  type        = string
  default     = "./agent/Dockerfile"
}

variable "agent_docker_context" {
  description = "Docker build context for the agent image — the REPO ROOT, not agent/, because pnpm workspace resolution needs pnpm-workspace.yaml and the lockfile (see agent/Dockerfile's header comment)."
  type        = string
  default     = "."
}

variable "agent_health_check_path" {
  description = <<-EOT
    HTTP path Render polls to gate deploy promotion and ongoing liveness for
    the agent service. Render exposes exactly one such path; FG-2's /health
    (process alive) and /ready (Ship reachable + config loaded) are
    deliberately different endpoints Render's single-path model can't fully
    express — this points at /health, consistent with the existing `ship`
    web service above (health_check_path in web_service.tf). /ready stays
    available on the service itself for any caller that wants the
    finer-grained readiness signal (CI, a human, a future orchestrator).
  EOT
  type        = string
  default     = "/health"
}

variable "anthropic_api_key" {
  description = <<-EOT
    Anthropic API key for the agent's model provider (TRO-313's settled
    decision: Anthropic API directly, not Bedrock — no AWS credentials have
    existed in this environment all sprint). Sensitive, no default — supply
    via a gitignored terraform.tfvars or -var, never a literal here.
  EOT
  type        = string
  sensitive   = true
}

variable "langsmith_api_key" {
  description = "LangSmith API key for trace ingestion (TRO-313 / FG-2 — tracing on from the first invocation). Sensitive, no default."
  type        = string
  sensitive   = true
}

variable "langchain_project" {
  description = "LangSmith project name traces are grouped under."
  type        = string
  default     = "fleetgraph-agent"
}

variable "langchain_endpoint" {
  description = "LangSmith API endpoint."
  type        = string
  default     = "https://api.smith.langchain.com"
}

variable "ship_api_token" {
  description = <<-EOT
    Per-user Ship API token the agent runs under. FLEETGRAPH.MD "Deployment
    model": there is no service account — every API token belongs to a real
    user, and the agent runs as them, which is what makes following the
    graph outward from a document to others the person didn't open safe by
    construction. Sensitive, no default.
  EOT
  type        = string
  sensitive   = true
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
