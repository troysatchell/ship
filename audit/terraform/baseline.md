## Terraform Plan Review — Baseline

**Commit:** `076a183` · **Date:** 2026-07-27 · **Config:** `terraform/` (AWS: Elastic Beanstalk + Aurora Serverless v2 + VPC + CloudFront/S3 + WAF + SSM). **Terraform:** pinned `1.6.0` (unusable — see TF-3), analysis run on `1.9.8`.

> **Scope reality vs. the brief.** The brief frames this as a Render deployment planned locally. This repo's `terraform/` is **AWS**, not Render, and there is no Render provider anywhere in it. A *live* `terraform plan` is **not runnable** here: the config uses an **S3 remote backend** whose bucket name is stored in SSM (not committed) and the AWS provider needs real credentials — the exercise supplies neither. So the plan/blast-radius analysis below is **static** (reading + `terraform validate`), and the drift demonstration uses the cloud-free **local provider** as the brief specifies. Render is addressed under the improvement target.

### Methodology (reproducible)

```bash
# pinned version fails — record it, then use a current Terraform (required_version is ">= 1.6.0")
terraform 1.6.0: terraform init -backend=false   # → Error: openpgp: key expired (TF-3)
# with 1.9.8, from terraform/ and terraform/environments/prod/:
terraform init -backend=false        # downloads aws 5.100.0 + random 3.9.0, no backend/creds
terraform validate                   # both root and prod: valid, 1 warning (TF-5)
terraform plan                       # → Error: Backend initialization required (s3) — no live plan without creds
# inventory:
grep -rE '^\s*resource\s+"' terraform/*.tf | wc -l          # 74 root resource blocks
grep -rE 'deletion_protection|prevent_destroy|force_destroy|skip_final_snapshot|lifecycle' terraform  # safety attrs
# drift demo (cloud-free) under audit/terraform/drift-demo/, hashicorp/local 2.5.2 pinned
```

Raw outputs: `audit/terraform/raw/{root-init,root-validate,root-plan-attempt,prod-init,prod-validate}.txt` and the drift plans `drift-{1-apply,2-clean-plan,3-drift-plan}.txt`. After running, the `.terraform` cache and the root lock file `init` created were removed so `terraform/` is byte-for-byte unchanged (`git status terraform/` empty).

### Deliverable table

| Metric | Baseline |
|---|---|
| Resource blocks (flat root `terraform/*.tf`) | **74** (actual instances higher — 20 `count`/`for_each` uses across VPC subnets, NAT, route assoc, etc.) |
| Resource blocks (`modules/*`, used by `environments/*`) | 66 |
| Providers | `hashicorp/aws ~> 5.0` (→5.100.0), `hashicorp/random ~> 3.6` (→3.9.0); **unpinned in the flat root** (TF-4) |
| `terraform validate` | root ✅ + prod ✅, each with **1 warning** (uploads lifecycle, TF-5) |
| Live `terraform plan` | **Not runnable** — S3 backend (state bucket in SSM) + AWS credentials required |
| Resources with destroy protection | **1** — only the Terraform **state** bucket (`prevent_destroy`); the Aurora DB and uploads bucket have none (TF-1) |
| Drift detection (local provider) | ✅ demonstrated — clean plan `No changes`, post-tamper plan recreates to declared content |

### Annotated inventory + blast radius

Blast radius is "what happens if this resource is **replaced or destroyed**" (a first/greenfield `apply` just creates everything with no downtime). Ordered worst-first.

**🔴 Tier 1 — data loss / long downtime on replace or destroy (guard these):**
| Resource | What it is | Blast radius / risk |
|---|---|---|
| `aws_rds_cluster.aurora` (`database.tf:34`) | Aurora PostgreSQL 16 Serverless v2 cluster — the production database. | **Highest.** Replacement triggers: `cluster_identifier`, `engine_mode`, `database_name`, `master_username`, `db_subnet_group_name`, encryption. **No `deletion_protection`, no `prevent_destroy`** (TF-1). Destroy → prod takes a final snapshot (recoverable, downtime); **non-prod skips the snapshot → permanent loss**. |
| `aws_rds_cluster_instance.aurora` (`database.tf:68`) | The serverless DB instance in the cluster. | `instance_class`/`engine_version` changes can force replacement/reboot → DB unavailable during the swap. |
| `aws_s3_bucket.uploads` (`s3-cloudfront.tf:374`) | Bucket holding **user-uploaded files** (served via presigned URLs). | Bucket-name change (project/env/account) forces replace → new empty bucket, **old files orphaned**; no `prevent_destroy`. `force_destroy` is unset (good — a destroy of a non-empty bucket fails rather than nuking files). |

