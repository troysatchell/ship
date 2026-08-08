# Captured `terraform plan` — the FleetGraph agent service (TRO-316 / FG-11)

**Date:** 2026-08-03 · **Terraform:** `1.9.8` (darwin_arm64, temp-downloaded into the session
scratchpad, not committed — same methodology as TF-10's `plan-annotated.md` in this same directory
and `audit/terraform/baseline.md`). **Provider:** `render-oss/render` `1.9.1`, resolved via
`terraform init` against the pinned `required_providers` block (`terraform/render/versions.tf`).

**Target platform: Render, not AWS.** This ticket's own text says "Choose the target platform
accordingly; do not assume an AWS apply will work" — no AWS credentials have existed in this
environment all sprint (`memory-bank/activeContext.md`, re-confirmed while working this ticket:
no `aws` CLI, no `AWS_*` env vars). `memory-bank/activeContext.md`'s PM review (2026-08-03,
TRO-341) independently names the identical target: "Render Ship (`ship-rr6m.onrender.com`) + agent
+ seeded Render Postgres." Extended this existing, provably-plannable `terraform/render/` root
(new file `agent_service.tf`) rather than the AWS root in `terraform/` or a second Terraform
root — see `README.md`'s "Why this directory is inside `terraform/`" for why that guard doesn't
apply here either.

**Deviation from the literal dispatch brief, disclosed:** the brief named "secrets via the
existing `terraform/ssm.tf` / `.tfvars.example` pattern." `ssm.tf` is AWS SSM Parameter Store,
usable only by AWS-hosted compute — this service doesn't run on AWS compute, so SSM parameters
would be unreachable secrets. The **discipline** ssm.tf models — sensitive variables, no
defaults, a gitignored `terraform.tfvars`, no secrets committed — is followed exactly; only the
storage mechanism differs (Render `env_vars` here, matching `web_service.tf`'s own existing
pattern for `SESSION_SECRET` one file over).

## Commands run, in order

```bash
cd terraform/render
terraform fmt -check -recursive .        # exit 0, no changes needed
terraform init                            # installs render-oss/render 1.9.1 from lock file
terraform validate                        # "Success!" — 2 pre-existing deprecation warnings,
                                           # identical pattern already present in web_service.tf's
                                           # own ignore_changes list, not introduced by this file
terraform plan -var-file=<tfvars>         # see two captures below
```

## Capture 1 — `RENDER_API_KEY` unset (this environment's actual, unmodified state)

**Observed, not derived.** This agent was staged with `ANTHROPIC_API_KEY` / `LANGSMITH_API_KEY`
(for FG-2's required trace-link proof) but no infrastructure credentials — consistent with the
"no `terraform apply`" hard stop in this bundle's brief. Every other required variable (all with
no default: `session_secret`, `anthropic_api_key`, `langsmith_api_key`, `ship_api_token`) was
supplied via a scratchpad-only `.tfvars` file with placeholder values, never committed.

```text
Planning failed. Terraform encountered an error while generating this plan.

╷
│ Warning: Deprecated attribute
│
│   on agent_service.tf line 35, in resource "render_web_service" "agent":
│   35:       pull_request_previews_enabled,
│
│ The attribute "pull_request_previews_enabled" is deprecated. Refer to the
│ provider documentation for details.
│
│ (and one more similar warning elsewhere)
╵
╷
│ Error: Missing Render API Key
│
│   with provider["registry.terraform.io/render-oss/render"],
│   on versions.tf line 22, in provider "render":
│   22:   api_key  = var.render_api_key
│
│ The provider cannot create the Render API Client as there is a missing or
│ empty value for the Render API Key. Set the host value in the configuration
│ or use the RENDER_API_KEY environment variable. If either is already set,
│ ensure the value is not empty.
╵
```

**What this proves:** the provider requires a non-empty `RENDER_API_KEY` before it will even
attempt to build a plan. It does **not** by itself tell us whether the *configuration* is
structurally sound — capture 2 answers that.

## Capture 2 — a non-empty placeholder `RENDER_API_KEY` (still not a real credential)

