# Captured `terraform plan` — `terraform/render/` (TF-10 / TRO-299)

**Date:** 2026-07-30 · **Terraform:** `1.9.8` (darwin_arm64, temp-downloaded into the session
scratchpad, not committed — same methodology as `audit/terraform/baseline.md` and PR #41).
**Provider:** `render-oss/render` `1.9.1`, resolved via `terraform init` against the pinned
`required_providers` block, authenticated with the real `RENDER_API_KEY` from the gitignored
repo-root `.env` (`set -a; source ../../.env; set +a`), `render_owner_id` defaulting to the
verified `tea-d9kevetg1s2s73807n5g`.

```
cd terraform/render
terraform init -input=false
terraform validate
terraform fmt -check -recursive .
set -a; source ../../.env; set +a
terraform plan -var-file=terraform.tfvars -input=false
```

## Redaction check performed

Before writing this file, the raw captured output was grepped for: `postgresql://` (connection
strings), the literal value assigned to `session_secret` in the local (gitignored)
`terraform.tfvars`, the Render API key prefix pattern (`rnd_`), and `bearer`/`authorization`
(case-insensitive). **None matched.** Terraform's own plan renderer already replaces every
attribute the provider schema marks `Sensitive` with the literal string `(sensitive value)` —
`connection_info` (which is where `DATABASE_URL`'s value comes from) and all three `env_vars`
entries render this way below, so the plan text never contained the real values in the first
place. ANSI color codes were stripped for readability; the two trailing lines with a local
scratchpad file path (`terraform apply "<path>"`) were removed since they're a local machine
path, not content — the plan itself is otherwise unedited.

## Full output

```text
Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # render_postgres.ship will be created
  + resource "render_postgres" "ship" {
      + connection_info           = (sensitive value)
      + database_name             = "ship"
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

Plan: 2 to add, 0 to change, 0 to destroy.

Changes to Outputs:
  + database_id     = (known after apply)
  + web_service_id  = (known after apply)
  + web_service_url = (known after apply)
```

## Annotation — one sentence per resource

| Resource | Action | What it is | Blast radius | Safe or risky |
|---|---|---|---|---|
| `render_postgres.ship` | **create** | A new, empty Render Postgres 16 instance (free plan, oregon) — not the same object as the live `ship-db` (`dpg-d9kgth6417fc7386hhh0-a`), since this config's state is empty and nothing was imported. | If this plan were applied, it stands up a **second**, unseeded database alongside the real one — no destructive effect on the existing live database, but a confusing duplicate and (until reconciled) not the database the live app actually uses. | **Safe as a plan** (read-only, nothing created); **risky to blindly apply** without first deciding import-vs-parallel per the adoption memo in `terraform/render/README.md`. |
| `render_web_service.ship` | **create** | A new, empty-state Render docker web service (free plan, oregon, this repo/branch/Dockerfile) — again a distinct object from the live `srv-d9kf2t942hec73aofrt0`, for the same reason. | If applied, a **second** live URL would start serving traffic under a new generated slug, pointed at the new (empty) database above — not a modification or deletion of the existing live service. | **Safe as a plan**; **risky to blindly apply** for the same reason — see adoption memo. |

**Why "2 to add" and not "0 changes" or a collision error.** This is the *expected* outcome
described in the ticket brief and `terraform/render/README.md`'s adoption memo: this plan-only
exercise never ran `terraform import`, so Terraform's state has no record of the hand-built
`srv-d9kf2t942hec73aofrt0`/`dpg-d9kgth6417fc7386hhh0-a` resources at all. It reads as "create
brand-new resources," which is correct given empty state — it is **not** evidence that the config
is wrong, and it is **not** to be "fixed" by importing here (that's the maintainer's call, flagged
in the PR as the gate-2 hold). Render itself does not treat `name` as a unique key, so applying
this plan would not error on a name collision — it would genuinely create a second `ship`/`ship-db`
pair, which is exactly why Option A (import) is the recommended path in the README rather than
Option B (apply).

## `validate` / `fmt` results

- `terraform validate` → `Success! The configuration is valid.` — **no warnings**, unlike the AWS
  root config's pre-existing TF-5 warning (`audit/terraform/baseline.md`); this config has none.
- `terraform fmt -check -recursive .` → exit 0, clean, **after** one formatting pass was applied
  (`fmt` without `-check` fixed indentation-alignment drift in `variables.tf`/`versions.tf` from
  hand-written HCL — recorded here rather than silently rewritten with no note).
- `terraform init` → resolved `render-oss/render` `1.9.1`, "signed by a HashiCorp partner," wrote
  `.terraform.lock.hcl` (committed — see `terraform/README.md`'s TF-10 note on why, unlike the
  other `.terraform.lock.hcl` files under `terraform/`, this one is not gitignored).
