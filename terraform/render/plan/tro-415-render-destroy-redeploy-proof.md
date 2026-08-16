# Destroy-and-redeploy + drift proof — the full Ship topology on Render (TRO-415 / PF-901)

**Date:** 2026-08-16 15:59–16:20 UTC · **Terraform:** `1.9.8` (darwin_arm64, downloaded to the session scratchpad, not committed — same methodology as `tro-316-destroy-redeploy-proof.md`) · **Provider:** `render-oss/render` `1.9.1` (pinned lock file) · **Config:** this directory, unchanged — every value below came from `variables.tf` defaults or a per-run tfvars file (secrets generated fresh with `openssl rand`, never committed).

## What was proven, in one paragraph

From this directory's config alone, **`terraform apply` stood up the complete Ship topology — Postgres 16 + the `ship` docker web service (built from this repo's `Dockerfile` on `main`) + the FleetGraph agent service — as three brand-new resources; the API came up, ran its migrations, served `/health` 200 and `/api/v1/openapi.json` (OpenAPI 3.1.0, 21 paths); `terraform destroy` removed all three (both URLs → 404) while the graded service `ship-rr6m.onrender.com` stayed 200 throughout; a second `terraform apply` from the same config re-created all three at the *same URLs* (`ship-pf901.onrender.com`, `ship-agent-pf901.onrender.com`) with new resource IDs; and a manual out-of-band change (two env vars edited through the Render API, i.e. the dashboard path) was detected by `terraform plan` as `1 to change`.** Every action below actually ran (a proof, not a plan capture).

## Why a *parallel* stack, and the two deviations from prod that were forced by Render's tiers

- **The graded URL was never destroyed.** `terraform.tfstate` (default workspace) tracks the real `ship`/`ship-db`/`ship-agent`. Destroying those recreates the web service under a new `onrender.com` subdomain (Render assigns it) — the graded submission URL, README grader creds and `CORS_ORIGIN` would all break, and `ship-db`'s data would be gone. So the exercise ran in a fresh Terraform **workspace `pf901`** (empty state) with `service_name`/`database_service_name`/`agent_service_name` overridden to `*-pf901`. Same config, same modules, same variables — only names differ. Blast-radius reasoning below is therefore *observed*, and the live service's health was probed before/after every step.
- **Postgres could not be `free`:** Render rejected the first apply with `cannot have more than one active free tier database` (the real `ship-db` holds the one free slot). The parallel DB ran as `basic_256mb` (`database_plan` override) — the smallest paid tier, prorated per minute, for ~15 minutes total across both stacks.
- **The web service ran `free` on the first stack and `starter` on the second.** On `free`, the reconcile-apply after the drift demo hit the *known* provider bug documented in this directory's README (`maintenance mode can only be configured for non-free tier services` — the provider's Update call always sends `maintenance_mode`). The real `ship` service is on **`starter`** (observed via the Render API), so the second stack used `service_plan = "starter"` to be faithful to prod; it existed for ~8 minutes. **All parallel resources were destroyed at the end** (Render API lists no `*pf901*` service or postgres; workspace state empty). Total billing exposure: a few cents of prorated `starter` + `basic_256mb` time — Troy asked that no ongoing cost be incurred, and none is.
- One drift-detection subtlety worth defending: `plan` shows the changed values as `(sensitive value)` because `env_vars` are declared sensitive in this config — the diff is detected and attributed to the exact keys (`CORS_ORIGIN`, `RATE_LIMIT_APP_RPM`), the values are just not printed. That is the intended behaviour for a config that carries secrets in the same map.

## Annotation — one sentence per resource (blast radius observed, not inferred)

| Resource | Action(s) observed | Blast radius (observed) |
|---|---|---|
| `render_postgres.ship` | create (41 s / 1 m 21 s) → destroy (1 s) → re-create | Destroying it deletes the instance and every row in it; nothing else in the stack references it by ID except the web service's `DATABASE_URL` (declared in config, so the recreated service picks up the new instance automatically). The **graded** `ship-db` was never in this workspace's state and was untouched. |
| `render_web_service.ship` | create (5–6 s to register; ~90 s docker build to `live`) → destroy (0 s) → re-create | Its own URL goes 404 on destroy and comes back at the **same** URL after re-apply (name-derived); the agent's `SHIP_API_BASE_URL`-style coupling is by URL, so a re-created service with the same name is transparent to it. Zero effect on `ship-rr6m` (200 before, during and after). |
| `render_web_service.agent` | create (4–5 s) → destroy (1 s) → re-create | Stateless (FG-2/FG-4); same URL after re-apply. Free-tier provider bug means *updates* to it must go through the Render REST API (README) — creation/destruction via Terraform are unaffected, as observed here. |