Re-ran with `RENDER_API_KEY=placeholder-not-a-real-render-api-key` (an arbitrary non-empty
string, not a genuine key) to isolate "does the config itself resolve" from "is the key real."
**Result: the plan completed in full**, because every resource here is a brand-new `create` against
this root's genuinely empty state (no prior `terraform apply`/`import` has ever run against it —
see `README.md`'s own "Adoption memo," unchanged by this ticket) and the config contains no `data`
source or other construct that requires an authenticated API round-trip merely to *plan*. Real
authentication only happens at `apply`, when Terraform actually calls the Render API to create
each resource — which this run deliberately did not do.

**Redaction check performed** before writing this file: grepped the raw captured output for
`placeholder` (the dummy values used), `rnd_` (Render's real key prefix), and
`bearer`/`authorization` (case-insensitive). **None matched** — every `env_vars` entry and
`connection_info` render as the literal string `(sensitive value)`, which is Terraform's own
renderer honoring the provider schema's `Sensitive` marking, not a manual redaction. ANSI color
codes stripped for readability; otherwise unedited.

```text
Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # render_postgres.ship will be created
  + resource "render_postgres" "ship" {
      + connection_info           = (sensitive value)
      + database_name             = "ship_34oc"
      + database_user             = "ship"
      + disk_size_gb              = (known after apply)
      + high_availability_enabled = (known after apply)
      + id                        = (known after apply)
      + ip_allow_list             = (known after apply)
      + log_stream_override       = (known after apply)
      + name                      = "ship-db"
      + plan                      = "free"
      + primary_postgres_id       = (known after apply)
      + region                    = "oregon"
      + role                      = (known after apply)
      + version                   = "16"
    }

  # render_web_service.agent will be created
  + resource "render_web_service" "agent" {
      + active_custom_domains         = (known after apply)
      + env_vars                      = {
          + "ANTHROPIC_API_KEY" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "LANGCHAIN_ENDPOINT" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "LANGCHAIN_PROJECT" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "LANGCHAIN_TRACING_V2" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "LANGSMITH_API_KEY" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "NODE_ENV" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "PORT" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "SHIP_API_BASE_URL" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "SHIP_API_TOKEN" = {
              + generate_value = false
              + value          = (sensitive value)
            },
        }
      + environment_id                = "evm-d9kf2t7avr4c73asbmig"
      + health_check_path             = "/health"
      + id                            = (known after apply)
      + log_stream_override           = (known after apply)
      + maintenance_mode              = {
          + enabled = false
          + uri     = ""
        }
      + max_shutdown_delay_seconds    = (known after apply)
      + name                          = "ship-agent"
      + notification_override         = (known after apply)
      + num_instances                 = (known after apply)
      + plan                          = "free"
      + previews                      = (known after apply)
      + pull_request_previews_enabled = (known after apply)
      + region                        = "oregon"
      + root_directory                = (known after apply)
      + runtime_source                = {
          + docker = {
              + auto_deploy         = true
              + auto_deploy_trigger = (known after apply)
              + branch              = "main"
              + context             = "."
              + dockerfile_path     = "./agent/Dockerfile"
              + repo_url            = "https://github.com/troysatchell/ship"
            }
        }
      + slug                          = (known after apply)
      + url                           = (known after apply)
    }

  # render_web_service.ship will be created
  + resource "render_web_service" "ship" {
      + active_custom_domains         = (known after apply)
      + env_vars                      = {
          + "CORS_ORIGIN" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "DATABASE_URL" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "SESSION_SECRET" = {
              + generate_value = false
              + value          = (sensitive value)
            },
        }
      + environment_id                = "evm-d9kf2t7avr4c73asbmig"
      + health_check_path             = "/health"
      + id                            = (known after apply)
      + log_stream_override           = (known after apply)
      + maintenance_mode              = {
          + enabled = false
          + uri     = ""
        }
      + max_shutdown_delay_seconds    = (known after apply)
      + name                          = "ship"
      + notification_override         = (known after apply)
      + num_instances                 = (known after apply)
      + plan                          = "free"
      + previews                      = (known after apply)
      + pull_request_previews_enabled = (known after apply)
      + region                        = "oregon"
      + root_directory                = (known after apply)
      + runtime_source                = {
          + docker = {
              + auto_deploy         = true
              + auto_deploy_trigger = (known after apply)
              + branch              = "main"
              + context             = "."
              + dockerfile_path     = "./Dockerfile"
              + repo_url            = "https://github.com/troysatchell/ship"
            }
        }
      + slug                          = (known after apply)
      + url                           = (known after apply)
    }

Plan: 3 to add, 0 to change, 0 to destroy.

Changes to Outputs:
  + agent_service_id  = (known after apply)
  + agent_service_url = (known after apply)
  + database_id       = (known after apply)
  + web_service_id    = (known after apply)
  + web_service_url   = (known after apply)
╷
│ Warning: Deprecated attribute
│
│   on agent_service.tf line 35, in resource "render_web_service" "agent":
│   35:       pull_request_previews_enabled,
│
│ The attribute "pull_request_previews_enabled" is deprecated. Refer to the
│ provider documentation for details.
│
│ (and one more similar warning elsewhere)
╵
```

## Reading this plan

- **`render_web_service.agent` (new, this ticket):** exactly the resource FG-11 asks for — Docker
  compute, `health_check_path = "/health"`, all nine env vars present and marked sensitive
  (`ANTHROPIC_API_KEY`, `SHIP_API_TOKEN`, `LANGSMITH_API_KEY` etc. never appear as literals — see
  `agent_service.tf`), `dockerfile_path = "./agent/Dockerfile"` / `context = "."` matching the
  Dockerfile this ticket also added and **build-and-ran successfully in this session** (see below).
- **`render_postgres.ship` and `render_web_service.ship` also proposed for creation:** this is
  the **pre-existing, already-documented adoption gap**, not something this ticket introduced or
  is responsible for fixing. `README.md`'s own "Adoption memo — import vs. clean-machine apply"
  section (written 2026-07-30, TF-10) already states this root's state is empty because neither
  `import` nor a first `apply` has ever run against it, and explicitly defers the import/apply
  decision to a human (escalation gate 2) — unchanged by this session. TRO-326's own brief names
  the identical situation as a "known gap carried from Week 4."

## Annotation — one sentence per resource

Capture 1 (missing `RENDER_API_KEY`) produced **zero resources** — Terraform errored during
provider setup, before it reached the point of building a resource graph, so there is nothing to
annotate for that capture; the table below covers Capture 2, the one capture that actually
produced a plan.

| Resource | Action | What it is | Blast radius | Safe or risky |
|---|---|---|---|---|
| `render_postgres.ship` | **create** | A new, empty Render Postgres 16 instance (free plan, oregon; `database_name = "ship_34oc"` in this capture) — proposed again here for the same reason `plan-annotated.md` (TF-10) first documented: this capture's Terraform state has no record of the already-imported live `ship-db` (`dpg-d9kgth6417fc7386hhh0-a`, see `IMPORT-LOG.md`). This ticket did not cause that gap and does not resolve it. | If actually applied against a state in this condition, it stands up a **second, empty, unseeded** database next to the real one — no destructive effect on the live `ship-db`'s existing data. The real risk is downstream: anyone who later points the app's `DATABASE_URL` at this new instance instead of the real one would see Ship come up with **zero** documents/issues/wiki content — a full-looking data-loss incident that is actually a wrong-database mistake, not data actually being deleted. | **Safe as a plan** (nothing created by planning); **risky to apply** without first resolving which state/adoption path is authoritative — see `README.md`'s adoption memo. |
| `render_web_service.agent` | **create** | The FleetGraph agent's own Render web service (FG-11) — Docker compute on the free plan, `health_check_path = "/health"`, `dockerfile_path = "./agent/Dockerfile"`, nine sensitive env vars (`ANTHROPIC_API_KEY`, `SHIP_API_TOKEN`, `LANGSMITH_API_KEY`, etc.), attached to `environment_id = "evm-d9kf2t7avr4c73asbmig"`. | A pure addition — nothing else in this config or the live infrastructure references it yet, so applying it can only create a new, isolated service. The agent is stateless (calls out to Ship's API and Anthropic/LangSmith, holds no data of its own per FG-2/FG-4), so if it is later destroyed the only loss is the agent's own runtime availability, not any stored data. `tro-316-destroy-redeploy-proof.md` in this same directory **verified live** that destroying and recreating it does not touch `render_web_service.ship`/`render_postgres.ship`. | **Safe** — verified in practice, not just planned (see the destroy-redeploy proof). |
| `render_web_service.ship` | **create** | The main Ship web app service — again proposed as a fresh create in this capture for the identical state-gap reason as `render_postgres.ship` above, not a change this ticket is making. In reality this fronts the live, in-use `ship-rr6m.onrender.com` application. | If a `create` plan like this one were ever applied against a state that genuinely lacks the import, it stands up a second, empty-config web service rather than modifying the real one. The higher-stakes case is the inverse: if a *future* apply runs against a state where the real service **is** imported (as `post-import-plan-no-changes.txt` shows it currently is) and the config has since drifted — a changed `dockerfile_path`, `branch`, or `env_vars` key — Render would perform an in-place update or a forced replace of the **live** app: a redeploy/restart at minimum (dropping in-flight requests), or, on forced replace, a brand-new URL that leaves the old one dark. | **Not safe to blindly apply** without first confirming which state/adoption path is active — same caveat as `render_postgres.ship`, see `README.md`'s adoption memo. |

