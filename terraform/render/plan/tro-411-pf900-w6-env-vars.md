# Terraform extension — Week 6 platform env vars (PF-900 / TRO-411)

**Date:** 2026-08-10 · **Terraform:** `1.9.8` (darwin_arm64, temp-downloaded into the session
scratchpad, not committed — same methodology as every other capture in this directory).
**Provider:** `render-oss/render` `1.9.1`, resolved via `terraform init` against the pinned
`required_providers` block — still the latest stable release on the public registry as of this
date (checked live: `GET https://registry.terraform.io/v1/providers/render-oss/render/versions`).

**Update (same date, orchestrator follow-up):** the live, credentialed `terraform plan` capture
this file originally could not produce (see the first commit's version of this file, still visible
in git history) has now been run, under an explicit, scoped orchestrator authorization — see
"Live plan capture" below. The rest of this document (env var table, placement rationale,
structural verification) is unchanged and still accurate.

## What this ticket adds

`terraform/render/variables.tf`, `web_service.tf`, `agent_service.tf`, `terraform.tfvars.example`
extended with every new Week-6 platform env var named in the PM triage comment on TRO-411 and
PLUGFORGE.MD §2.10/§4 (PF-900):

| Env var | Resource(s) | Terraform variable | Sensitive | Default |
|---|---|---|---|---|
| `SECRET_ENCRYPTION_KEY` | `render_web_service.ship` | `secret_encryption_key` | yes | none (required) |
| `FLEETGRAPH_OAUTH_CLIENT_SECRET` | `render_web_service.ship` **and** `render_web_service.agent` | `fleetgraph_oauth_client_secret` | yes | none (required) |
| `GRADER_OAUTH_CLIENT_SECRET` | `render_web_service.ship` | `grader_oauth_client_secret` | yes | none (required) |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `render_web_service.ship` | `oauth_access_token_ttl_seconds` | no | `3600` (1h, §2.2) |
| `OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `render_web_service.ship` | `oauth_refresh_token_ttl_seconds` | no | `2592000` (30d, §2.2) |
| `RATE_LIMIT_APP_RPM` | `render_web_service.ship` | `rate_limit_app_rpm` | no | `120` (§2.7) |
| `RATE_LIMIT_TOKEN_RPM` | `render_web_service.ship` | `rate_limit_token_rpm` | no | `60` (§2.7) |
| `AGENT_PLATFORM_MODE` | `render_web_service.agent` | `agent_platform_mode` | no | `"internal"` (PF-702) |

**No application code reads any of these yet** — PF-101/PF-104/PF-105/PF-302/PF-500/PF-701/PF-702/
PF-907 haven't landed. This is deliberate: the ticket is explicitly "Start Day 1 — defense
material" (PLUGFORGE.MD §4), and its AC ("zero console-only config") requires every var to exist as
declared `.tf` config *before* the code that reads it ships, not after. Names are fixed exactly
once, here, per the PM triage comment ("test-designer flagged the duplicated-literal risk across
PF-900/701/907 ... Terraform artifact and boot checks reference the same constants") — PF-701 and
PF-907's future seed code must read these exact names from a shared config module, never
re-declare the literal.

**Placement rationale (which service gets which var):**
- `SECRET_ENCRYPTION_KEY` and `GRADER_OAUTH_CLIENT_SECRET` — `ship` only. Webhook encryption and the
  grader-app seed both run in the API's own boot/migration path; the agent has no reason to hold
  either.
- `FLEETGRAPH_OAUTH_CLIENT_SECRET` — **both** services, the same shared-secret shape as the
  existing `AGENT_INTERNAL_SECRET`/`AGENT_API_BASE_URL` pair: `ship` hashes and stores it when
  seeding the `oauth_apps` row (PF-701); the agent holds the plaintext to authenticate itself via
  the Client Credentials grant once PF-702 flips `AGENT_PLATFORM_MODE` to `sdk`. The two copies
  must match exactly or the agent's own token requests fail closed.
- `OAUTH_*_TTL_SECONDS`, `RATE_LIMIT_*_RPM` — `ship` only; these govern `/api/v1` behavior the API
  process owns.
- `AGENT_PLATFORM_MODE` — agent only; it is the agent's own read-path switch (PF-702).

**Auth-code TTL deliberately NOT exposed as a variable.** PLUGFORGE.MD §2.2 pins it at exactly 10
minutes, single-use, as a fixed security invariant, not an operational knob — making it
env-configurable would be scope creep past what §2.10 actually asks for ("OAuth TTL config").

## Structural verification performed (real, all commands below actually ran)

```bash
cd terraform/render
terraform fmt -check -recursive .    # exit 0 — already clean, no reformatting needed
terraform init -input=false          # reuses the committed .terraform.lock.hcl, no version drift
terraform validate                   # Success — see full output below
terraform plan -input=false          # see "credential-blocked capture" below
```

### `terraform fmt -check -recursive .`

```text
(no output — exit 0)
```

### `terraform init -input=false`

```text
Initializing the backend...
Initializing provider plugins...
- Reusing previous version of render-oss/render from the dependency lock file
- Installing render-oss/render v1.9.1...
- Installed render-oss/render v1.9.1 (signed by a HashiCorp partner, key ID E056C177173659B4)

