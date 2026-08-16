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

  # TRO-488: same gap CodeRabbit flagged on agent_internal_secret (TRO-347) —
  # an empty or copy-pasted-placeholder value here deploys an agent whose
  # tracing silently no-ops (or, depending on the SDK, fails closed) while
  # `terraform apply` still reports success. `length(trimspace(...)) > 0`
  # rather than `!= ""` so whitespace-only input (a copy-paste artifact) is
  # also caught. Also rejects the literal terraform.tfvars.example
  # placeholder so copying that file unedited fails loudly instead of
  # deploying a value every reader of this repo already knows.
  validation {
    condition = (
      length(trimspace(var.langsmith_api_key)) > 0 &&
      var.langsmith_api_key != "REPLACE_WITH_A_REAL_LANGSMITH_API_KEY"
    )
    error_message = "langsmith_api_key must not be empty (or whitespace-only), and must not be the terraform.tfvars.example placeholder value."
  }
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

  # TRO-488: same gap CodeRabbit flagged on agent_internal_secret (TRO-347) —
  # this token authenticates every agent -> Ship call as a real user
  # (FLEETGRAPH.MD "Deployment model"); an empty or placeholder value here
  # deploys an agent that fails every internal API call while `terraform
  # apply` still reports success. `length(trimspace(...)) > 0` rather than
  # `!= ""` so whitespace-only input is also caught. Also rejects the literal
  # terraform.tfvars.example placeholder.
  validation {
    condition = (
      length(trimspace(var.ship_api_token)) > 0 &&
      var.ship_api_token != "REPLACE_WITH_A_REAL_SHIP_API_TOKEN"
    )
    error_message = "ship_api_token must not be empty (or whitespace-only), and must not be the terraform.tfvars.example placeholder value."
  }
}

# --- Agent/api shared secret + wiring (TRO-347) -----------------------------
#
# PR-D (agent/src/server.ts, api/src/routes/agent.ts — TRO-320/FG-9,
# TRO-323/FG-10) introduced these two env vars on 2026-08-05, but this config
# gained zero references to either at the time (verified by grep). They were
# set live via the Render REST API on both services directly instead — the
# free-tier provider bug documented below `render_web_service.agent` in
# agent_service.tf blocks a plain `terraform apply` for that resource — and
# existed only in Render's own console/API state plus the operator-local
# `~/.ship-agent-internal-secret` (mode 600, correctly never in this repo).
# Consequence: a clean-machine `terraform apply`, or a destroy-and-redeploy
# like FG-11's own proof, recreated the services WITHOUT them, and every
# `/api/agent/*` call then 500'd (`internal_secret_not_configured`). These two
# variables are the fix — see agent_service.tf and web_service.tf for where
# each is consumed.

variable "agent_internal_secret" {
  description = <<-EOT
    Shared secret sent as the `X-Internal-Secret` header on every api/ ->
    agent call (TRO-320/FG-9, TRO-323/FG-10) and required by BOTH sides:
    the agent's own POST /chat and GET /inbox (agent/src/server.ts, via
    agent/src/config.ts's `agentInternalSecret`) check it before either ever
    touches the graph or item store, and api/'s proxy
    (api/src/routes/agent.ts) refuses to even call the agent (503) if its
    own copy is unset. The two sides must hold the IDENTICAL value or the
    agent rejects every call with 401 — consumed here by both
    agent_service.tf (the agent's own copy) and web_service.tf (api's copy).

    Sensitive, deliberately NO DEFAULT: an empty or placeholder default here
    would deploy an agent that fails closed for every legitimate caller
    (500 `internal_secret_not_configured`) while looking like a successful
    `apply` — Terraform must error loudly ("No value for required variable")
    if this isn't supplied, not silently ship a broken secret. Supply a real
    generated value via a gitignored terraform.tfvars or -var — see
    terraform.tfvars.example. The real value currently lives only in Render's
    own env-var config for both services, and in the operator-local
    `~/.ship-agent-internal-secret` (mode 600) — never put it in this repo.
  EOT
  type        = string
  sensitive   = true

  # CodeRabbit (TRO-347 PR review): reject an empty string at plan time
  # rather than deploying an agent that fails closed for every legitimate
  # caller while looking like a successful apply. `length(var....) > 0`
  # rather than `!= ""` so accidental leading/trailing whitespace-only input
  # (e.g. a copy-paste artifact) is caught too. Also rejects the literal
  # terraform.tfvars.example placeholder — copying that file without editing
  # it would otherwise pass this check and deploy a "secret" every reader of
  # this repo already knows.
  validation {
    condition = (
      length(trimspace(var.agent_internal_secret)) > 0 &&
      var.agent_internal_secret != "REPLACE_WITH_A_REAL_SHARED_SECRET"
    )
    error_message = "agent_internal_secret must not be empty (or whitespace-only), and must not be the terraform.tfvars.example placeholder value."
  }
}