## Sequence, exactly as run

```bash
cd terraform/render
set -a; . ../../.env; set +a                # RENDER_API_KEY only
terraform init
terraform workspace new pf901               # empty state — the graded stack is NOT here
terraform plan  -var-file=<scratch>/pf901.tfvars -out=create.tfplan   # 3 to add
terraform apply create.tfplan               # (first attempt: free postgres refused → database_plan=basic_256mb)
curl https://ship-pf901.onrender.com/health           # 200 once the docker build is live
# drift: two env vars changed via PUT /v1/services/{id}/env-vars/{key} (dashboard-equivalent)
terraform plan                              # 0 add, 1 change — drift detected on exactly those keys
terraform destroy -auto-approve             # 3 destroyed; both pf901 URLs → 404; ship-rr6m still 200
terraform apply  -auto-approve              # 3 added again from config alone; same URLs, new IDs
terraform destroy -auto-approve             # cleanup — nothing pf901 remains, no ongoing cost
```

## Step 1 — plan (create), excerpt
```text
  # render_postgres.ship will be created
  + resource "render_postgres" "ship" {
      + name                      = "ship-db-pf901"
      + plan                      = "basic_256mb"
      + region                    = "oregon"
      + version                   = "16"
  # render_web_service.agent will be created
  + resource "render_web_service" "agent" {
      + environment_id                = "evm-d9kf2t7avr4c73asbmig"
      + health_check_path             = "/health"
      + name                          = "ship-agent-pf901"
      + plan                          = "free"
      + region                        = "oregon"
  # render_web_service.ship will be created
  + resource "render_web_service" "ship" {
      + environment_id                = "evm-d9kf2t7avr4c73asbmig"
      + health_check_path             = "/health"
      + name                          = "ship-pf901"
      + plan                          = "free"
      + region                        = "oregon"
Plan: 3 to add, 0 to change, 0 to destroy.
```

## Step 2 — apply (create), excerpt
```text
render_postgres.ship: Creating...
render_postgres.ship: Creation complete after 41s [id=dpg-da0tsem7bikc73fvb4i0-a]
render_web_service.ship: Creating...
render_web_service.ship: Creation complete after 5s [id=srv-da0tsoou01pc73939deg]
render_web_service.agent: Creating...
render_web_service.agent: Creation complete after 5s [id=srv-da0tsq0u01pc73939g1g]
Apply complete! Resources: 3 added, 0 changed, 0 destroyed.
apply1 exit=0
agent_service_id = "srv-da0tsq0u01pc73939g1g"
agent_service_url = "https://ship-agent-pf901.onrender.com"
database_id = "dpg-da0tsem7bikc73fvb4i0-a"
web_service_id = "srv-da0tsoou01pc73939deg"
web_service_url = "https://ship-pf901.onrender.com"
```

## Step 3 — verification of stack #1 (Render deploy went live on the current `main` commit; the graded service unaffected)
```text
deploy dep-da0tt0odb16c73c1uf00 build_in_progress commit=41e1ac32 2026-08-16T16:00:05.630371Z→null
health=Not Found
 404
health=Not Found
 404
health={"status":"ok"} 200
openapi 3.1.0 paths=21
graded live health=200
```

## Step 4 — drift demo (manual change → `terraform plan` shows the diff; reconcile blocked by the free-tier provider bug on stack #1)
```text
== drift: manual change via Render API (dashboard-equivalent) at Sun Aug 16 16:03:36 UTC 2026
== terraform plan after manual change
  ~ update in-place
  # render_web_service.ship will be updated in-place
  ~ resource "render_web_service" "ship" {
      ~ env_vars                      = {
          ~ "CORS_ORIGIN" = {
              ~ value          = (sensitive value)
          ~ "RATE_LIMIT_APP_RPM" = {
              ~ value          = (sensitive value)
Plan: 0 to add, 1 to change, 0 to destroy.
plan exit=0
== terraform apply to reconcile drift Sun Aug 16 16:03:50 UTC 2026
  ~ update in-place
  # render_web_service.ship will be updated in-place
  ~ resource "render_web_service" "ship" {
      ~ env_vars                      = {
          ~ "CORS_ORIGIN" = {
              ~ value          = (sensitive value)
          ~ "RATE_LIMIT_APP_RPM" = {
              ~ value          = (sensitive value)
Plan: 0 to add, 1 to change, 0 to destroy.
Error: Error updating service
maintenance mode can only be configured for non-free tier services
apply exit=1
== env vars after reconcile (Render API)
RATE_LIMIT_APP_RPM=999
CORS_ORIGIN=https://drift-demo.example.invalid
== plan after reconcile
Plan: 0 to add, 1 to change, 0 to destroy.
```

