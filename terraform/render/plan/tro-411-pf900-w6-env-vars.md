# Terraform extension — Week 6 platform env vars (PF-900 / TRO-411)

**Date:** 2026-08-10 · **Terraform:** `1.9.8` (darwin_arm64, temp-downloaded into the session
scratchpad, not committed — same methodology as every other capture in this directory).
**Provider:** `render-oss/render` `1.9.1`, resolved via `terraform init` against the pinned
`required_providers` block — still the latest stable release on the public registry as of this
date (checked live: `GET https://registry.terraform.io/v1/providers/render-oss/render/versions`).

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

### Credential-blocked capture — `terraform plan -input=false`, no `RENDER_API_KEY`, no tfvars

**Observed, not derived.** This worktree (`Ship-wt-tro_411`) has no `RENDER_API_KEY` in its process
environment and no `terraform.tfvars` (only the committed `.example`) — confirmed directly
(`env | grep -i RENDER` empty; `find ... -iname terraform.tfvars -not -iname '*.example'` empty in
this worktree). Per this ticket's dispatch rules, `terraform plan` runs **only** if a credential is
already present — never fabricated, prompted for, or copied in from outside the worktree — so this
capture was run exactly as the environment actually is, with no `-var`/`-var-file` supplied:

```text
Error: No value for required variable

  on variables.tf line 27:
  27: variable "session_secret" {

The root module input variable "session_secret" is not set, and has no
default value. Use a -var or -var-file command line argument to provide a
value for this variable.

(... five more identical "No value for required variable" errors, one each
for anthropic_api_key, langsmith_api_key, ship_api_token,
agent_internal_secret, secret_encryption_key, fleetgraph_oauth_client_secret,
grader_oauth_client_secret ...)
```

**What this proves:** Terraform validates required-with-no-default variables before it ever reaches
provider configuration, so this particular run errors before the `RENDER_API_KEY` check that
`tro-316-agent-plan-annotated.md`'s "Capture 1" (2026-08-03) shows further down that same path. It
is nonetheless useful, real evidence: **all three new sensitive variables this ticket adds
(`secret_encryption_key`, `fleetgraph_oauth_client_secret`, `grader_oauth_client_secret`) appear in
the error list**, alongside every pre-existing required secret (`session_secret`,
`anthropic_api_key`, `langsmith_api_key`, `ship_api_token`, `agent_internal_secret`) — structural
proof they are wired as intended (sensitive, no default, required) using the exact same mechanism
this root already uses for every other secret, obtained without supplying a single fabricated
value.

**What this does NOT establish, and why:** a live, credentialed `terraform plan -var-file=...`
capture — the actual "annotated `terraform plan` output committed as a submission artifact"
deliverable this ticket's Proof line asks for. `RENDER_API_KEY` lives in the gitignored
repo-root `.env` in the **main checkout** (`/Users/troy/repos/GAUNTLET/Ship/.env`), per the
documented `set -a; source ../../.env; set +a` workflow (`README.md`, `versions.tf`) — but this
worktree is a separate checkout and that file is not present here, nor copied in. This agent's
dispatch brief is explicit: run `plan` only if the credential is "already present in the
environment or an existing tfvars" of *this* worktree, and never fabricate one (including the
"non-empty placeholder `RENDER_API_KEY`" trick `tro-316-agent-plan-annotated.md`'s own "Capture 2"
used under a different session's rules) — so this capture stops here, honestly, rather than
manufacturing a plan that looks complete but proves less than it appears to.

## Mechanical assist — `scripts/factory/verify-terraform-artifact.sh`

The test-design comment on TRO-411 proposes an optional grep-based checker over a **committed,
already-captured** plan text — not a gate test (nothing under `api/src/**`/`web/src/**` can run
`terraform`), but useful to catch a missing env var before a human reviewer has to. Built at
`scripts/factory/verify-terraform-artifact.sh`; checks items #2–#4 of that comment (every new env
var inside a real `render_*` env_vars block, both services + Postgres present, provider still
exact-pinned). It cannot check #1 or #5 (those need a live, credentialed plan and a human's
judgment) — its own output says so.

**Proven working, red then green, both on real inputs (no fabricated credentials involved
anywhere in this exercise — one real pre-existing artifact, one clearly-labeled non-infra
fixture):**

- **Red** — run against this directory's own pre-existing `tro-316-agent-plan-annotated.md`
  (captured 2026-08-03, before this ticket's env vars existed): all 8 new env-var checks correctly
  **FAIL** (none of them are in that older capture — they didn't exist yet), while the 3
  resource-address checks and the provider-pin check correctly **PASS** (that plan does contain
  `render_web_service.ship`/`.agent`, `render_postgres.ship`, and an exact-pinned provider) — proof
  the script fails for the *right* reason (genuinely absent content), not a broken checker.
- **Green** — run against a synthetic, explicitly-labeled-as-fake fixture
  (`tro411-synthetic-plan-fixture.txt`, built in the session scratchpad, never committed) shaped
  like Terraform's real plan-rendering output (the `"KEY" = {` pattern `tro-316-agent-plan-
  annotated.md`/`plan-annotated.md` already show for real): all 12 checks **PASS**. This is a test
  of the *checker's own detection logic* against a fixture, not a claim about live infrastructure —
  it establishes the script can actually reach a passing state when its inputs contain what it's
  looking for, not just that it's capable of failing.

Once a real, credentialed plan is captured (see "What a human/orchestrator needs to finish this"
below), run:

```bash
scripts/factory/verify-terraform-artifact.sh terraform/render/plan/<real-capture-file>.md
```

## What a human/orchestrator needs to finish this

1. A real `RENDER_API_KEY`, sourced the documented way (`set -a; source ../../.env; set +a` from
   `terraform/render/`, run from a location where that `.env` actually exists — e.g. the main
   checkout, or copied into this worktree by someone authorized to move that credential).
2. Real values for the three new required secrets (`secret_encryption_key`,
   `fleetgraph_oauth_client_secret`, `grader_oauth_client_secret`) plus the five pre-existing ones,
   in a gitignored `terraform.tfvars` — the updated `terraform.tfvars.example` in this same PR lists
   every one with its placeholder and generation command.
3. Run `terraform plan -var-file=terraform.tfvars`, redact per the pattern `plan-annotated.md`/
   `tro-316-agent-plan-annotated.md` already establish (grep for `postgresql://`, the real secret
   values, `rnd_`, `bearer`/`authorization` before committing), annotate resource-by-resource per
   this directory's existing convention, and commit as the actual submission artifact.
4. Run `scripts/factory/verify-terraform-artifact.sh` against that real capture as a final
   mechanical self-check before treating the artifact as complete.
5. The pre-existing "adoption gap" (`README.md`'s adoption memo) is unrelated to this ticket and
   still unresolved — a plan run from a fresh/worktree-local state will still show `render_postgres
   .ship`/`render_web_service.ship` as `create` rather than `0 changes`, exactly as
   `tro-316-agent-plan-annotated.md` already documented for the identical reason (state is local
   and gitignored, never committed, so it does not travel with the worktree). This is a pre-existing,
   already-flagged condition, not something this ticket introduced or is responsible for resolving.