**🟠 Tier 2 — service downtime on replace (usually in-place, but replaceable):**
| Resource | What it is | Blast radius / risk |
|---|---|---|
| `aws_elastic_beanstalk_environment.api` (`elastic-beanstalk.tf:97`) | The API's EB environment (Docker on AL2023). | `name`/`solution_stack_name` change → **new environment = API downtime + DNS cutover**. Mitigated by `lifecycle { ignore_changes = [version_label] }` so deploys don't churn it. |
| `aws_vpc.main` + `aws_subnet.*` + `aws_nat_gateway` (`vpc.tf`) | The network everything lives in. | A `vpc_cidr`/subnet CIDR change forces a **replacement cascade** — every dependent resource (DB, EB, SGs) rebuilds. |
| `aws_cloudfront_distribution.frontend` (`s3-cloudfront.tf:108`) | CDN in front of the SPA. | Most edits are **in-place** (5–15 min propagation, no hard outage); replacement is rare. Frontend S3 bucket (`:46`) same profile as uploads but content is redeployable. |
| `aws_acm_certificate.app` (`s3-cloudfront.tf:316`) | TLS cert for the app domain. | Has `lifecycle { create_before_destroy = true }` → **safe rotation** (new cert before old is removed). |

**🟡 Tier 3 — in-place updates, low blast radius:** security groups + rules (`security-groups.tf` — rule edits apply in place), `aws_ssm_parameter.*` (12 params — value change is in-place; **name change replaces**), `aws_rds_cluster_parameter_group` (some params need a reboot), `aws_wafv2_web_acl`/ip_set/regex_set (`waf.tf` — rule updates in place), `aws_kinesis_stream` + realtime log config (`cloudfront-logging.tf`), CloudFront cache/origin-request policies, `aws_cloudfront_function.spa_routing`.

**🟢 Tier 4 — safe no-op / cheap:** all IAM (roles, policies, attachments, instance profile), `aws_cloudwatch_log_group.*`, `aws_flow_log`, route tables + associations, `aws_db_subnet_group`, S3 sub-configs (versioning/SSE/public-access-block), tags. These modify in place or recreate with no user-facing impact.

**App-level blast radius (not infra downtime):** `random_password.session_secret` → regenerating logs out **every** user; `random_password.db_password` → rotates the Aurora master password in place (TF-6).

**Worst-case if `apply` ran right now:** on the *existing* prod stack the dangerous path is any edit that forces **Aurora** or the **uploads bucket** to replace (Tier 1) — unprotected, so Terraform would proceed and cause data loss/downtime. On a *greenfield* account, `apply` simply creates all ~74 resources in dependency order with no downtime (nothing exists to disrupt).

### Drift detection demonstration (cloud-free, `hashicorp/local`)

Config: `audit/terraform/drift-demo/main.tf` manages two local resources (`local_file.app_config`, `local_file.env_file`), provider pinned `local = 2.5.2`.

1. **Baseline** — `apply` then `plan`:
   ```
   Apply complete! Resources: 2 added, 0 changed, 0 destroyed.
   No changes. Your infrastructure matches the configuration.
   ```
2. **Simulated drift** — edited both files *outside* Terraform (`app.config.json` → `"service":"HAND-EDITED-not-via-terraform"`, `replicas:99`; appended `BACKDOOR=1` to `app.env`).
3. **Re-plan detects it** (`audit/terraform/raw/drift-3-drift-plan.txt`):
   ```
   Terraform will perform the following actions:
     # local_file.app_config will be created   (content reset to log_level=info, replicas=2)
     # local_file.env_file   will be created   (content reset, BACKDOOR=1 removed)
   Plan: 2 to add, 0 to change, 0 to destroy.
   ```
   Terraform's refresh saw the on-disk content no longer matches state and planned to **recreate both files back to the declared content** — i.e. an `apply` would *erase* the manual edits (including the rogue `BACKDOOR=1` line). `local_file` reports content drift as recreate (`+ create`) rather than in-place update; the signal is the plan going from `No changes` → non-empty. **Before/after plan output is the pair `drift-2-clean-plan.txt` → `drift-3-drift-plan.txt`.**

*(Render-side drift — changing a setting in the Render dashboard, then `terraform plan` showing the inconsistency — is not reproducible here because no Render provider/config exists in the repo; it belongs to the improvement target below.)*

**Annotation — one sentence per resource.** These two `local_file` resources are the only ones in
this whole audit that appear in a genuinely *saved* plan/apply capture (`audit/terraform/raw/drift-{1-apply,2-clean-plan,3-drift-plan}.txt`) — the AWS resources above are annotated from a **static read of the `.tf` source** (`livePlanRunnable: false` in `baseline.json`; the one live-plan attempt, `root-plan-attempt.txt`, errored on backend init before producing a single resource), so they get the tier/category treatment instead of a per-resource row. These two get the same per-resource, per-`plan-annotated.md`-style treatment as the Render captures:

