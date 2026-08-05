# Render-provider Terraform config (TF-10 / TRO-299)

Declares the two resources Ship's live deployment actually needs on Render — a docker web
service and a Postgres 16 instance — via the official `render-oss/render` provider, pinned
`1.9.1` (verified as the latest stable release on the public registry, 2026-07-30). This is the
**Category 8 improvement target** for the Render side; it replaces the hand-built dashboard setup
described in `memory-bank/techContext.md` with a config a clean machine can reproduce.

**This does not replace `scripts/deploy.sh`/`scripts/deploy-frontend.sh`.** Those deploy to AWS
(Elastic Beanstalk + S3/CloudFront); Render is a separate, parallel target. See
`audit/terraform/baseline.md` for the AWS side.

## Files

| File | Purpose |
|---|---|
| `versions.tf` | `required_version`, pinned provider, `provider "render"` block |
| `variables.tf` | All inputs, with descriptions; secrets are `sensitive = true` |
| `postgres.tf` | `render_postgres.ship` |
| `web_service.tf` | `render_web_service.ship`, including the three env vars |
| `outputs.tf` | Non-sensitive outputs only (IDs, URL) |
| `terraform.tfvars.example` | Placeholder values — copy to `terraform.tfvars` (gitignored) |

## Known provider bug — `render_web_service.agent` cannot be updated by `terraform apply`

**Applies only to the agent service (`render_web_service.agent` in `agent_service.tf`), on the
free tier.** `terraform apply` fails on *any* field change against this specific resource —
verified 2026-08-04 (TRO-341/FG-23) with `maintenance_mode`, and this is a `render-oss/render`
provider bug, not a config mistake: the provider's `Update` API call unconditionally includes
`maintenance_mode` in its payload regardless of whether it changed, and Render's API rejects that
field's mere presence for a free-tier service. Adding the field to `lifecycle.ignore_changes`
(already present on both `render_web_service.ship` and `render_web_service.agent` for the
unrelated `pull_request_previews_enabled`/`previews`/etc. drift) does **not** fix this — it only
suppresses what `terraform plan` *displays* as a diff, not what the provider actually sends in the
`Update` request body. Do not spend more time tuning `ignore_changes` for this; that path is a
documented dead end (`.claude/skills/ship-factory/references/lessons.md`, 2026-08-04 entry).

**The workaround, in place since 2026-08-04 and still current:** apply changes to the live agent
service via the Render REST API directly (`PUT /v1/services/{id}/env-vars/{key}`, or the
equivalent endpoint for the field being changed), not `terraform apply`. This Terraform config
stays the *record* of intent for the agent service — every field it declares is what the service
is supposed to look like — but for this one resource, on this one plan, the REST API call is what
actually executes the change. `terraform plan` against `render_web_service.agent` will keep
showing a diff for anything set this way until the upstream provider bug is fixed (a plan showing
"drift" here is expected, not a sign the API call failed).

