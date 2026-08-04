# Destroy-and-redeploy proof — the FleetGraph agent service (TRO-316 / FG-11)

**Date:** 2026-08-04 · **Terraform:** `1.9.8` (darwin_arm64, downloaded to the session scratchpad,
not committed — same methodology as `tro-316-agent-plan-annotated.md` in this same directory).
**Provider:** `render-oss/render` `1.9.1`, from the pinned lock file.

This closes the one item `tro-316-agent-plan-annotated.md` left open: that capture proved the
config *plans* cleanly but explicitly could not attempt a real `apply` (no credentials in that
session). This one had all four required secrets (`RENDER_API_KEY`, `ANTHROPIC_API_KEY`,
`LANGSMITH_API_KEY`, `SESSION_SECRET`) and explicit human sign-off to run `terraform apply` and
the destroy-and-redeploy proof, both scoped to the new agent service only — not the pre-existing
`ship`/`ship-db` resources, which stay on their Week-4 import (unchanged, deliberately, per the
same human sign-off).

## Sequence, exactly as run

```bash
cd terraform/render
terraform init
terraform plan  -var-file=terraform.tfvars -out=plan.tfplan   # 1 to add, 0 to change, 0 to destroy
terraform apply plan.tfplan                                    # create
curl https://<agent-url>/health   # 200 {"status":"ok"}
curl https://<agent-url>/ready    # 200 {"status":"ready"}

terraform destroy -target=render_web_service.agent -var-file=terraform.tfvars -auto-approve
curl https://<agent-url>/health   # 404 — service gone
curl https://ship-rr6m.onrender.com/health   # 200 — ship/ship-db untouched by the targeted destroy

terraform apply -var-file=terraform.tfvars -auto-approve   # re-create, config alone, no import
curl https://<new-agent-url>/health   # 200 {"status":"ok"}
curl https://<new-agent-url>/ready    # 200 {"status":"ready"}
```

## Step 1 — first apply (create)

```text
Terraform will perform the following actions:

  # render_web_service.agent will be created
  + resource "render_web_service" "agent" {
      + name                          = "ship-agent"
      + health_check_path             = "/health"
      + region                        = "oregon"
      + plan                          = "free"
      + runtime_source                = {
          + docker = {
              + branch          = "main"
              + dockerfile_path = "./agent/Dockerfile"
              + repo_url        = "https://github.com/troysatchell/ship"
            }
        }
      + env_vars = { 9 entries, all (sensitive value) }
    }

Plan: 1 to add, 0 to change, 0 to destroy.

render_web_service.agent: Creating...
render_web_service.agent: Creation complete after 4s [id=srv-d9otu2pt0dsc73brot60]

Apply complete! Resources: 1 added, 0 changed, 0 destroyed.

Outputs:
agent_service_id  = "srv-d9otu2pt0dsc73brot60"
agent_service_url = "https://ship-agent-e0cr.onrender.com"
web_service_url   = "https://ship-rr6m.onrender.com"   # unchanged
```

**Verified live:** `GET /health` → `200 {"status":"ok"}`. `GET /ready` → `200 {"status":"ready"}`.

## Step 2 — targeted destroy (agent only)

```text
Terraform will perform the following actions:

  # render_web_service.agent will be destroyed
  - resource "render_web_service" "agent" { ... -> null }

Plan: 0 to add, 0 to change, 1 to destroy.
render_web_service.agent: Destroying... [id=srv-d9otu2pt0dsc73brot60]
render_web_service.agent: Destruction complete after 0s
Destroy complete! Resources: 1 destroyed.
```

**Verified:** `https://ship-agent-e0cr.onrender.com/health` → `404` (service gone from Render's
routing). `https://ship-rr6m.onrender.com/health` → still `200` — the live production `ship`
service was never touched by the `-target=render_web_service.agent` destroy.

## Step 3 — re-apply from config alone (no import, no manual step)

```text
Plan: 1 to add, 0 to change, 0 to destroy.
render_web_service.agent: Creating...
render_web_service.agent: Creation complete after 4s [id=srv-d9otunmgekts73eqs0h0]

Apply complete! Resources: 1 added, 0 changed, 0 destroyed.

Outputs:
agent_service_id  = "srv-d9otunmgekts73eqs0h0"       # new id — genuinely recreated, not reused
agent_service_url = "https://ship-agent-t0zy.onrender.com"
```

**Verified live, second URL (proves this is the re-created instance, not a cached response from
the destroyed one):** `GET /health` → `200 {"status":"ok"}`. `GET /ready` → `200 {"status":"ready"}`.

## What this establishes (observed)

- The agent service is fully reproducible from `terraform apply` alone — no `import`, no manual
  Render-dashboard step, at any point in this sequence.
- `terraform destroy -target=render_web_service.agent` removes exactly that one resource; the
  live `ship`/`ship-db` resources (still on their Week-4 import, out of this ticket's scope)
  verified unaffected before and after.
- Both `/health` and `/ready` return `200` on the freshly re-created instance, satisfying this
  ticket's own proof requirement ("reaches a working `/health` **and** `/ready` at a public URL,
  with no manual step and no `import`").

## One caveat, not hidden

`SHIP_API_TOKEN` was supplied as a placeholder string (`PLACEHOLDER_PENDING_FG-23_REAL_USER_TOKEN`),
not a real per-user token. `agent/src/config.ts`'s `isConfigComplete()` only requires the three
secrets to be non-empty strings — it does not validate them — so `/ready` genuinely returns `200`
with a placeholder in place; readiness proves the deployment infrastructure works, not that the
agent can yet authenticate against Ship. FLEETGRAPH.MD's own "Deployment model" section is explicit
that there is no service account — every token belongs to a real user — so minting the real one
belongs to **TRO-341 (FG-23)**, which also decides which Ship instance (graded vs. this live one)
the agent should ultimately point at and seeds it with FG-3's fixture states. Not done here on
purpose: two login attempts against the live production `ship-rr6m.onrender.com` login endpoint
during this session both returned a platform-level `403 Forbidden` (Cloudflare/Render edge, not
the app's own JSON error shape — root cause not investigated further, out of scope for an
infrastructure ticket), which is itself a fact worth FG-23 knowing about before it tries the same
path.

## What a human might still want to check

- The current `ship-agent` service (`srv-d9otunmgekts73eqs0h0`, `https://ship-agent-t0zy.onrender.com`)
  is the one live after this session — genuinely created by the final `apply` in this sequence, not
  a leftover from the first create.
- `terraform.tfvars` (gitignored) still holds the placeholder `ship_api_token` — FG-23 replaces it,
  not this ticket.
