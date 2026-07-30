# Import log — live service adopted into Terraform (2026-07-30)

Maintainer decision (2026-07-30): adopt the live, hand-built Render deployment via
`terraform import` rather than a clean-machine `apply` (no duplicate stack, no data loss).

**What ran** (Terraform 1.9.8, RENDER_API_KEY from gitignored `.env`, state local + gitignored):

1. `terraform import render_web_service.ship srv-d9kf2t942hec73aofrt0` — success.
2. `terraform import render_postgres.ship dpg-d9kgth6417fc7386hhh0-a` — success.
3. Post-import plan #1: `1 to add, 1 to change, 1 to destroy` — the destroy was
   `render_postgres.ship` forced-replaced by `database_name = "ship"` vs the live
   auto-generated `ship_34oc`. NOT applied. Reconciled by changing the variable default
   to the live value (a replacement here would have destroyed the seeded database).
4. Post-import plan #2: `0 to add, 1 to change, 0 to destroy` — the service's
   `environment_id` would have been detached (config omitted it), plus Render-assigned
   display fields churning as "(known after apply)". Reconciled by declaring
   `environment_id` and `lifecycle.ignore_changes` on the Render-assigned fields.
5. Final plan: **"No changes. Your infrastructure matches the configuration."**
   Captured verbatim in `post-import-plan-no-changes.txt`.

`terraform apply` was never run. The live service was never modified — import writes
only to this config's local state. Undo path: `terraform state rm render_web_service.ship
render_postgres.ship`.