Terraform has been successfully initialized!
```

### `terraform validate`

```text
Warning: Deprecated attribute

  on agent_service.tf line 47, in resource "render_web_service" "agent":
  47:       pull_request_previews_enabled,

The attribute "pull_request_previews_enabled" is deprecated. Refer to the
provider documentation for details.

(and one more similar warning elsewhere)

Success! The configuration is valid, but there were some
validation warnings as shown above.
```

**Both warnings are pre-existing** (identical text, identical two call sites — `web_service.tf`'s
own `ignore_changes` list and `agent_service.tf`'s, both predating this ticket) — this ticket's
changes introduce **zero new warnings and zero errors**. Confirmed by reading both warning
locations directly, not inferred from the summary line.

### Earlier, credential-blocked attempt (superseded — kept for the record)

The first version of this document (same commit history, before the orchestrator follow-up)
recorded that a live plan could not run: this worktree (`Ship-wt-tro_411`) had no `RENDER_API_KEY`
in its process environment and no `terraform.tfvars`, and the agent's original dispatch rules
required the credential to already be present — never fabricated, prompted for, or copied in — so
the attempt stopped at Terraform's own "No value for required variable" errors rather than
manufacturing a plan. That evidence is superseded by the real capture below, run under an explicit
orchestrator authorization scoped exactly to this: read (never copy) `RENDER_API_KEY` from the main
checkout's gitignored `.env`, generate throwaway placeholder values for the required secrets, plan
only (never apply, never destroy).

### Live plan capture — `terraform plan -var-file=terraform.tfvars`

**Observed, not derived. Run once, in full, in this worktree.**

**Credential provenance.** `RENDER_API_KEY` was read from the **main checkout's** gitignored
`/Users/troy/repos/GAUNTLET/Ship/.env` — one line extracted (`grep -m1 '^RENDER_API_KEY='`), never
the whole file, never copied into this worktree, never echoed or logged (the command that loaded it
printed only its length and a 4-character prefix, e.g. `rnd_****`, as its own proof of having a
real-shaped value — the full value never appeared in any tool output, terminal, or file). Exported
into the shell environment for the single command that ran `terraform plan`, then explicitly
`unset`. No other variable from that `.env` (`ANTHROPIC_API_KEY`, `LANGSMITH_API_KEY`,
`SESSION_SECRET`) was read, exported, or used anywhere in this session.

**Var-file provenance.** `terraform/render/terraform.tfvars` (gitignored — confirmed via
`git check-ignore -v terraform.tfvars` → `terraform/.gitignore:5:*.tfvars` **before** the file was
written) holds **throwaway placeholder values only**, each generated locally via `openssl rand -hex
32` at write time: `session_secret`, `anthropic_api_key`, `langsmith_api_key`, `ship_api_token`,
`agent_internal_secret` (the five pre-existing required secrets this ticket did not add — no real
value for any of these was read from anywhere, since the orchestrator authorization scoped credential
access to `RENDER_API_KEY` only) and this ticket's own three new required secrets
(`secret_encryption_key`, `fleetgraph_oauth_client_secret`, `grader_oauth_client_secret`). **None of
these eight values are real credentials, none were applied to any live resource** (plan-only run),
and all eight are declared `sensitive = true` in `variables.tf`, so Terraform's own renderer redacts
every one of them as `(sensitive value)` below — never a literal, confirmed by the redaction check
in the next section.

**Local-state limitation, stated up front.** This root's Terraform state is local-only and
gitignored (no remote backend in `versions.tf`), so it never travels with a worktree — a fact this
directory's own `tro-316-agent-plan-annotated.md` (2026-08-03) already established for the identical
reason. This worktree's state was genuinely empty before this run (no prior `init`/`plan`/`apply`
had happened here), so **all three resources plan as `create`**, including
`render_postgres.ship`/`render_web_service.ship` — which are, in reality, already-imported, already-
live production resources in a *different* checkout's state file. This is not new drift and not
something this ticket introduced: it is the same pre-existing "adoption gap"
`terraform/render/README.md`'s own adoption memo documents, reproduced here because state simply
does not exist in this worktree, not because the live resources changed.

**Redaction check performed before writing this file** (same method as `plan-annotated.md`/
`tro-316-agent-plan-annotated.md`): grepped the raw capture for `postgresql://` (connection
strings), `rnd_` (the Render API key's real prefix), `bearer`/`authorization` (case-insensitive),
and every one of the 8 throwaway hex secrets as a literal 64-character hex string. **Zero matches on
all four checks.** Confirmed separately that `(sensitive value)` appears 25 times — once per
sensitive attribute Terraform's own schema redacts, which is why none of the above ever had a
chance to appear in the first place; ANSI color was already suppressed (`-no-color`), so no
stripping was needed.

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
          + "AGENT_INTERNAL_SECRET" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "AGENT_PLATFORM_MODE" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "ANTHROPIC_API_KEY" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "FLEETGRAPH_OAUTH_CLIENT_SECRET" = {
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
          + "AGENT_API_BASE_URL" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "AGENT_INTERNAL_SECRET" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "CORS_ORIGIN" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "DATABASE_URL" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "FLEETGRAPH_OAUTH_CLIENT_SECRET" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "GRADER_OAUTH_CLIENT_SECRET" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "OAUTH_ACCESS_TOKEN_TTL_SECONDS" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "OAUTH_REFRESH_TOKEN_TTL_SECONDS" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "RATE_LIMIT_APP_RPM" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "RATE_LIMIT_TOKEN_RPM" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "SECRET_ENCRYPTION_KEY" = {
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

Warning: Deprecated attribute

  on agent_service.tf line 47, in resource "render_web_service" "agent":
  47:       pull_request_previews_enabled,

The attribute "pull_request_previews_enabled" is deprecated. Refer to the
provider documentation for details.

(and one more similar warning elsewhere)

─────────────────────────────────────────────────────────────────────────────

Note: You didn't use the -out option to save this plan, so Terraform can't
guarantee to take exactly these actions if you run "terraform apply" now.
```

## Annotation — every new env var called out, one sentence per resource

| Resource | Action | What it is | New PF-900 env vars present | Blast radius | Safe or risky |
|---|---|---|---|---|---|
| `render_postgres.ship` | **create** | A new, empty Render Postgres 16 instance — proposed as `create` purely because this worktree's Terraform state is empty (see "Local-state limitation" above), not because this ticket changed anything about the database; `postgres.tf` is untouched by this ticket. | none (this ticket adds no Postgres-level config) | Same as every other capture in this directory: applying a `create` plan against a state genuinely lacking the import would stand up a second, empty database next to the real one — no destructive effect on the real `ship-db`. | **Safe as a plan**; unrelated to this ticket's actual change. |
| `render_web_service.agent` | **create** | The FleetGraph agent service, now carrying **2 new env vars**: `AGENT_PLATFORM_MODE` (PF-702's read-path flag, throwaway-resolves to the declared default path since no override was set) and `FLEETGRAPH_OAUTH_CLIENT_SECRET` (this agent's own Client Credentials identity). Both render as `(sensitive value)`/present, confirming they reach the resource's `env_vars` map exactly as `agent_service.tf` declares. | `AGENT_PLATFORM_MODE`, `FLEETGRAPH_OAUTH_CLIENT_SECRET` | A pure addition to an already-isolated, stateless service (per `tro-316-destroy-redeploy-proof.md`, destroying/recreating this resource does not touch `ship`/`ship-db`). Applying this specific diff would add two env vars to a live agent deploy and trigger a redeploy — no data loss (agent holds no persistent state), brief restart only. | **Safe** — additive env vars only, on a service already proven independently destroyable/recreatable. |
| `render_web_service.ship` | **create** | The main Ship API/web service, now carrying **7 new env vars**: `SECRET_ENCRYPTION_KEY`, `FLEETGRAPH_OAUTH_CLIENT_SECRET`, `GRADER_OAUTH_CLIENT_SECRET`, `OAUTH_ACCESS_TOKEN_TTL_SECONDS`, `OAUTH_REFRESH_TOKEN_TTL_SECONDS`, `RATE_LIMIT_APP_RPM`, `RATE_LIMIT_TOKEN_RPM` — all 7 present in the `env_vars` map exactly as `web_service.tf` declares. Proposed as `create` for the same state-gap reason as `render_postgres.ship` above; in reality this fronts the live `ship-rr6m.onrender.com`. | `SECRET_ENCRYPTION_KEY`, `FLEETGRAPH_OAUTH_CLIENT_SECRET`, `GRADER_OAUTH_CLIENT_SECRET`, `OAUTH_ACCESS_TOKEN_TTL_SECONDS`, `OAUTH_REFRESH_TOKEN_TTL_SECONDS`, `RATE_LIMIT_APP_RPM`, `RATE_LIMIT_TOKEN_RPM` | Against the **real, live, already-imported** state (a different checkout's, not this worktree's), applying this diff would add 7 env vars and trigger a redeploy/restart — brief downtime, in-flight requests dropped, same as any other env-var change to this resource (`post-import-plan-no-changes.txt`'s own annotation already documents this blast radius for the resource in general). None of the 7 new vars is `SESSION_SECRET`, so this specific diff would not log out active sessions. | **Additive and safe in shape**; the numbers above are the actual proof the 7 vars reach the right resource — applying against the real live state is still a real redeploy, not a no-op. |

**Why "3 to add" and not "0 changes, 7 env vars updated."** Exactly the situation `tro-316-agent-
plan-annotated.md` already worked through for the agent-only case: this worktree's state has no
record of the already-imported live `ship`/`ship-db` (a **different** local state file, in a
**different** checkout, never committed — `IMPORT-LOG.md` describes that import, run once, in one
place, in 2026-07-30). Reading this as "3 to add" is correct given this worktree's actual state; it
is **not** evidence the live resources drifted, and it is **not** this ticket's gap to close (see
`README.md`'s pre-existing adoption memo).

## What this plan establishes (observed) vs. does not (derived / still open)

**Established, observed, this session:**
- All 8 new env vars from PF-900's scope reach an actual `render_*` resource's `env_vars` map,
  attached to the correct resource (2 on `agent`, 7 on `ship`), not just declared in `variables.tf`
  and never wired.
- The config plans cleanly end-to-end with throwaway inputs: `terraform plan` exit code 0, zero
  errors, the same 2 pre-existing deprecation warnings as every other capture in this directory,
  zero new ones.
- Every sensitive value — the 8 throwaway placeholders and the 4 pre-existing sensitive attributes
  Terraform derives (`connection_info`, etc.) — rendered as `(sensitive value)`, never a literal, in
  both the raw capture and this committed file (redaction check above).
- `RENDER_API_KEY` genuinely authenticated far enough for Terraform to build a complete 3-resource
  plan (this is a real credential, unlike `tro-316-agent-plan-annotated.md`'s Capture 2 placeholder)
  — though, as that same file's own methodology notes, a `create`-only plan against empty state does
  not require Render to accept the key for a real API mutation, only for the plan-time SDK
  handshake; whether it authorizes an actual `apply` was not tested (`apply` was never run, per the
  orchestrator's explicit plan-only limit).

**NOT established (out of scope for a plan-only run, or a pre-existing condition this ticket did
not create):**
- Whether `terraform apply` would actually succeed against live Render infrastructure with real
  secret values — not run, per the orchestrator's explicit "never apply, never destroy" limit.
- "0 changes" against the real, live, already-imported `ship`/`ship-db` — not obtainable from this
  worktree without either importing here too (a state-changing operation, not requested) or running
  from the checkout that already holds that import. The **7 new `ship` env vars and 2 new `agent`
  env vars are still the real, correct diff** that a plan from the imported checkout would show;
  only the other ~15 already-existing attributes would additionally show as `0 changes` there
  instead of `(known after apply)`/`create` here.
- Real (non-throwaway) values for any of the 8 sensitive variables — deliberately out of scope; this
  was a structural/plan-shape proof, not a credential-provisioning exercise.

## Mechanical assist — `scripts/factory/verify-terraform-artifact.sh`

The test-design comment on TRO-411 proposes an optional grep-based checker over a **committed,
already-captured** plan text — not a gate test (nothing under `api/src/**`/`web/src/**` can run
`terraform`), but useful to catch a missing env var before a human reviewer has to. Built at
`scripts/factory/verify-terraform-artifact.sh`; checks items #2–#4 of that comment (every new env
var inside a real `render_*` env_vars block, both services + Postgres present, provider still
exact-pinned). It cannot check #1 or #5 (those need a live, credentialed plan and a human's
judgment) — its own output says so.

**Proven working, red then green then green-on-the-real-thing — three runs, escalating in
realism:**

1. **Red** — against this directory's own pre-existing `tro-316-agent-plan-annotated.md`
   (captured 2026-08-03, before this ticket's env vars existed): all 8 new env-var checks correctly
   **FAIL** (none of them are in that older capture — they didn't exist yet), while the 3
   resource-address checks and the provider-pin check correctly **PASS** — proof the script fails
   for the *right* reason (genuinely absent content), not a broken checker.
2. **Green (synthetic)** — against a clearly-labeled-as-fake fixture
   (`tro411-synthetic-plan-fixture.txt`, session scratchpad, never committed) shaped like
   Terraform's real plan-rendering output: all 12 checks **PASS** — proof of the checker's own
   detection logic against a fixture, not yet a claim about real infrastructure.
3. **Green (real)** — against the actual capture in this file (the "Live plan capture" section
   above), run via `scripts/factory/verify-terraform-artifact.sh
   terraform/render/plan/tro-411-pf900-w6-env-vars.md`:

   ```text
   PASS  env_vars block declares SECRET_ENCRYPTION_KEY
   PASS  env_vars block declares FLEETGRAPH_OAUTH_CLIENT_SECRET
   PASS  env_vars block declares GRADER_OAUTH_CLIENT_SECRET
   PASS  env_vars block declares OAUTH_ACCESS_TOKEN_TTL_SECONDS
   PASS  env_vars block declares OAUTH_REFRESH_TOKEN_TTL_SECONDS
   PASS  env_vars block declares RATE_LIMIT_APP_RPM
   PASS  env_vars block declares RATE_LIMIT_TOKEN_RPM
   PASS  env_vars block declares AGENT_PLATFORM_MODE
   PASS  resource address present: render_web_service.ship
   PASS  resource address present: render_web_service.agent
   PASS  resource address present: render_postgres.ship
   PASS  render-oss/render provider is exact-pinned in versions.tf

   verify-terraform-artifact: PASS — all mechanical checks passed.
   Reminder: this does NOT establish #1 (plan is clean against live state)
   or #5 (zero console-only config) — those require a real, credentialed
   'terraform plan' run and a human/reviewer's own judgment.
   ```

   Exit code `0`. This is now the artifact's own self-check, re-runnable by any future reviewer
   against this same committed file.

## What a human/orchestrator still needs to finish this

The live plan capture above closes most of what the first version of this section asked for.
What remains, unchanged from before:

1. **Real (non-throwaway) secret values**, provisioned through whatever secrets-management process
   the maintainer actually uses for Render (this session deliberately used throwaway placeholders
   only — see "Var-file provenance" above — and never had authorization to provision or view real
   values for `session_secret`/`anthropic_api_key`/`langsmith_api_key`/`ship_api_token`/
   `agent_internal_secret`, or this ticket's own three new secrets).
2. **A decision on `apply`**, which this session explicitly did not run (plan-only, per the
   orchestrator's limit) — and, tied to it, a decision on the pre-existing `ship`/`ship-db` adoption
   gap this ticket did not create (`README.md`'s adoption memo: import the live hand-built resources
   into a state this worktree can use, vs. accept that a worktree-local `apply` would create a
   parallel copy). Applying **this** worktree's plan as captured would create new, empty
   `ship`/`ship-db`/`ship-agent` resources rather than updating the real ones — the same caveat
   `tro-316-agent-plan-annotated.md` already carries for the identical reason.
3. **A plan run from the checkout that already holds the import** (or a fresh import into this
   worktree, if that's the maintainer's preferred path), to get the "0 changes on the untouched
   attributes, N env vars added" shape that actually reflects the live service's real diff — this
   worktree's capture is honest about what it is (a create-everything plan against empty state) and
   says so, rather than presenting itself as more than that.