variable "agent_api_base_url" {
  description = <<-EOT
    Base URL of the deployed agent service. Consumed only by web_service.tf:
    api/src/routes/agent.ts reads `AGENT_API_BASE_URL` straight from
    `process.env` with a `http://localhost:3100` fallback that is meaningless
    once api/ is running on Render (TRO-347).

    Deliberately NOT derived from `render_web_service.agent.url` the way
    agent_service.tf's own `SHIP_API_BASE_URL` derives the opposite direction
    (agent depends on ship's URL). Having web_service.tf derive this one too
    would make `render_web_service.ship` and `render_web_service.agent` each
    depend on the other's computed `.url` — a two-resource cycle Terraform
    refuses to plan. Same shape of constraint `cors_origin` above documents
    (there it's a same-resource self-reference; here it's a two-resource
    cycle), and the same answer: track it as a plain variable instead of a
    derived value.

    Not secret, but must match the agent service's actual live URL for
    chat/inbox to work at all. Render assigns that URL (a
    `<slug>.onrender.com` suffix) at creation time and it changes on every
    clean-machine apply that recreates the agent service (memory-bank/
    activeContext.md) — this default reproduces the current live agent
    (verified 2026-08-05, FLEETGRAPH.MD "Deployment model"); update it to
    match after any apply that replaces `render_web_service.agent`.
  EOT
  type        = string
  default     = "https://ship-agent-t0zy.onrender.com"
}

# --- Platform env vars (PF-900 / TRO-411) -----------------------------------
#
# Every new env var Week 6's platform layer (api/src/platform/**, not yet
# built as of this ticket — Day-1 infra per PLUGFORGE.MD §2.10/§4 E9) will
# read once PF-101/PF-302/PF-500/PF-701/PF-702/PF-907 land. Names are fixed
# HERE, once, per the PM triage comment on TRO-411 (the test-designer flagged
# the duplicated-literal risk across PF-900/701/907) — those tickets' seed
# code and boot checks must read these exact names from a shared config
# module, never re-declare the literal. No application code reads any of
# these yet; declaring them ahead of the code is deliberate IaC-first
# sequencing — this ticket is explicitly "Start Day 1 — defense material" in
# the PRD, and its AC is "zero console-only config," which requires every one
# of these to exist as a `.tf`-declared env var before the code that reads it
# ships, not after.

variable "secret_encryption_key" {
  description = <<-EOT
    AES-256-GCM key used to encrypt webhook signing secrets at rest (PF-302,
    PLUGFORGE.MD §2.2's signing-secret note — a one-way hash is
    unimplementable here because the server must recompute HMAC signatures,
    so the plaintext secret is encrypted at rest instead). Sensitive, no
    default — supply a real generated value (e.g. `openssl rand -hex 32`)
    via a gitignored terraform.tfvars or -var. Consumed by the `ship` web
    service only (web_service.tf) — the agent never handles webhook secrets.
  EOT
  type        = string
  sensitive   = true

  # TRO-488 (PF-900 follow-up, CodeRabbit on PR #174/TRO-411): same shape as
  # agent_internal_secret's existing validation (TRO-347) — an empty or
  # placeholder value here would encrypt every webhook signing secret with a
  # key everyone reading this repo already knows, while `terraform apply`
  # still reports success. `length(trimspace(...)) > 0` rather than `!= ""`
  # so whitespace-only input is also caught.
  validation {
    condition = (
      length(trimspace(var.secret_encryption_key)) > 0 &&
      var.secret_encryption_key != "REPLACE_WITH_A_REAL_ENCRYPTION_KEY"
    )
    error_message = "secret_encryption_key must not be empty (or whitespace-only), and must not be the terraform.tfvars.example placeholder value."
  }
}

variable "fleetgraph_oauth_client_secret" {
  description = <<-EOT
    OAuth client secret for the first-party `ship_app_fleetgraph` app
    (PF-701). Name fixed by the PM triage comment on TRO-411 (coordinates
    with PF-701's seed, which must read this exact name via a shared config
    module rather than a re-declared literal). Consumed by BOTH services:
    the `ship` web service hashes and stores it when seeding the
    `oauth_apps` row (PF-701's idempotent boot/migration seed), and the
    agent service holds the plaintext to authenticate itself via the Client
    Credentials grant once PF-702 switches AGENT_PLATFORM_MODE to `sdk` —
    the two sides must hold the identical value or the agent's own token
    requests fail closed, the same shape as `agent_internal_secret` above.
    Sensitive, no default — generate fresh per environment
    (`openssl rand -hex 32`), never reuse a value across environments.
  EOT
  type        = string
  sensitive   = true

  # TRO-488 (PF-900 follow-up, CodeRabbit on PR #174/TRO-411): same shape as
  # agent_internal_secret's existing validation (TRO-347) — an empty or
  # placeholder value here means `ship`'s PF-701 seed hashes a secret every
  # reader of this repo already knows, and the agent's own Client
  # Credentials grant (once PF-702 flips AGENT_PLATFORM_MODE to `sdk`) fails
  # closed against the mismatched hash, while `terraform apply` still
  # reports success. `length(trimspace(...)) > 0` rather than `!= ""` so
  # whitespace-only input is also caught.
  validation {
    condition = (
      length(trimspace(var.fleetgraph_oauth_client_secret)) > 0 &&
      var.fleetgraph_oauth_client_secret != "REPLACE_WITH_A_REAL_FLEETGRAPH_CLIENT_SECRET"
    )
    error_message = "fleetgraph_oauth_client_secret must not be empty (or whitespace-only), and must not be the terraform.tfvars.example placeholder value."
  }
}

variable "grader_oauth_client_secret" {
  description = <<-EOT
    OAuth client secret for the seeded read-only grader app (PF-907). Name
    fixed by the PM triage comment on TRO-411 (coordinates with PF-907's
    seed, which must read this exact name via the same shared config module
    as `fleetgraph_oauth_client_secret` — never a re-declared literal).
    Consumed by the `ship` web service only — PF-907's seed hashes and
    stores it when creating the grader's `oauth_apps` row; the agent has no
    reason to hold the grader's identity. Sensitive, no default — generate
    fresh (`openssl rand -hex 32`), never reuse `fleetgraph_oauth_client_secret`'s
    value here.
  EOT
  type        = string
  sensitive   = true

  # TRO-488 (PF-900 follow-up, CodeRabbit on PR #174/TRO-411): same shape as
  # agent_internal_secret's existing validation (TRO-347) — an empty or
  # placeholder value here means PF-907's seed hashes a grader-app secret
  # every reader of this repo already knows, while `terraform apply` still
  # reports success. `length(trimspace(...)) > 0` rather than `!= ""` so
  # whitespace-only input is also caught.
  validation {
    condition = (
      length(trimspace(var.grader_oauth_client_secret)) > 0 &&
      var.grader_oauth_client_secret != "REPLACE_WITH_A_REAL_GRADER_CLIENT_SECRET"
    )
    error_message = "grader_oauth_client_secret must not be empty (or whitespace-only), and must not be the terraform.tfvars.example placeholder value."
  }
}

variable "oauth_access_token_ttl_seconds" {
  description = <<-EOT
    OAuth access token lifetime in seconds, read by PF-104/PF-105's token
    issuance path once built. Not secret. Default 3600 (1 hour) matches
    PLUGFORGE.MD §2.2's "Token TTLs: access 1 hour" exactly — declaring this
    as a Terraform variable (rather than only a hardcoded constant in
    application code) is what makes it environment-configurable without a
    code change, per this ticket's "zero console-only config" AC. The
    auth-code TTL (10 minutes, single-use, §2.2) is deliberately NOT exposed
    as a variable: it is a fixed security invariant in the PRD, not an
    operational knob, so making it env-configurable would be scope creep
    past what §2.10 actually asks for ("OAuth TTL config").
  EOT
  type        = number
  default     = 3600

  # TRO-488: `tostring()` (web_service.tf) accepts any number, including 0,
  # negative, or fractional seconds — none of which PF-104/PF-105's future
  # token issuance path can treat as a sane TTL. Same
  # positive-integer shape as the other three PF-900 numeric vars below.
  validation {
    condition     = var.oauth_access_token_ttl_seconds > 0 && var.oauth_access_token_ttl_seconds == floor(var.oauth_access_token_ttl_seconds)
    error_message = "oauth_access_token_ttl_seconds must be a positive whole number of seconds."
  }
}

variable "oauth_refresh_token_ttl_seconds" {
  description = <<-EOT
    OAuth refresh token lifetime in seconds, read by PF-105's rotation path
    once built. Not secret. Default 2592000 (30 days) matches
    PLUGFORGE.MD §2.2's "refresh 30 days" exactly.
  EOT
  type        = number
  default     = 2592000

  # TRO-488: same shape as oauth_access_token_ttl_seconds above.
  validation {
    condition     = var.oauth_refresh_token_ttl_seconds > 0 && var.oauth_refresh_token_ttl_seconds == floor(var.oauth_refresh_token_ttl_seconds)
    error_message = "oauth_refresh_token_ttl_seconds must be a positive whole number of seconds."
  }
}

variable "rate_limit_app_rpm" {
  description = <<-EOT
    Per-app token-bucket ceiling for `/api/v1`, requests per minute, read by
    PF-500 once built. Not secret. Default 120 matches PLUGFORGE.MD §2.7
    exactly. This is a distinct config surface from the legacy `/api/`
    limiters (api/src/middleware/rate-limit.ts, hardcoded per-NODE_ENV
    tiers today, no env knob) — PF-004 exempts `/api/v1` from those legacy
    limiters before this bucket exists, so the two never stack.
  EOT
  type        = number
  default     = 120

  # TRO-488: a zero, negative, or fractional RPM ceiling is not a valid
  # token-bucket rate — same positive-integer shape as the TTL vars above.
  validation {
    condition     = var.rate_limit_app_rpm > 0 && var.rate_limit_app_rpm == floor(var.rate_limit_app_rpm)
    error_message = "rate_limit_app_rpm must be a positive whole number (requests per minute)."
  }
}

variable "rate_limit_token_rpm" {
  description = <<-EOT
    Per-token token-bucket ceiling for `/api/v1`, requests per minute, read
    by PF-500 once built. Not secret. Default 60 matches PLUGFORGE.MD §2.7
    exactly.
  EOT
  type        = number
  default     = 60

  # TRO-488: same shape as rate_limit_app_rpm above.
  validation {
    condition     = var.rate_limit_token_rpm > 0 && var.rate_limit_token_rpm == floor(var.rate_limit_token_rpm)
    error_message = "rate_limit_token_rpm must be a positive whole number (requests per minute)."
  }
}

variable "agent_platform_mode" {
  description = <<-EOT
    PF-702's flag: `internal` (default — current behavior, the agent reads
    Ship via agent/src/shipClient.ts's direct internal-API calls) or `sdk`
    (reads via @ship/sdk as the app-identity OAuth principal). Not secret.
    Consumed by the agent service only (agent_service.tf) — this is exactly
    what PF-704's flag matrix exercises in both positions. Defaulting to
    `internal` means a `terraform apply` alone never silently flips agent
    behavior; PF-702 switches this deliberately once the SDK read path is
    gated green in both modes.
  EOT
  type        = string
  default     = "internal"

  validation {
    condition     = contains(["internal", "sdk"], var.agent_platform_mode)
    error_message = "agent_platform_mode must be exactly \"internal\" or \"sdk\" (PLUGFORGE.MD PF-702)."
  }
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