## What this plan does and does NOT establish

**Established (observed):**
- The Terraform config for the agent service is syntactically and semantically valid
  (`terraform validate`: Success) and formatted per `terraform fmt`.
- It resolves into a complete, correct 3-resource plan once *any* non-empty `RENDER_API_KEY` is
  present — the config itself is not the blocker.
- Every secret-shaped value (`ANTHROPIC_API_KEY`, `LANGSMITH_API_KEY`, `SHIP_API_TOKEN`,
  `SESSION_SECRET`, `DATABASE_URL`) renders as `(sensitive value)`, never a literal, in both the
  plan output and (per `outputs.tf`) `terraform output`.
- **The Dockerfile the plan references actually builds and runs correctly** — `docker build -f
  agent/Dockerfile .` from the repo root succeeded end to end in this session, and the resulting
  container, run with `-p 13100:3100`, served `GET /health` → `200 {"status":"ok"}` and
  `GET /ready` → `503 {"status":"not_ready","reason":"config_incomplete"}` (no Ship/Anthropic
  config supplied to the container) — exactly the behavior FG-2 and FG-4 specify, running inside
  the actual image Render would build from this same `dockerfile_path`/`docker_context`.

**NOT established (this agent was not given the credential to check further):**
- Whether a **real** `RENDER_API_KEY` authenticates successfully against Render's live API —
  capture 1 above proves the provider demands a real-looking key; capture 2 proves the config
  doesn't need one *to plan*, but `apply`'s actual `POST` calls to Render were never attempted.