| Resource | Action(s) observed | What it is | Blast radius | Safe or risky |
|---|---|---|---|---|
| `local_file.app_config` (`audit/terraform/drift-demo/generated/app.config.json`) | create (drift-1) → no-op (drift-2) → recreate (drift-3, after a hand-edit) | A JSON file Terraform writes to local disk holding demo `log_level`/`replicas`/`service` values — a cloud-free stand-in for a real provider resource, used only to demonstrate drift detection without AWS/Render credentials. | No real-world stake in the file itself (it's disposable demo output, `git`-ignored under `generated/`). The stake is what it **demonstrates**: drift-3 shows Terraform's fix for on-disk drift is a **silent overwrite**, not a merge — the hand-edited `service`/`replicas` values were wiped back to the declared content with no prompt or diff-review beyond the plan itself. Read onto the real AWS/Render resources this stands in for: any manual production fix made outside Terraform (e.g. a console tweak to an EB env var or a Render dashboard setting) will be **silently reverted** on the next `apply` unless it is also captured in source. | Safe here (a throwaway local file); the risk is the pattern it proves, applied to stateful resources elsewhere in this inventory. |
| `local_file.env_file` (`audit/terraform/drift-demo/generated/app.env`) | create (drift-1) → no-op (drift-2) → recreate (drift-3, after a hand-edit) | A dotenv-style file (`NODE_ENV`, `FEATURE_FLAG_BETA`), written `file_permission = "0600"` (owner-only, modeling that env files often carry secrets even though this demo's values are dummy). | Same silent-overwrite finding as `local_file.app_config` above — the injected `BACKDOOR=1` line was removed on the next `apply` with no warning beyond the plan diff. Because this resource specifically models an **env file**, the more direct real-world analogue is the Render `env_vars` blocks annotated in `terraform/render/plan/` (e.g. `SESSION_SECRET`) — a value edited by hand outside Terraform (in the Render dashboard) would be reverted the same way on the next `apply`, which for a live session secret means an unplanned mass logout at whatever moment someone next runs `apply`. | Safe here; same caveat as above about what it demonstrates for real secret-bearing resources. |

### Findings (ranked)

1. **TF-1 · High — Prod data stores have no deletion protection.** Aurora cluster + uploads/frontend buckets set neither `deletion_protection` nor `prevent_destroy`; the *only* guarded resource is the Terraform state bucket. One careless `apply`/`destroy` from prod data loss. (`database.tf:34`, `s3-cloudfront.tf:374`)
2. **TF-2 · High — Two divergent root configs for the same infra.** Flat `terraform/*.tf` (has WAF + realtime logging) vs modular `environments/prod` + `modules/*` (does **not**) — separate state, colliding resource names, already drifted on security controls.
3. **TF-3 · Medium — Pinned Terraform 1.6.0 can't `init`** (expired provider-signing key); a clean-machine bootstrap at the repo's own pin fails. Bump `.terraform-version` (allowed by `required_version >= 1.6.0`).
4. **TF-4 · Medium — Flat root has no committed `.terraform.lock.hcl`;** providers float (`~> 5.0` → 5.100.0). The modular paths are properly locked.
5. **TF-5 · Medium — uploads S3 lifecycle rule lacks `filter`/`prefix`** → `validate` warning today, provider error tomorrow.
6. **TF-6 · Low — Secret generators have no `keepers`;** regenerating `session_secret` logs out all users, `db_password` rotates the DB master password (blast-radius note, not a defect).

**Positives worth recording:** `storage_encrypted = true` on Aurora; S3 SSE + public-access-block + versioning on every bucket; VPC flow logs; WAFv2 on CloudFront; DB and app in private subnets; secrets as SSM `SecureString`; ACM cert `create_before_destroy`; state bucket hardened (prevent_destroy + versioning + encryption); backend `encrypt = true`; EB `ignore_changes = [version_label]` so deploys don't fight Terraform.

### Improvement target (plan — not built in this baseline phase)

The user scoped this step to documentation only, so the improvement configs are **not** written here. When the improvement phase runs, the target is:

1. **Local-provider config, ≥2 local resources, pinned provider** — `audit/terraform/drift-demo/main.tf` already satisfies this (2 `local_file` resources, `local = 2.5.2`, `terraform plan` matches intent). Promote/rename it as the deliverable.
2. **Render-provider config** declaring a Render web service that deploys the ShipShape fork, provider pinned (`render-oss/render`), deployable from a clean machine via `terraform apply` — this **replaces** the current `scripts/deploy.sh` (Elastic Beanstalk) manual flow. New work; needs a Render API key.
3. Both configs: **pinned provider versions**, `terraform plan` confirmed against intent, committed lock files (closing TF-4 for the new configs by construction).