**Concretely, this is why `AGENT_INTERNAL_SECRET` (`agent_service.tf`'s copy) has to be applied
this way today** ([TRO-347](https://linear.app/troysatchell/issue/TRO-347)) — even though the
variable is now declared in this config (`variables.tf`), a `terraform apply` that would set it on
the live free-tier agent service is expected to fail with the same provider error until Render or
`render-oss/render` fixes the underlying bug. `web_service.tf`'s `render_web_service.ship` is not
affected — plain `terraform apply` works normally against it, including for its own copies of
`AGENT_INTERNAL_SECRET` and `AGENT_API_BASE_URL`.

## Why this directory is inside `terraform/`

PR #41 (open, `fix/tf-2-unify-terraform-roots`, TF-2/TRO-235) adds
`scripts/check-single-tf-root.sh`, a CI guard against a second Terraform root managing the same
AWS infrastructure prod uses. Two things are true about it and this directory:

1. **This directory is deliberately placed inside `terraform/`**, per this ticket's brief, rather
   than as a sibling top-level directory — consistent with the guard's premise that `terraform/`
   is the one place Terraform config for this project lives.
2. **The guard would not flag this directory even if it were a sibling.** Read literally
   (`scripts/check-single-tf-root.sh` on that branch), it scans for `.tf` files containing a
   `provider "aws" {` block and fails on any such root outside its allow-list
   (`terraform`, `terraform/bootstrap`, `terraform/environments/dev`,
   `terraform/environments/shadow`). This config declares `provider "render"`, never
   `provider "aws"` — it is a different cloud, and the guard's own doc comment says as much
   ("child modules … and the cloud-free `audit/terraform/drift-demo` fixture … are unaffected").
   So this directory is exempt by the guard's own logic, not just by convention.

## Local-provider deliverable (Category 8, the other half)

`audit/terraform/baseline.md`'s improvement-target section calls for "local-provider config,
≥2 local resources, pinned provider" as a separate, cloud-free deliverable. **That already
exists and needs no changes:** `audit/terraform/drift-demo/main.tf` manages two `local_file`
resources (`local_file.app_config`, `local_file.env_file`) with `hashicorp/local` pinned to
`2.5.2` (`.terraform.lock.hcl` alongside it), and its drift-detection run (`terraform plan` going
from `No changes` to a 2-resource replace after an out-of-band edit) is documented in
`audit/terraform/baseline.md` under "Drift detection demonstration." This directory
(`terraform/render/`) is the **Render-provider** deliverable; `audit/terraform/drift-demo/` is
the **local-provider** deliverable. Verified by reading both files directly, not inferred from the
baseline doc's own description of them.

## Verified-vs-on-record facts

The ticket brief supplied a set of "known live-service facts" from the memory bank. Where
possible, each was checked against the live Render API (`GET /v1/services/{id}`,
`GET /v1/postgres/{id}`, `GET /v1/services/{id}/env-vars`, `GET /v1/owners`) on 2026-07-30, using
the API key in the gitignored repo-root `.env`. Values only, never raw secret material, are
recorded below.

| Fact | Status |
|---|---|
| Service `srv-d9kf2t942hec73aofrt0`, name `ship`, region `oregon`, runtime `docker`, plan `free`, URL `https://ship-rr6m.onrender.com` | **Verified live**, byte-for-byte match |
| Health check path `/health` | **Verified live** (`serviceDetails.healthCheckPath`) — note this is newer than an earlier memory-bank note calling it "unset"; the service has since had it set |
| Repo `github.com/troysatchell/ship`, branch `main`, auto-deploy on, Dockerfile at repo root, docker build context `.` | **Verified live** |
| Postgres `dpg-d9kgth6417fc7386hhh0-a`, name `ship-db`, region `oregon`, version `16`, plan `free` | **Verified live** |
| Owner ID `tea-d9kevetg1s2s73807n5g` | **Verified live** via both the service/database owner field and `GET /v1/owners` |
| Env vars set on the service: `DATABASE_URL`, `SESSION_SECRET`, `CORS_ORIGIN` | **Verified live** (names only pulled — `GET /v1/services/{id}/env-vars`; values never printed or stored) |
| Postgres `ipAllowList` "empty (internal-only)" | **Partially verified**: the live API returns `ipAllowList: null`, not `[]`. Functionally the provider docs describe the same behavior either way ("no IP addresses provided ⇒ only private-network connections allowed"), but `null` and `[]` are not literally the same JSON value, so this is recorded as a derived equivalence, not a byte-for-byte match. |
| Web service `ipAllowList` | Not part of the brief's fact list, but checked anyway: live value is `[{cidrBlock: "0.0.0.0/0", description: "everywhere"}]` — the provider's documented default for an unset `ip_allow_list`, consistent with a public web service |
| "Postgres: none exists yet" (an older memory-bank line) | **Superseded** — the same file's own later "Status: LIVE" section already says the database exists; the API confirms it does. Not a new finding, just noting the file has two sections describing different points in time. |

## Adoption memo — import vs. clean-machine apply

**Neither was run.** Per this ticket's hard safety rules, only `terraform validate`/`plan`/`fmt`
ran against the live account; no `apply` or `import`. The captured plan
(`terraform/render/plan/plan-annotated.md` — redacted, see that file for the redaction check) shows
Terraform proposing to **create** a new web service and a new Postgres instance, because this
config's state is empty and nothing has been imported — that is expected, not a bug, and it is
**not** to be "fixed" by importing as part of this ticket. The decision below is for a human
(escalation gate 2).

### Option A — `terraform import`, adopt the existing hand-built resources

```bash
cd terraform/render
terraform init
terraform import render_web_service.ship srv-d9kf2t942hec73aofrt0
terraform import render_postgres.ship dpg-d9kgth6417fc7386hhh0-a
terraform plan   # should now show ~0 changes if variable defaults truly match the live config
```

- **Cost:** none — no new Render resources are created; the free web service and free Postgres
  instance already in use keep running exactly as they are.
- **Risk:** the plan after import is very unlikely to be a clean no-op on the first try. Render's
  API returns some values Terraform can't fully control declaratively from a fresh config
  (e.g. the live Postgres database name `ship_34oc` is an auto-generated suffix this config's
  `database_name = "ship"` default does not reproduce — imported state would show that as a diff,
  and `database_name` is not simply editable in place for most Postgres providers without a
  destructive recreate). Whoever does the import should expect one or two rounds of adjusting
  variable values, or an explicit `ignore_changes` on the fields Render assigns rather than the
  user, before `plan` goes quiet.
- **Irreversible?** No — importing only writes to *this config's own* local state file; it does
  not modify the live resources at all. Easy to undo (`terraform state rm`) if the reconciliation
  turns out to be more work than it's worth.

### Option B — clean-machine `apply`, create a parallel service

```bash
cd terraform/render
cp terraform.tfvars.example terraform.tfvars   # fill in session_secret
set -a; source ../../.env; set +a               # RENDER_API_KEY
terraform init
terraform apply
```

- **Cost:** a **second**, brand-new free web service and free Postgres instance under the same
  owner. Both are on Render's free tier, so no direct dollar cost, but Render does not offer
  unlimited free services per account indefinitely, and running two copies of the same app is
  confusing operationally (two URLs, two databases, both named to look identical in the
  dashboard unless variables are overridden first).
- **Risk:** the new service gets a **different** generated slug/URL (not
  `ship-rr6m.onrender.com`), so `cors_origin` must be updated to match after creation — a genuine
  post-apply manual step, called out in `variables.tf`'s `cors_origin` description. The new
  Postgres instance starts **empty** — it is not seeded, and does not carry over the 257 documents
  already live on `ship-db`. Migrating data from the old instance to the new one is a separate,
  unscoped effort (`pnpm db:migrate && pnpm db:seed`, or a `pg_dump`/`pg_restore`, against the new
  instance's *external* connection string with a temporary `ipAllowList` entry, the same pattern
  documented in `memory-bank/techContext.md`).
- **Irreversible?** The old hand-built service/database are untouched either way — nothing here
  deletes them. The new resources are simple to tear down (`terraform destroy`) if the human
  decides against keeping a second copy.

### Recommendation

**Option A (import)**, once someone is prepared to spend the one or two reconciliation rounds
noted above. It has no data-migration step, doesn't create a second live copy of the app to
confuse anyone loading `ship-rr6m.onrender.com` from memory, and starting from the resources that
are already seeded and already the graded deliverable's live URL is strictly less risky than
standing up a parallel service and migrating data across. Option B only makes sense if the
maintainer specifically wants a from-scratch, Terraform-native service (e.g. because the
hand-built one accumulated drift that's easier to abandon than reconcile) and is willing to own
the CORS/DNS/data-migration follow-up that comes with it.

**This decision is not made by this PR — flagged in the PR body as
"HOLD FOR HUMAN: apply/import decision (gate 2)".**

## Verification performed

```bash
cd terraform/render
terraform init              # downloads render-oss/render 1.9.1, writes .terraform.lock.hcl (committed)
terraform validate
terraform fmt -check -recursive .
terraform plan -var-file=terraform.tfvars   # real credentials, real plan; see plan/plan-annotated.md
```

Terraform binary: temp-downloaded `1.9.8` (darwin_arm64) into the session scratchpad, matching
`audit/terraform/baseline.md`'s own methodology (`required_version` here only demands `>= 1.9.0`,
consistent with that baseline's finding that the repo's pinned `1.6.0` cannot `init` at all,
TF-3). The binary is not committed; see the PR description for the exact `terraform validate` /
`fmt -check` results and the redacted plan capture.