- Whether the real `apply` succeeds, what URL Render assigns the new `ship-agent` service, or
  whether `render_web_service.ship`/`render_postgres.ship` being proposed as fresh creates
  (rather than imports of the already-live hand-built resources) is the outcome a human wants —
  that decision was already flagged "HOLD FOR HUMAN" in TF-10's own README and remains so.
- The destroy-and-redeploy proof FG-11 ultimately requires. Explicitly out of scope for this PR
  per the dispatch brief's hard stop — pending human confirmation, same as `terraform apply`
  itself.

## What a human needs to finish this

1. A real `RENDER_API_KEY` (`export RENDER_API_KEY=...` or the repo-root `.env` pattern
   `web_service.tf`/`versions.tf` already document).
2. A decision on the pre-existing `ship`/`ship-db` adoption gap (import the live hand-built
   resources vs. accept a parallel create) — unrelated to the agent addition itself, but it will
   appear in the same `apply` unless resolved first. TF-10's README's "Option A" (import) is the
   existing recommendation.
3. Real values for `anthropic_api_key`, `langsmith_api_key`, `ship_api_token` in a gitignored
   `terraform.tfvars` (see the updated `terraform.tfvars.example` in this same PR).
4. Explicit human sign-off to run `terraform apply`, per this repo's escalation policy gate #2 —
   this agent will not run it.