## Step 5 — destroy the whole stack
```text
== DESTROY whole pf901 stack Sun Aug 16 16:04:26 UTC 2026
pre-destroy: pf901 health=200 graded=200
render_web_service.agent: Destroying... [id=srv-da0tsq0u01pc73939g1g]
render_web_service.agent: Destruction complete after 0s
render_web_service.ship: Destroying... [id=srv-da0tsoou01pc73939deg]
render_web_service.ship: Destruction complete after 0s
render_postgres.ship: Destroying... [id=dpg-da0tsem7bikc73fvb4i0-a]
render_postgres.ship: Destruction complete after 1s
Destroy complete! Resources: 3 destroyed.
destroy exit=0
post-destroy: pf901 health=404 agent=404 graded=200 Sun Aug 16 16:04:51 UTC 2026
```

## Step 6 — re-apply from config alone (stack #2, `service_plan = "starter"` to match the real `ship`)
```text
== RE-APPLY from config alone Sun Aug 16 16:05:02 UTC 2026
Plan: 3 to add, 0 to change, 0 to destroy.
  + agent_service_url = (known after apply)
render_postgres.ship: Creating...
render_postgres.ship: Creation complete after 1m21s [id=dpg-da0tvbu7bikc73fvh590-a]
render_web_service.ship: Creating...
render_web_service.ship: Creation complete after 6s [id=srv-da0tvvvlk1mc738pkvh0]
render_web_service.agent: Creating...
render_web_service.agent: Creation complete after 4s [id=srv-da0u015bedkc73bju0vg]
Apply complete! Resources: 3 added, 0 changed, 0 destroyed.
agent_service_id = "srv-da0u015bedkc73bju0vg"
agent_service_url = "https://ship-agent-pf901.onrender.com"
database_id = "dpg-da0tvbu7bikc73fvh590-a"
web_service_id = "srv-da0tvvvlk1mc738pkvh0"
web_service_url = "https://ship-pf901.onrender.com"
apply2 exit=0
agent_service_id = "srv-da0u015bedkc73bju0vg"
agent_service_url = "https://ship-agent-pf901.onrender.com"
database_id = "dpg-da0tvbu7bikc73fvh590-a"
web_service_id = "srv-da0tvvvlk1mc738pkvh0"
web_service_url = "https://ship-pf901.onrender.com"
```


Stack #2's services registered and started building on the current `main` commit; the verification poll for stack #2 was cut short by the maintainer's instruction to stop incurring cost, so the "came back up" evidence for stack #2 is the successful `apply` (3 added, same URLs) plus the identical build path already observed to go `live` on stack #1 — **not** an independently observed second `/health` 200. Stated plainly rather than rounded up.

## Step 7 — final destroy (cleanup)
```text
== FINAL DESTROY (cleanup, stop billing) Sun Aug 16 16:17:00 UTC 2026
render_web_service.agent: Destruction complete after 1s
render_web_service.ship: Destruction complete after 0s
render_postgres.ship: Destruction complete after 1s
Destroy complete! Resources: 3 destroyed.
destroy exit=0
```

## Where this leaves PF-901 / W6-R12 / W6-R40

- **Destroy-and-redeploy from config alone: proven** on the full three-resource topology (this file). The graded `ship`/`ship-db` remain on their 2026-07-30 import in the default workspace and were deliberately not destroyed (URL/data blast radius — see above).
- **Drift detection: proven** (`plan` → `1 to change`, keys named). **Drift reconciliation by `apply`: proven blocked on free-tier web services** by the provider bug this directory's README already documents, and not re-attempted on the `starter` stack because the maintainer stopped the paid exercise; the README's REST-API workaround remains the documented path for free-tier resources.
- Committed plan artifacts for the *real* stack: `plan-annotated.md`, `post-import-plan-no-changes.txt`, `tro-411-pf900-w6-env-vars.md` (this directory).
