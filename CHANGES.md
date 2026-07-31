# CHANGES

Every improvement made to Ship during the ShipShape sprint: what was added, how to run it, and
how to roll it back. Newest first. One entry per ticket; the ticket ID is the join key to Linear,
to `audit/AUDIT_REPORT.md`, and to the branch that carried it.

Assignment rule 8. `scripts/factory/gate.sh` fails any branch that does not add an entry here.

---

## TRO-301 (ERR-17) — the document-by-id query hardcoded `retry: false`, so a throttled (429) read failed permanently on the first attempt

**Not one of the original 68 audit findings** — a post-baseline Linear ticket, no
`audit/AUDIT_REPORT.md` section.

**The ticket's premise, checked against the file before acting on it.** The ticket described
`UnifiedDocumentPage.tsx`'s document query as throwing a plain `Error` with no `.status`, so even
without `retry: false` the shared `errorStatus()`/`shouldRetryRequest` predicate (queryClient.ts,
built for TRO-172/API-1) couldn't classify a 429 as throttling. That part of the premise is
**stale**: PR #51 (`51f6c2e`, TRO-290/ERR-14) already attached `.status` to the thrown error, as a
side effect of telling a 404 apart from other fetch failures for the deletion-notice fix. Reading
the current file (`git show 51f6c2e -- web/src/pages/UnifiedDocumentPage.tsx`) confirms it. The
**only** remaining defect is `UnifiedDocumentPage.tsx:86`'s own `retry: false`, which overrides
that shared policy regardless of what the thrown error carries.

**Root cause.** `web/src/pages/UnifiedDocumentPage.tsx`'s top-level `useQuery(['document', id])` set
`retry: false` as a per-query override. `queryClient`'s `defaultOptions.queries.retry` is
`shouldRetryRequest`, which backs a 429 off across the server's 60s rate-limit window
(`THROTTLE_RETRY_DELAYS_MS`) instead of dropping it — exactly the policy TRO-190/ERR-3 already gives
every mutation. The per-query `retry: false` silently opted this one read out of it, so a throttled
document load failed for good on the very first attempt.

**What changed.** Removed the `retry: false` override from the query options (no `retry`/`retryDelay`
set at all — same pattern `PersonEditor.tsx`'s `updatePersonMutation` already uses for its write
path). The query now inherits `queryClient`'s shared policy: a 429 retries with backoff, and every
other 4xx (including 404) is still treated as permanent on the first attempt. The `queryFn`'s
`.status` attachment was not touched — it was already correct.

**Preserved: ERR-14's deleted-document handling (PR #51).** `isNotFoundError` classifies 404 as a
permanent 4xx under `shouldRetryRequest`, so a deleted document still fails immediately with no
retry storm, and the existing effect that routes a 404 into `notifyDocumentGoneOnRead` /
`useDocumentWriteStatus`'s one-shot deletion notice is unchanged. Verified explicitly: reran
`UnifiedDocumentPage.deletedFocusRefetch.test.tsx` after this fix — both cases still pass (2/2).

**Regression test — `web/src/pages/UnifiedDocumentPage.throttledRead.test.tsx`** (vitest, run by the
gate). Drives the real `queryClient` singleton and real timers, like the ERR-14 test:

1. A 429 on the first fetch, then a 200 on the retry — asserts the editor eventually mounts and the
   document was fetched more than once (real backoff, ~2-3s, `waitFor` given an 8s window).
2. A 404 on the first fetch — asserts the "not found" screen appears immediately and the document
   was fetched exactly once, with no growth in call count across 5 flushed microtask/macrotask
   turns (a 404 disables retry synchronously, so there's no backoff window to wait out).

Confirmed red first, for the right reason: reverting `UnifiedDocumentPage.tsx`'s query options back
to `retry: false` (`git checkout HEAD -- web/src/pages/UnifiedDocumentPage.tsx`, since the fix was
still uncommitted) and rerunning — test 1 failed with the page stuck on "Failed to fetch document"
and `docCallCount` never advancing past 1 (timed out waiting for `editor-mounted`); test 2 still
passed, because 404 handling doesn't change with this fix. Restored the fix and reran: both green.

Also checked the ticket's literal premise directly: temporarily combined "no `.status` attached" (the
pre-ERR14 `queryFn`) with "`retry: false` removed" and reran the 404 case alone — it *did* regress
into a retry storm (stuck on "Loading...", no `.status` means `shouldRetryRequest` treats the error
as un-classified and retries up to `DEFAULT_MAX_RETRIES`). That confirms why the (b) test matters as
a standing regression guard even though it doesn't flip red→green on this specific one-line diff in
the current, already-`.status`-carrying codebase.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run src/pages/UnifiedDocumentPage.throttledRead.test.tsx
```

**Rollback.** Revert the commit on `fix/err-17-document-query-retry` touching
`UnifiedDocumentPage.tsx`'s query options (re-adds `retry: false`) and delete
`UnifiedDocumentPage.throttledRead.test.tsx`. No other files changed.

---

## TRO-294 — direct-to-ALB health check URL in `.claude/CLAUDE.md` corrected to the CloudFront-fronted path

**Docs-only, priority Low, no vitest path applies (regression-test evidence below instead).**

**What was wrong.** `.claude/CLAUDE.md`'s Deployment section documented the prod API health check
as `http://ship-api-prod.eba-xsaqsg9h.us-east-1.elasticbeanstalk.com/health` — a direct hit on the
Elastic Beanstalk ALB's own DNS name, bypassing CloudFront. TF-7/TRO-278 (already merged, see that
entry above) restricted the ALB security group (`terraform/security-groups.tf`) to CloudFront's
origin-facing prefix list, `data.aws_ec2_managed_prefix_list.cloudfront_origin_facing`. Once that
SG is actually applied to a live account, a direct connection to the ALB URL times out for most
clients — the DNS name itself still resolves; the security group silently drops the TCP connection
because it isn't sourced from CloudFront's IP ranges. Either way, not an API-health problem: the
network path is blocked. TRO-278's own
CHANGES.md entry called this out as DERIVED and explicitly left it for a human/follow-up ticket to
fix; this ticket is that follow-up.

**What changed.** `.claude/CLAUDE.md`'s Prod API health check now reads
`https://ship.awsdev.treasury.gov/health`, with a note explaining why the old URL breaks and where
the replacement comes from.

**How I confirmed the new URL (observed, not invented).** Read `terraform/s3-cloudfront.tf`
directly: the `dynamic "ordered_cache_behavior"` block with `path_pattern = "/health"` (only
created `for_each = var.eb_environment_cname != "" ? [1] : []`) targets `target_origin_id =
"EB-API"` — CloudFront already proxies this exact path to the same Elastic Beanstalk origin the
old URL hit directly. The domain to use is `var.app_domain_name` (`terraform/variables.tf`) when
set, else the CloudFront-assigned domain exposed as the `cloudfront_domain_name` output
(`terraform/outputs.tf`); the `frontend_url` output already picks the right one of the two
(`var.app_domain_name != "" ? "https://${var.app_domain_name}" : "https://${aws_cloudfront_distribution.frontend.domain_name}"`).
`ship.awsdev.treasury.gov` is prod's `app_domain_name` value — corroborated by every other prod
reference in the repo (`.claude/CLAUDE.md`'s own "Prod Web" line just below the edit,
`audit/AUDIT_REPORT.md`, `memory-bank/techContext.md`, `docs/fpki-auth-client-dcr-analysis.md`'s
OAuth redirect URI), not by a fresh `terraform output` (no AWS credentials / apply available here,
same constraint TF-7's own work noted). **Not verified:** whether the ALB SG restriction has
actually been `apply`'d to the live prod account yet. `memory-bank/progress.md` records two
*separate* 2026-07-28 checks, not one combined result: `ship.awsdev.treasury.gov` (the domain this
PR's new health-check URL uses) returned **HTTP 403** — the request reached an HTTP endpoint and
was refused, which is not evidence of an unreachable network path — but confirms only that the
viewer-facing hostname returned an HTTP response; it does **not** confirm CloudFront reached the
`EB-API` origin, since CloudFront or an upstream policy can reject a request before origin access.
The old direct-ALB
hostname (`ship-api-prod...elasticbeanstalk.com`) returned **no response at all** — a different,
stronger signal, closer to what TF-7's SG restriction would actually produce. Neither result
confirms the SG restriction is live in prod; the new URL could not be curled end-to-end to verify
from here.

**Regression-test note.** Pure documentation change; neither vitest project (`api/src/**/*.test.ts`,
`web/src/**/*.test.ts(x)`) has a path to assert against a markdown string, so no test file is added.
`scripts/factory/gate.sh`'s G6 (regression-test present) is expected to fail on this branch for that
reason — the evidence for the fix is the terraform cross-reference above, not a test.

**How to roll it back.** `git revert <commit>`, or manually restore the old two-line health-check
list in `.claude/CLAUDE.md`. This is a docs-only revert — it restores the stale URL text but does
**not** undo the TF-7/TRO-278 ALB security-group restriction that made the URL stale; that lives in
a separate, already-merged change (`terraform/security-groups.tf`) with its own Terraform
apply/revert path. No code, schema, or infra changed by this commit either direction.

---

## TRO-234 — [TF-1] Prod Aurora cluster and uploads bucket had no deletion protection

**The problem.** Of the flat root's 74 resource blocks, only the Terraform **state** bucket
(`terraform/bootstrap/main.tf:22-23`) carried `lifecycle { prevent_destroy = true }`. The Aurora
cluster (`terraform/database.tf`, `aws_rds_cluster.aurora`) had neither `deletion_protection` nor
`prevent_destroy`, and the uploads bucket (`terraform/s3-cloudfront.tf`, `aws_s3_bucket.uploads`)
had no `prevent_destroy` either. Both are Tier-1 "data loss on replace or destroy" in
`audit/terraform/baseline.md`'s blast-radius table: a config change that forces replacement of
either (e.g. `cluster_identifier`, `master_username`, or the bucket-name interpolation) would let
Terraform proceed straight to destroying the live production database or every uploaded file,
with no safety stop. (Line numbers in the Linear ticket — `database.tf:34` /
`s3-cloudfront.tf:374` — were current at audit time; TF-2's convergence, already merged, shifted
the Aurora cluster resource to `database.tf:63` by porting in 5 parameter-group settings ahead of
it. Same resource, same defect.)

**What changed.** Two additions, no resource renamed or restructured:

- `terraform/database.tf` — `aws_rds_cluster.aurora` gets `deletion_protection = true`
  (a first-class RDS attribute: the AWS API itself refuses a destroy while set) plus
  `prevent_destroy = true` added to its existing `lifecycle` block (which already carried
  `ignore_changes = [final_snapshot_identifier]` from `TF-7`/`TF-2` work — merged in, not a
  second `lifecycle` block, since a resource may declare only one).
- `terraform/s3-cloudfront.tf` — `aws_s3_bucket.uploads` gets a new
  `lifecycle { prevent_destroy = true }` block. S3 buckets have no `deletion_protection`
  attribute in the AWS provider (that concept is RDS-specific), so `prevent_destroy` is the only
  available guard — same pattern already used on the state bucket.

**Deliberate consequence, not a surprise.** Both resources now require a config change before an
intentional teardown, but the two guards are independent and **both** must be removed:

- `terraform/s3-cloudfront.tf` (uploads bucket): removing `lifecycle { prevent_destroy = true }`
  only permits Terraform to *attempt* the deletion — it doesn't make the deletion succeed. The
  bucket has versioning enabled (`aws_s3_bucket_versioning.uploads`) and does not set
  `force_destroy`, and no Terraform resource manages object cleanup for it. Before destruction, an
  operator must also empty the bucket by hand: every object, every object version, and every
  delete marker, or the destroy call fails on a non-empty bucket regardless of `prevent_destroy`.
- `terraform/database.tf` (Aurora cluster): **two separate safeguards**, not one.
  `lifecycle { prevent_destroy = true }` is Terraform-side, same as the bucket — but
  `deletion_protection = true` is a distinct, first-class RDS attribute enforced by the **AWS API
  itself**, independent of Terraform. Removing only `prevent_destroy` from the config is not
  enough: AWS will still refuse the `DeleteDBCluster` call. An operator must apply a config change
  that sets `deletion_protection = false` *and* removes `prevent_destroy`, then run the destroy —
  in that order, since the API-level flag has to flip before AWS will honor a destroy at all.

That extra step is the entire point of this ticket (TF-1's finding is literally "one careless
apply/destroy from prod data loss"); it is called out here — accurately, for both resources — so
it isn't rediscovered as a mystery blocker during a future teardown.

**What did NOT change.** No other flat-root resource, and no module. `terraform/modules/aurora`
(used by `terraform/environments/dev` and `terraform/environments/shadow`, kept per TF-2's
convergence decision) has the same gap — no `deletion_protection`/`prevent_destroy` on its own
`aws_rds_cluster` — but dev/shadow are non-prod, TF-1's finding and the Linear ticket both scope
explicitly to the flat root's two named resources, and touching the module is out of scope for
this ticket. Flagging it as a follow-up candidate, not fixing it here.

**How to run it.**

```bash
# Terraform binary: temp-downloaded 1.9.8 to a scratch dir (matches audit/terraform/baseline.md
# and the TF-2/TF-3 precedent; the repo's pinned 1.6.0 cannot `init` at all — TF-3, expired
# provider-signing key). Not committed to the repo.
cd terraform
terraform init -backend=false -input=false
terraform validate       # Success! same single pre-existing TF-5 warning, before and after
terraform fmt -check -recursive .   # exit 0, no formatting changes needed
terraform plan            # Error: Backend initialization required (s3) — expected; no AWS
                           # credentials or remote-state bucket are available here, matching
                           # audit/terraform/baseline.md's documented "Live plan not runnable"
rm -rf .terraform .terraform.lock.hcl   # leaves `git status terraform/` clean, per audit methodology
cd ..
grep -n 'deletion_protection\|prevent_destroy' terraform/database.tf terraform/s3-cloudfront.tf
```

**Verification note.** `terraform validate` was run on the flat root before and after this change
with the same 1.9.8 binary: both report `Success!` with the identical single pre-existing warning
(TF-5, the uploads-bucket lifecycle-rule `filter`/`prefix` warning) — this change introduces no
new warnings or errors. `terraform plan` fails identically before and after with "Backend
initialization required" (no S3 backend/creds available in this environment) — this is the
documented, expected failure mode from `audit/terraform/baseline.md`, not a regression caused by
this change. **No `terraform apply` was run against any account, live or otherwise** — this PR is
config-only, per the escalation-gate-2 rule against irreversible/outward-facing actions.

**No vitest regression test applies.** This is a Terraform-only, infrastructure-as-code change;
there is no application code path to exercise and nothing importable into `api/src/**/*.test.ts`
or `web/src/**/*.test.ts(x)`. The evidence for "before: unprotected, after: protected" is the
`grep` above — 0 matches across these two files before this change; 3 after, each attributable to
a specific line: `database.tf:72` (`deletion_protection = true`, the Aurora cluster),
`database.tf:95` (`prevent_destroy = true`, the same Aurora cluster's `lifecycle` block), and
`s3-cloudfront.tf:382` (`prevent_destroy = true`, the uploads bucket) — plus the
`terraform validate`/`plan` output showing the config stays syntactically valid. `gate.sh`'s
regression-test check is expected to fail honestly here, following the TF-2/TF-3 precedent in
this factory, rather than have a fake vitest file manufactured to satisfy it.

**Rollback.** `git revert` the commit(s) on `fix/tf-1-deletion-protection`. This removes
`deletion_protection` and both `prevent_destroy` blocks, returning to the pre-TRO-234 unprotected
state. No live AWS state is touched either way, since no `apply` was ever run.

---

## TRO-292 (TF-9) — Removed committed binary `tfplan` from `terraform/environments/shadow/`; closed the `.gitignore` gap for the whole `environments/` family

**Post-baseline, not one of the 68 audit findings — no `AUDIT_REPORT.md` section.** Full spec was
the Linear ticket body.

**What was wrong.** `terraform/environments/shadow/tfplan` was a git-tracked ~28.5KB binary
Terraform plan artifact in a public repo. A `strings` scan found no password/secret/token/key
patterns, but that's a pattern scan of a binary, not proof of absence — moot anyway, since scope
here was drift, not a secret-exposure claim. Root cause: the root `.gitignore`'s
`terraform/*.tfplan` / `terraform/tfplan` rules (lines 72-73) are anchored one directory deep — no
`**` — so they never matched anything under `terraform/environments/<env>/`. The TF-10/TRO-299
Render fix added `terraform/render/*.tfplan` / `terraform/render/tfplan` for that one subdirectory
for the same reason, but the `environments/` family (which already had its own generalized
`environments/*/terraform.tfvars` and `environments/*/.terraform.lock.hcl` rules) was never given
the equivalent for `tfplan`. Nothing pattern-scans plan files for secrets before commit, so this
class of drift (tfplan → public repo) can recur on any new environment directory.

**What changed.**
- Removed `terraform/environments/shadow/tfplan` with `git rm` (not `git rm --cached` — that flag
  only unstages a file from the index and leaves it sitting on disk, untracked; the goal here was
  removing it from the working tree too, which plain `git rm` does in one step, confirmed by
  `git show f60ab9b --stat` reporting the file deleted and its absence from `ls` afterward).
- Added `terraform/environments/*/*.tfplan` and `terraform/environments/*/tfplan` to the root
  `.gitignore`, next to the existing `environments/*/terraform.tfvars` /
  `environments/*/.terraform.lock.hcl` lines — same glob family, so it also covers
  `terraform/environments/dev/` and any future environment, not just `shadow/`.

**Explicitly out of scope (by ticket design):** rewriting git history to purge the blob from prior
commits. The file remains recoverable from history; only future drift is stopped. No other
Terraform files were touched, and no `terraform apply`/`plan` was run.

**How to run it / verify.**

```bash
# proves tfplan is gone from the index, not just from `git status` output:
git ls-files --error-unmatch terraform/environments/shadow/tfplan   # exits 1: not tracked
# throwaway regression check (no vitest path applies — this is repo hygiene, not app code):
head -c 2000 /dev/urandom > terraform/environments/shadow/throwaway.tfplan
git status --short                                   # throwaway *.tfplan file does not appear
rm terraform/environments/shadow/throwaway.tfplan
git check-ignore -v terraform/environments/shadow/newplan.tfplan   # matches the *.tfplan rule
# the .gitignore change also added a second, extensionless rule
# (terraform/environments/*/tfplan) — exercise that one separately, since the
# *.tfplan checks above never touch it:
touch terraform/environments/shadow/tfplan
git status --short                                   # bare-name file does not appear either
git check-ignore -v terraform/environments/shadow/tfplan   # matches the extensionless rule
rm terraform/environments/shadow/tfplan
```

**How to roll it back.** `git revert <the tfplan-removal commit>` re-creates
`terraform/environments/shadow/tfplan` from the parent commit **and re-tracks it** — `revert`
commits the inverse diff, so the file comes back staged and committed, not just present in the
working tree. Verified empirically (disposable repo: delete-then-revert leaves the file in
`git ls-files` with a clean `git status`) before writing this, since the first draft of this
paragraph asserted the opposite and was wrong — flagged by CodeRabbit review on this same PR.
The `.gitignore` lines revert normally either way.

---

## TRO-236 — [TF-3] Pinned Terraform 1.6.0 can no longer `init`; bumped to current 1.15.8

**What was broken.** `terraform/.terraform-version` (`d826517`) pinned Terraform to `1.6.0`.
HashiCorp's provider-signing key valid at that historical release has since expired, so `terraform
init` on a clean machine fails installing *any* provider — `hashicorp/random` and `hashicorp/aws`
both error `error checking signature: openpgp: key expired`. Reproduced verbatim against the flat
root (`terraform/`) with a freshly downloaded `1.6.0` binary (no cached provider plugins, no prior
`.terraform/`). Every root config that reads this pin (there is exactly one `.terraform-version`
file in the repo, and `TRO-235`/TF-2 already converged the flat root as the sole AWS root, so
`environments/prod` no longer exists to hold a second copy) inherits the same failure via tfenv's
upward directory search: `terraform/` (flat root), `terraform/environments/dev`,
`terraform/environments/shadow`, `terraform/bootstrap`, and `terraform/render` (added since the
baseline audit, by TF-10) all resolve to `terraform/.terraform-version` since none of them carries
its own copy.

**What changed.** Bumped `terraform/.terraform-version` from `1.6.0` to `1.15.8` — the current
stable release (verified via `https://checkpoint-api.hashicorp.com/v1/check/terraform` and GitHub's
`releases/latest`, published 2026-07-08, not a prerelease). No `required_version` constraint
changed: the flat root, `bootstrap`, `dev`, and `shadow` all declare `>= 1.6.0` (a floor, already
satisfied), and `terraform/render` declares `>= 1.9.0` (also satisfied by `1.15.8`; a lower bump
like `1.9.x` would have worked for the AWS roots but this repo also has to satisfy render's higher
floor, and it made no sense to leave `.terraform-version` sitting mid-way between two roots'
requirements when "current release" is what the finding asked for).

**How to run it.**

```bash
# each line runs in its own subshell so `cd` never persists into the next line
# (a shared `cd terraform` followed by a relative `cd terraform/environments/dev`
# would resolve to the nonexistent terraform/terraform/environments/dev)
(cd terraform && terraform init -backend=false)   # flat root — no AWS creds/backend needed to prove init
(cd terraform/environments/dev && terraform init -backend=false)
(cd terraform/environments/shadow && terraform init -backend=false)
(cd terraform/render && terraform init)            # local backend, no -backend=false needed
```

All four succeeded with a freshly downloaded `1.15.8` binary (`Terraform has been successfully
initialized!`), each on a clean run with no pre-existing `.terraform/` or lock file for that
directory (render's pre-existing committed `.terraform.lock.hcl` was reused unchanged — confirmed
via `git status` showing no diff on it). The same `1.6.0` binary against the same flat root, run
first, reproduced the reported failure exactly. `.terraform/` caches and the lock files `init`
generated for the flat root, `dev`, and `shadow` (none of which are committed — see
`.gitignore:67-77`) were removed afterward so `terraform/` carries only the one-line pin change;
`git status --short terraform/` shows `M terraform/.terraform-version` and nothing else.

**Not covered by this ticket.** TF-4 (flat root has no committed `.terraform.lock.hcl` — providers
float) and TF-1 (no deletion protection on prod data stores) are separate findings, untouched here.
No regression test applies — this is a Terraform CLI/tooling pin, not application code; the
before/after `terraform init` transcripts above are the evidence in place of a vitest test, per the
ticket's regression-test note.

**How to roll it back.** `git revert <this commit>` restores `1.6.0` — which will immediately fail
`init` again on any machine trusting HashiCorp's current provider registry, so there is no
scenario where reverting is desirable; it exists only as a mechanical undo.

---

## TRO-299 (TF-10) follow-up — live Render deployment adopted into Terraform state via `import`; post-import plan is a clean no-op

**What was added.** Maintainer decision 2026-07-30 resolved the TF-10 entry's HOLD: adopt the
live, hand-built Render deployment via `terraform import` rather than a clean-machine `apply`
(no duplicate stack, no data loss, no second URL). Both live resources
(`render_web_service.ship` = srv-d9kf2t942hec73aofrt0, `render_postgres.ship` =
dpg-d9kgth6417fc7386hhh0-a) were imported into the config's local, gitignored state. Two
reconciliation rounds followed, exactly as `terraform/render/README.md` predicted:
`database_name` reconciled to the live auto-generated `ship_34oc` (its mismatch forced a
**destructive replacement** in the first post-import plan — never applied), then
`environment_id` declared plus `lifecycle.ignore_changes` on Render-assigned display fields.
Final result: **"No changes. Your infrastructure matches the configuration."**

**How to run it.**

```bash
cd terraform/render
set -a; source ../../.env; set +a   # RENDER_API_KEY (gitignored)
terraform init && terraform plan     # expect: No changes
```

Evidence: `terraform/render/plan/post-import-plan-no-changes.txt` (verbatim capture) and
`terraform/render/plan/IMPORT-LOG.md` (full narrative). `terraform apply` was never run; the
live service was never modified — import writes only local state.

**How to roll it back.** `terraform state rm render_web_service.ship render_postgres.ship`
un-adopts the resources (state-only; the live service is untouched either way). The config
edits (`database_name` default, `environment_id`, `ignore_changes`) revert with
`git revert <commit>`.

---

## TRO-278 — [TF-7] ALB security group locked to CloudFront's prefix list; `trust proxy` hop count made environment-configurable

**HOLD, scoped to the terraform side only — security semantics (gate 6) + infra change (gate 2).**
`terraform/security-groups.tf` and `terraform/elastic-beanstalk.tf` still need human sign-off
before any AWS `apply`. Per the maintainer, that `apply` is **not planned** — the AWS blueprints in
this repo are repo hygiene, not the live deployment. **The `api/src/app.ts` change is NOT held** and
is safe to auto-deploy to the actual live target, Render: see the maintainer follow-up immediately
below for why, and the post-deploy checklist further down for what remains genuinely unverified on
the AWS side.

**MAINTAINER FOLLOW-UP (2026-07-30) — this repo's live deployment is Render, not AWS.** The first
version of this fix set `app.set('trust proxy', 2)` unconditionally. That count is correct only for
the AWS chain analyzed below (`client -> CloudFront -> ALB -> Express`, two hops). This repo's
actual live deployment is **Render** (`terraform/render/web_service.tf`, adopted onto `main` via
TF-10 the same day, `auto_deploy = true`), sitting directly in front of Express with **no CDN
layer** — `client -> Render's proxy -> Express`, ONE hop. Render auto-deploys from `main`, so
merging the unconditional `2` as originally written would have made `req.ip` forgeable (a
client-supplied `X-Forwarded-For` entry trusted as though it were Render's own) on the live demo
site the moment this PR merged — recreating on Render the exact vulnerability this ticket fixes on
AWS.

**The fix:** the hop count is no longer a constant. `api/src/app.ts`'s `resolveTrustProxyHops`
(defined just above `createApp`, called at `app.set('trust proxy', resolveTrustProxyHops(process.env.TRUST_PROXY_HOPS))`)
reads `TRUST_PROXY_HOPS` from the environment, validated as a positive integer, and **defaults to
1** when the variable is unset, empty, or invalid (zero, negative, non-integer, or non-numeric) —
logging a warning rather than crashing or silently trusting a bogus count. 1 is the correct value
for Render and local dev, and is *identical* to what `app.set('trust proxy', 1)` did before this
ticket touched the file at all, because `terraform/render/web_service.tf` sets no
`TRUST_PROXY_HOPS` override — so the default is what actually ships to the live site.
`terraform/elastic-beanstalk.tf` now sets `TRUST_PROXY_HOPS = "2"` for the AWS blueprint (the
CloudFront -> ALB chain below) — inert today since that environment is not live and not planned to
be applied, but present so the blueprint is correct if it ever is.

**Observed** (`terraform/security-groups.tf`, before this change): the ALB security group allowed
ports 80/443 from `0.0.0.0/0` — not restricted to CloudFront — while `api/src/app.ts` set
`trust proxy 1`. Filed from TRO-172's rate-limiter work, whose per-source-IP flood floor
(`perSourceIpLimiter` in `api/src/middleware/rate-limit.ts`) depends on `req.ip` being unspoofable.

**What changed — the security group (`terraform/security-groups.tf`).**

- Added `data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing"`, looked up by AWS's
  well-known name `com.amazonaws.global.cloudfront.origin-facing`.
- The `aws_security_group.alb` ingress rules for ports 80 and 443 now use
  `prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id]` instead of
  `cidr_blocks = ["0.0.0.0/0"]`. Egress and every other resource in the file are untouched.
- **Does anything else legitimately reach the ALB directly?** EB's own health checks travel
  ALB -> EC2 target *inside* the VPC and are unaffected (`aws_security_group.eb_instance`'s
  ingress-from-ALB rule is untouched). The automated deploy monitor
  (`.claude/skills/ship-deploy/SKILL.md`) polls `aws elasticbeanstalk describe-environments`, an
  AWS-API call, not an HTTP hit on the ALB — also unaffected. **DERIVED, breaks after this
  deploys:** `.claude/CLAUDE.md`'s documented manual health check,
  `http://ship-api-prod.eba-xsaqsg9h.us-east-1.elasticbeanstalk.com/health`, is a direct external
  request to the ALB's own DNS name, bypassing CloudFront entirely — it will stop resolving from a
  human's machine once this SG is live. CloudFront already proxies `/health` to `EB-API`
  (`terraform/s3-cloudfront.tf`), so the equivalent check post-deploy is the CloudFront-fronted URL
  instead. Not fixed here (out of this ticket's scope: only `terraform/security-groups.tf` plus the
  `app.ts` hop count); flagged for the human reviewer to decide whether to update that doc.
- **Residual limitation, DERIVED, not fixable by an SG alone:** a prefix-list rule authorizes by
  *network origin*, not by *distribution identity* — any CloudFront distribution, including one an
  attacker creates in their own AWS account with this ALB's public DNS name as a custom origin,
  egresses from the same prefix-list ranges. The standard supplementary control is a shared-secret
  header the app validates, checked only against *this* distribution. Not implemented here — it is
  a defense-in-depth addition beyond this ticket's stated fix direction, not a gap this PR claims to
  close.

**What changed — the trust-proxy hop count (`api/src/app.ts`).**

`terraform/s3-cloudfront.tf` puts the ALB behind CloudFront as a custom origin (`EB-API`), so the
AWS chain is `client -> CloudFront -> ALB -> Express`: **two** reverse-proxy hops, not one.
`trust proxy 1` under-counted by one hop for that chain — verified by reading the installed
`proxy-addr`/`forwarded` packages (not by assumption): with N trusted hops, `req.ip` resolves to the
(N+1)-th `X-Forwarded-For` entry counting from the end, because each honest proxy appends exactly
one entry. At N=1, `req.ip` for legitimate CloudFront-routed traffic would resolve to CloudFront's
own edge-server IP, never the real client — a correctness bug independent of the security-group
finding, *if* AWS were live. It is not (see the follow-up above), which is why `1` is also the
correct value for the deployment that is actually live.
`app.set('trust proxy', 1)` is now `app.set('trust proxy', resolveTrustProxyHops(process.env.TRUST_PROXY_HOPS))`,
which evaluates to `2` only when `TRUST_PROXY_HOPS=2` is set (as `terraform/elastic-beanstalk.tf`
now does for the AWS blueprint) and defaults to `1` everywhere else, including Render and local dev.

**DERIVED, not verified against live traffic** (no AWS credentials/apply available here): AWS's
documented behavior is that the ALB always appends the peer it directly observed to
`X-Forwarded-For` (creating the header if absent), and CloudFront always sets `X-Forwarded-For`
itself with the real viewer IP it observed for a custom origin, regardless of the origin request
policy's header allow-list. Both are load-bearing assumptions behind trusting exactly 2 hops; a
human with AWS access should confirm them post-deploy (checklist below).

**The two AWS-side changes remain paired, not independent — relevant only if that blueprint is ever
applied.** Raising the trusted hop count to 2 there is only safe *because* the ALB would be
unreachable except from CloudFront's ranges. Proven mechanically (not just asserted) by test 3
below: with N=2 and only one real proxy hop actually present — i.e. the security group *not*
enforcing this — a client's own forged `X-Forwarded-For` entry gets trusted as though it were
CloudFront's. Under N=1 (this ticket's default, and what was live before either version of this
fix), the same forged header does **not** work: the honest proxy's own append is always what N=1
selects, regardless of any decoy entries in front of it. That means the finding's literal framing
("a client reaching the ALB directly can choose `req.ip`") was **not yet true under the code as it
originally stood** (`trust proxy 1`) — it becomes true only once the hop count is raised to 2 for an
environment where the SG restriction doesn't also apply, which is exactly why the SG restriction has
to land paired with `TRUST_PROXY_HOPS=2` and not be treated as optional hardening.

**How to run it.** Regression tests live in `api/src/app.test.ts`,
`describe('TF-7: trust proxy hop count')` and `describe('resolveTrustProxyHops')`:

```bash
source .factory-env
pnpm --filter @ship/api test src/app.test.ts
```

`describe('TF-7: trust proxy hop count')` (integration, through a real Express app via supertest):

1. `recovers the real client IP through the CloudFront -> ALB chain, not an intermediate hop
   (TRUST_PROXY_HOPS=2)` — **PIN.** A synthetic 2-entry `X-Forwarded-For` (real client, then a
   CloudFront-edge stand-in) resolves to the real client with `TRUST_PROXY_HOPS=2` set. Passes
   against both the prior hard-coded-`2` commit (which ignored the env var and always behaved as 2)
   and this round's change — only the configuration mechanism moved, not this behavior.
2. `still resolves correctly when only one proxy hop is present` — **PIN**, hop-count-invariant
   (true for any N >= 1); left on the default deliberately.
3. `would trust a forged entry if a client ever reached the ALB directly (why the security-group fix
   is required) (TRUST_PROXY_HOPS=2)` — **PIN**, same reasoning as #1: characterizes an accepted,
   SG-gated risk under explicit `TRUST_PROXY_HOPS=2`, unchanged by this round.
4. `defaults to trusting exactly one hop when TRUST_PROXY_HOPS is unset — the live Render/local-dev
   topology` — **RED BEFORE this round / GREEN AFTER.** Against the prior commit (hard-coded `2`,
   no env var support), this exact assertion fails: `AssertionError: expected '192.0.2.150' to be
   '203.0.113.77'` — it walks past the honest proxy's append and lands on the client's decoy,
   reproducing the Render vulnerability the maintainer flagged. Verified by temporarily restoring
   the pre-round `app.ts` via `git show` (not by inference) and re-running this test in isolation;
   it failed with that exact assertion, not an import error.
5. `falls back to one trusted hop when TRUST_PROXY_HOPS is not a positive integer, rather than
   crashing` — **RED BEFORE / GREEN AFTER**, same mechanism, `TRUST_PROXY_HOPS=0`. Also verified to
   fail (not error) against the pre-round `app.ts`.

`describe('resolveTrustProxyHops')` (unit, the pure function directly) — 3 tests covering the full
validation matrix (unset/empty/whitespace -> 1; valid positive integers, including
whitespace-trimmed; zero/negative/non-integer/non-numeric -> 1 with a logged warning, never a
throw). **New capability, not red-before/pin** — the function did not exist before this round.

All 8 tests pass together post-fix; the full api suite (56 files / 670 tests, against `main` merged
through TF-10/TS-4 and the rest of that day's landings) passes with `scripts/factory/gate.sh
--skip-review`. One run's full-suite pass hit `session-activity-race.test.ts`'s already-documented
load-sensitive flake (lessons.md #24) under the gate's own build+typecheck CPU load; `gate.sh`
reran it standalone and it passed, confirming it, not this change.

**Verification performed here.** `terraform fmt -check` (clean) and `terraform validate` (clean
except the pre-existing, unrelated TF-5 lifecycle warning) against a temp-downloaded
**Terraform v1.9.8** (darwin_arm64; the pinned 1.6.0 cannot `init` — TF-3) with
`init -backend=false`, run against both `security-groups.tf` (unchanged this round) and
`elastic-beanstalk.tf` (this round's `TRUST_PROXY_HOPS` setting). No `plan`/`apply` — no AWS
credentials, no S3 backend access, and the hard safety rule for this ticket forbids both regardless.

**NOT verified — post-deploy human checklist.** All items below are scoped to the AWS blueprint and
apply only if a human ever runs `apply` against it, which per the maintainer is not planned. None of
them block or bear on the Render auto-deploy of `api/src/app.ts`'s change, which needs no post-deploy
verification here: the default (`TRUST_PROXY_HOPS` unset -> 1) is exactly today's live behavior.

- [ ] A direct HTTP request to the ALB (bypassing CloudFront) is refused at the network layer
      (connection refused/timeout), not merely 4xx'd by the app.
- [ ] A real request through CloudFront shows `req.ip` (log it temporarily, or check via
      `X-Forwarded-For` in application logs) equal to the actual client IP, not a CloudFront edge IP.
- [ ] Confirm CloudFront really does insert the true viewer IP into `X-Forwarded-For` for the
      `EB-API` origin regardless of `allViewerAndWhitelistCloudFront`, and that the ALB really does
      append rather than trust incoming XFF content — both assumed from AWS's published behavior,
      not observed here.
- [ ] Decide whether to update `.claude/CLAUDE.md`'s direct-EB-URL health check to the
      CloudFront-fronted `/health` path, since the direct one will stop working (TRO-294).
- [ ] **Before `apply`:** confirm the ALB security group's two new prefix-list-referencing rules
      (80 and 443, both against `com.amazonaws.global.cloudfront.origin-facing`) do not exceed the
      account's "Rules per security group" quota. AWS counts a prefix-list rule against that quota
      as though expanded to one rule per entry in the list, not as one rule — with two rules on the
      same list, this could plausibly exceed the default 60-rule quota outright. Not checked here
      (no AWS credentials/live lookup). See the caution comment above the two ingress rules in
      `terraform/security-groups.tf` and TRO-295 (High — plausible deploy blocker, not cosmetic).
- [ ] `pnpm db:migrate`/deploy itself is unaffected (no schema change here) — this is purely
      infra + one app.ts line.

**CodeRabbit triage (2 findings, both filed as new tickets per `triage.md` — neither is fixable
within this ticket's authorized scope of `terraform/security-groups.tf` + `api/src/app.ts`):**

| Finding | Disposition | Ticket |
|---|---|---|
| `.claude/CLAUDE.md`'s direct-ALB health-check URL goes stale once this ships | NEW TICKET — doc-only, out of scope here | TRO-294 (Low) |
| The two new prefix-list ALB ingress rules may exceed the AWS rules-per-security-group quota | NEW TICKET — real, but the fix needs either live AWS access or editing `elastic-beanstalk.tf`, both out of scope here | TRO-295 (High) |

**Rollback.** `git revert` this commit. By hand: in `terraform/security-groups.tf`, remove the
`cloudfront_origin_facing` data source and restore both ALB ingress rules to
`cidr_blocks = ["0.0.0.0/0"]`; in `terraform/elastic-beanstalk.tf`, remove the `TRUST_PROXY_HOPS`
setting; in `api/src/app.ts`, restore `app.set('trust proxy', 1)` and drop `resolveTrustProxyHops`.
None of this is urgent for the live site — Render is unaffected by any of it, since `app.ts`
already defaults to 1 with `TRUST_PROXY_HOPS` unset and Render's config sets no override. The AWS
pairing rule still applies if that blueprint is ever applied: `TRUST_PROXY_HOPS=2` with the ALB
security group open to `0.0.0.0/0` (i.e. reverting only the SG half) is a spoofable configuration
strictly worse than either the pre-fix state or this fix.

---

## TRO-302 — [API-8] The suspected SHA-256 rate-limiter hash was not the cause of the reported P95 regression

Linear ticket TRO-302 (API-8) asked to confirm and fix a hypothesis from the api-perf compare run
(`audit/api-perf/compare-phase2-jul30/after-phase2-jul30.md`): that `fingerprint()`'s per-request
SHA-256 hash of the session cookie (`api/src/middleware/rate-limit.ts`) explained a +12-18% P95
regression on cheap endpoints at c=25. The compare report itself flagged this as an unverified
hypothesis, not a measurement ("not confirmed with a profiler or a rate-limiter-disabled control
run"). This ticket did that verification. **Verdict: acquitted, on three independent lines of
evidence. No production behavior changed.**

**1. Microbenchmark** (isolated, realistic 64-char session-id cookie): `crypto.createHash('sha256')`
costs **~310 ns/op**; the full `apiRateLimitKey()` path (cookie parse + hash) costs **~650 ns/op** —
about **0.008%** of a 4 ms request.

**2. Live CPU profile** (`node --cpu-prof`, this server, the compare run's own c=25 autocannon load
against `/api/weeks`, 9,000 clean 200-response requests): the server spent **>99% of wall-clock time
idle** (I/O-bound — Postgres round trips dominate, not CPU). Of the small non-idle sliver, functions
matching `fingerprint`/`Hash`/`createHash`/rate-limit accounted for **~0.15%** — smaller than the
tsx/ESM module-loading overhead left over from server startup, itself captured in the same profile.
No `express`/`pg`/`zod`/`compression`/`helmet` function registered meaningfully either.

**3. Controlled live A/B** (same running server, same c=25 autocannon load, back-to-back, on
`documents/:id` / `documents?type=wiki` / `weeks`): three configurations — (a) the real SHA-256
hash, (b) `fingerprint()` patched to a no-op slice (diagnostic only, reverted immediately via
`git checkout`, never committed), (c) **both** rate limiters removed from the chain entirely (also
diagnostic-only, reverted) — produced statistically indistinguishable P50/P97.5/P99. The difference
between any two configurations was smaller than the rep-to-rep noise of *the same unmodified
configuration measured against itself* three times in a row (e.g. `documents/:id` P97.5 ranged
13-31 ms across three consecutive reps of identical code).

**Why the original compare run saw +12-18%: most likely shared-machine measurement noise, not a
code defect.** Supporting evidence, all from artifacts that already existed or were reproduced here:

- The compare report's own recheck of `documents/:id` c=25 swung **+38.4% -> +10.4%** on
  byte-identical code and conditions, same session, minutes apart.
- A fresh, full re-benchmark run in this ticket (below) — same runner methodology, same seed
  data, same code as `main` (nothing changed) — shows P95 deltas **against the phase2-jul30
  compare's own numbers** ranging **-27.2% to +34.8%** across the 18 endpoint/concurrency
  combinations, on code that did not change between the two measurements. That range is as large
  as, or larger than, the originally-reported "regression."
- The regressions were never monotonic with concurrency (present at c10/c25, reversed at c50) and
  not consistent between P50 and P95 (P50 sometimes improved while P95 regressed) — not the
  signature of a fixed per-request CPU cost.
- The machine this ships from is a shared 14-core dev box running 6-10 sibling worktree API
  servers plus this session's own tooling throughout, exactly as both compare runs documented.

**What changed.**

- **No functional/production code changed.** `api/src/middleware/rate-limit.ts`'s `fingerprint()`
  is untouched — a doc comment was added recording this finding (so a future engineer doesn't
  re-chase the same lead; see the DB-1 precedent in this same file for why that matters).
- **Regression-guard tests only** (`api/src/middleware/__tests__/rate-limit.test.ts`, new
  `describe('TRO-302: fingerprint cost stays negligible')`), **pins, not red-before-green** — there
  is no behavior change to prove red first:
  1. `apiRateLimitKey` is synchronous and returns a plain string, not a `Promise` — guards the
     documented design decision that the key generator never verifies the session against the
     database (that would cost a round trip). An `async` key generator would be the first sign that
     decision had quietly been reversed, and would reintroduce a *real* per-request cost.
  2. 100,000 calls to `apiRateLimitKey` complete within a 3000 ms ceiling (measured ~65 ms
     unloaded — >45x headroom, deliberately generous given this suite's documented load-sensitive
     flakes, `ship-factory/references/lessons.md` rule 24). Fails only for a gross regression (a
     slow KDF, a synchronous I/O call), never for ordinary scheduler jitter.
- Full api suite after the change: **664/664 passed** (`pnpm --filter @ship/api test`), up from 662
  — the +2 are the new pins above.

**Re-benchmark — same 6 endpoints, c=10/25/50, `bench-runner-compare.mjs`'s own methodology**
(window-synchronised 900-request bursts, autocannon 8.0.0, 500/20 seed data verified byte-identical
to the compare run's own — `254 issue / 91 wiki / 35 sprint / 32 weekly_plan / 27 weekly_retro / 20
person / 15 project / 15 weekly_review / 6 standup / 5 program`). No code differs from `main` in
this run — the point is to check whether phase2-jul30's regressions reproduce on a fresh
measurement, not to prove a fix:

| Endpoint | c | Baseline P95 | Phase2-compare P95 (Δ vs baseline) | TRO-302 remeasure P95 (Δ vs phase2) |
|---|---|---|---|---|
| `documents?type=wiki` | 10 | 8.45 | 8.83 (+4.5%) | 9.85 (+11.6%) |
| `documents?type=wiki` | 25 | 17.33 | 20.44 (+17.9%) | 19.50 (-4.6%) |
| `documents?type=wiki` | 50 | 44.93 | 37.86 (-15.7%) | 35.69 (-5.7%) |
| `issues` | 10 | 38.78 | 26.66 (-31.3%) | 26.64 (-0.1%) |
| `issues` | 25 | 94.47 | 65.48 (-30.7%) | 62.62 (-4.4%) |
| `issues` | 50 | 182.00 | 110.26 (-39.4%) | 107.52 (-2.5%) |
| `documents` | 10 | 34.01 | 39.30 (+15.6%) | 40.55 (+3.2%) |
| `documents` | 25 | 75.75 | 85.25 (+12.5%) | 85.98 (+0.9%) |
| `documents` | 50 | 146.54 | 144.51 (-1.4%) | 154.98 (+7.2%) |
| `documents/:id` | 10 | 4.84 | 4.64 (-4.1%) | 6.26 (**+34.8%**) |
| `documents/:id` | 25 | 9.16 | 12.67 (+38.3%) | 12.79 (+0.9%) |
| `documents/:id` | 50 | 46.16 | 30.12 (-34.7%) | 38.54 (**+27.9%**) |
| `team/assignments` | 10 | 11.05 | 12.67 (+14.7%) | 10.82 (-14.6%) |
| `team/assignments` | 25 | 22.89 | 22.15 (-3.2%) | 21.41 (-3.3%) |
| `team/assignments` | 50 | 57.28 | 55.03 (-3.9%) | 45.70 (-16.9%) |
| `weeks` | 10 | 7.06 | 8.02 (+13.6%) | 6.46 (**-19.5%**) |
| `weeks` | 25 | 14.18 | 15.09 (+6.4%) | 10.99 (**-27.2%**) |
| `weeks` | 50 | 41.80 | 41.58 (-0.5%) | 36.38 (-12.5%) |

The rightmost column is the load-bearing one: it compares two measurements of **identical code**,
days apart, same machine, same methodology. If the rate limiter's hash (or anything else in the
middleware chain) were a real, fixed per-request cost, this column should hover near 0%. Instead it
ranges **-27.2% to +34.8%** — wider than the +12-18% this ticket was opened to explain.

**Verified against:** `ship-audit-pg` (postgres:15-alpine, `:5433`), `ship_wt_tro_302`, query
logging off (`log_statement=none`, `log_min_duration_statement=-1`), `NODE_ENV=development` (no
`E2E_TEST` override) for the re-benchmark, matching the compare run's own documented conditions.
Background load average 3.2-6.5 across 14 cores throughout, 10 sibling worktree API dev servers
present (idle), consistent with both prior measurement sessions.

**Not verified.** No profiler/A/B run against production-mode (`NODE_ENV=production`) limits — the
key-generation code path is identical regardless of `NODE_ENV`, so this is not expected to matter,
but it was not measured directly. No repeated (n>3) statistical re-run of the full 18-combination
sweep — a single fresh re-measurement is what's reported, deliberately not smoothed into a
multi-run average, so the noise is visible rather than hidden.

**Rollback.** Nothing to roll back functionally — `git revert` on this branch removes only the doc
comment and the two new pin tests.

---

## TRO-209 — [TS-4] 236 non-null assertions on request auth context, all from one optional declaration

`api/src/middleware/auth.ts:11-12` augmented Express's `Request` with `userId?: string` /
`workspaceId?: string` — optional, so every authenticated handler re-asserted `req.userId!` /
`req.workspaceId!`: **236** occurrences across 21 route files. Worse than hygiene: a route
registered *without* `authMiddleware` type-checked identically to one wired up correctly, so a
middleware-ordering mistake would send `undefined` into a query as a user/workspace id rather than
failing to compile.

**What changed — types only, no runtime-behavior change.**

- **`api/src/middleware/auth.ts` (new exports)** — `AuthenticatedRequest` (extends `Request`,
  `userId`/`workspaceId` required `string`), and `authed(handler)`, a wrapper that narrows a plain
  `Request` handler to one whose auth fields are guaranteed present. Register it **after**
  `authMiddleware` (directly, or behind a `router.use(authMiddleware, …)`); `authed()` does not
  authenticate the request itself. Internally it uses a type-guard function
  (`req is AuthenticatedRequest`), not a cast — no `as` of any kind appears in the new code.
  Both `sessions.workspace_id` (`schema.sql`) and `api_tokens.workspace_id`
  (`migrations/014_api_tokens.sql`) are `NOT NULL` columns, and `authMiddleware` always sets both
  fields together before calling `next()` (the API-token branch, the session-cookie branch) — so on
  every currently-registered route the guard inside `authed()` never rejects a real request; it
  exists only so a *future* route wired up without `authMiddleware` fails closed (401) instead of
  silently forwarding `undefined`. Observable behavior for every existing route is unchanged; this
  is stated rather than assumed because the escalation gate on auth changes requires it, and it was
  verified two ways (see Regression tests, runtime pin).
- **21 route files** (`accountability`, `activity`, `admin-credentials`, `admin`, `ai`,
  `api-tokens`, `auth`, `backlinks`, `comments`, `dashboard`, `documents`, `issues`, `iterations`,
  `programs`, `projects`, `search`, `standups`, `team`, `weekly-plans`, `weeks`, `workspaces`) —
  every handler that used to assert `req.userId!`/`req.workspaceId!` is now wrapped in `authed(...)`,
  with the `!` removed and the handler's `req`/`res` parameter types left to contextual inference
  (an explicit `req: Request` annotation on a wrapped handler would silently defeat the narrowing).
  Mechanical, AST-driven change (TypeScript compiler API located every `req.userId!`/`req.workspaceId!`
  node and its enclosing handler; only that handler's wrapping/annotations were touched) — no
  drive-by refactors. 4 test files that fully replace (`vi.mock`) `../middleware/auth.js` needed a
  matching `authed: (handler: unknown) => handler` passthrough added to their mock, since their fake
  `authMiddleware` already sets both fields before `next()` the same way the real one does.

**Regression tests (`api/src/**/*.test.ts`, run by the gate).**

1. **Compile-time** (`api/src/__tests__/auth.test.ts`, new `describe` blocks) — `expectTypeOf`
   proves `AuthenticatedRequest['userId']`/`['workspaceId']` are `string`, and that a handler passed
   to `authed()` receives them already narrowed. A third case pins a `@ts-expect-error` on
   `const userId: string = req.userId` inside a plain (unwrapped) handler. Verified red for the
   right reason: temporarily deleting that suppression comment and running
   `pnpm --filter @ship/api type-check` fails with `TS2322: Type 'string | undefined' is not
   assignable to type 'string'` at that exact line; restoring the comment returns it to clean. (No
   prior version of `authed()` exists to regress against — it's a new type, not a bug fix to an
   existing one — so this direct compile-error demonstration is the red/green proof.)
2. **Runtime, `authed()` itself** (same file) — invokes the wrapped handler when
   `userId`/`workspaceId` are present, and returns 401 without calling the handler when they are
   missing (the defense-in-depth backstop, unreachable on any current route per above).
3. **Runtime pin, a real route** (`api/src/routes/auth.test.ts`) — `POST /api/auth/extend-session`
   is one of the wrapped handlers. Added `should reject extend-session without a session` (401,
   new); the existing, unmodified `should extend session expiry` test already covers the 200 case.
   Both pass after wrapping, pinning that `authed()` changed nothing observable on a real endpoint.

**Measurement.** The audit's own methodology (`audit/AUDIT_REPORT.md`, TS-4 / Type Safety
Methodology section) defines **three different counts** here, and they move very differently — the
gap matters and is reported rather than smoothed over:

| Metric | Command | Before (`main` @ `42e60d9`) | After |
|---|---|---|---|
| `req.userId!` / `req.workspaceId!` occurrences | `grep -rEn 'req\.(userId\|workspaceId)!' api/src` | **236** | **0** |
| Corrected non-null, `api` (audit's own de-bugged pattern) | `grep -rEn '[a-zA-Z0-9_)]]?!(\.\|\[\|\)\|,\|;\|\s*$)' api` | 286 | **53** |
| Tracked non-null, `api` (`count.sh`'s pattern, the one the 1535-total/384-target is defined on) | `bash ~/.claude/skills/type-safety-audit/scripts/count.sh api` | 42 | **42 (unchanged)** |

All three commands were run with `/usr/bin/grep` explicitly (or via `bash script.sh`, which resolves
`grep` the same way) — the audit's own methodology warns that pasting these into an interactive zsh
resolves `grep` to a `ugrep` shim that parses bracket expressions differently and returns wrong
numbers for the bracket-heavy patterns; confirmed directly (`echo 'req.userId!;' | grep -E
'<tracked-pattern>'` matches under the zsh shim, does not match under real `/usr/bin/grep`).

**The corrected-count delta is -233, not -236**, because 3 of the 236 fixed lines
(`issues.ts:1171,1684,1912`) also contain an unrelated, pre-existing `id!` assertion earlier on the
same line (`logDocumentChange(id!, ...)`), and both the tracked and corrected patterns count
*matching lines*, not occurrences — those 3 lines still match after `req.userId!` is removed, for a
reason this ticket doesn't touch.

**The tracked count is unchanged, and this contradicts the audit's own improvement-plan table and
this ticket's brief — both should be corrected.** The audit's Methodology section documents that
BSD grep's bracket expression in the tracked `non_null_assertions` pattern
(`[a-zA-Z0-9_\)\]]!(\.|\[|\)|,|;|\s*$)`) treats the escaped `)`/`]` inside `[...]` literally, closing
the class early so the pattern effectively requires a literal `]` immediately before `!` — meaning
`req.userId!`/`req.workspaceId!` (no `]` before the `!`) were **never counted by the tracked
pattern in the first place**, before this fix touched them. The audit's own recommended-improvement
table lists "TS-4 | 236" as violations retired toward the 1535-total/384-target, and this ticket's
brief inherited that framing ("TS-1 + TS-4 alone clear the 384-site bar") — both are describing the
*corrected*-metric significance of TS-4 (which the finding's own prose does: "82% of api's 288
corrected non-null assertions") as if it were the *tracked* metric the target is literally defined
on. Measured directly: it is not. This ticket retires all 236 real occurrences and closes the
authz-scoping compile-time hole described in the finding — that result stands — but it moves the
audit's literal 1535/384 tracked-total arithmetic by zero.

A live re-run of `count.sh` across `web api shared` on `main` @ `42e60d9` (i.e., with TS-1/TS-2/TS-3/
TS-6 already merged, before this fix) gives a tracked total of **1747** (60 `any` + 1639 `as` + 47
non-null-tracked + 1 ts-ignore) — *higher* than the audit's original 1535 baseline, because ~30+
unrelated tickets merged since the audit snapshot (confirmed independently by TRO-206/TS-1's own
CHANGES.md entry, which found the same drift reproducing *its* command: 102 baseline errors became
156). This means a live "current total vs. 1535" snapshot cannot cleanly demonstrate the category's
cumulative progress — unrelated development moves it in both directions — so each ticket's
contribution has to be read from its own controlled before/after diff. This ticket's diff, read that
way: 236 real assertions retired (occurrence-exact), 0 movement on the metric the 384 target is
literally defined on, `explicit_any`/`as_any` unchanged (36/128, `api`), and `as_assertions` moved
1107 → 1112 (`api`, +5) — verified by diffing the *content* of every newly-matching line (not just
the line-number-prefixed text, which shifts when unrelated lines above are inserted): all 5 are
comment/test-description prose ("as its own type", "as a required string", …), the same
over-count class the audit's own methodology documents (~15-20% of raw `as` hits are imports/
comments), not real type assertions — `git diff` for `\bas any\b|: any\b|as unknown as` is empty.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api type-check
pnpm --filter @ship/api exec vitest run \
  src/__tests__/auth.test.ts \
  src/routes/auth.test.ts
pnpm test   # full api suite
```

**Rollback.** Revert the commits on `fix/ts-4-nonnull-auth-context`. `authed`/`AuthenticatedRequest`
are additive exports in `api/src/middleware/auth.ts`; reverting the 21 route files and the 4 test
mocks alongside them fully restores the pre-fix `req.userId!`/`req.workspaceId!` state. No schema,
migration, or middleware-ordering change accompanies this fix, so rollback is signature-only.

---

## TRO-183 (DB-6) + TRO-184 (DB-7) + TRO-185 (DB-8) + TRO-187 (DB-10) — the query planner was starved of indexes and honest estimates

Four findings, one root cause: the planner either had no index to use, or had one and could not
see enough to pick it. All four are measured against the audit's seeded volume (500 documents / 20
users / 813 `document_associations` rows, `postgres:15-alpine` on the `ship-audit-pg:5433` Docker
container, via `pnpm db:seed` + `audit/seed-augment.ts`) unless stated otherwise.

**TRO-183 / DB-6 — `GET /api/weeks` collapsed 3 correlated subqueries into 1 indexed lookup.**

`api/src/routes/weeks.ts` computed `has_retro` / `retro_outcome` / `retro_id` (and four more
duplicate blocks at the single-sprint GET, the two PATCH re-queries, and the start-sprint
re-query — five identical occurrences total) with three separate correlated subqueries against
`document_associations`, all sharing the join `related_id = d.id AND relationship_type = 'sprint'`.
Two of the three (`retro_outcome`, `retro_id`) used `LIMIT 1`, and confirmed by EXPLAIN: that LIMIT
made the planner favor a zero-startup-cost `Seq Scan` over the existing
`idx_document_associations_related_type` index — `Rows Removed by Filter: 803`, twice, on every
row, `loops=5` — even though the third subquery (`has_retro`, no `LIMIT`) used that same index
correctly via a `Bitmap Heap Scan`.

**Fix.** All five occurrences now compute all three fields from one `LEFT JOIN LATERAL`, using
`MAX()` instead of `LIMIT 1`. This is deliberate, not cosmetic: an aggregate has to see every
matching row regardless of how many there are, so its cost model prefers the index the same way
`has_retro`'s aggregate always did — a plain `LIMIT 1` rewrite (tried first) removed the duplicate
scan but still picked `Seq Scan` for the same startup-cost reason as before. `MAX(rt.id::text)::uuid`
is required because Postgres has no built-in `MAX(uuid)` aggregate. Correctness rests on a
uniqueness invariant enforced elsewhere in this file (`POST /:id/review` returns 409 if a
`weekly_review` already exists for a sprint), so at most one row can ever match — `MAX()` over
0-or-1 rows is exactly `LIMIT 1`'s result.

**Before/after (EXPLAIN ANALYZE, BUFFERS, sprint_number=14, this workspace's 5 matching sprints):**

| | before | after |
|---|---|---|
| Buffers | 1181 shared hit | 749 shared hit (-36.6%) |
| SubPlans | 8 correlated, `loops=5` each | 5 (retro folded into the main join tree, not a SubPlan) |
| `document_associations` seq scans for retro | 2 (`Rows Removed by Filter: 803` each) | 0 |
| retro access path | `Seq Scan` | `Bitmap Heap Scan` via `idx_document_associations_related_type` |

Note for whoever re-measures this: the augmented seed data has **zero** documents matching the
`outcome IS NOT NULL` predicate at all — `outcome` is written nowhere in the current codebase
(only ever read), so `has_retro` is always `false` today. The buffer savings above are real and
independent of that (Postgres still has to scan for a match whether or not one exists), but the
regression tests below had to insert a synthetic matching row by hand to exercise the "found a
retro" branch at all.

**TRO-184 / DB-7 — no index on `documents.ticket_number`; issue permalinks seq-scanned the whole table.**

`GET /api/issues/by-ticket/:number` (`issues.ts`, `WHERE d.ticket_number = $1 AND d.workspace_id =
$2 AND d.document_type = 'issue'`) had no supporting index, so every lookup scanned the full
workspace regardless of issue count.

**Fix.** Migration `038_documents_ticket_number_index.sql` adds
`idx_documents_ticket_number ON documents (workspace_id, ticket_number) WHERE document_type =
'issue'` — a partial index matching the route's exact predicate.

**Before/after (EXPLAIN ANALYZE, BUFFERS, `ticket_number = 16`, 5 matching rows in this seed):**

| | before | after |
|---|---|---|
| Plan | `Seq Scan` | `Index Scan using idx_documents_ticket_number` |
| Buffers | 66 shared hit | 5 hit + 1 read |
| Rows removed by filter | 495 | 0 |

**TRO-185 / DB-8 — the association batch's `= ANY($1)` misestimated cardinality by 28x.**

`getBelongsToAssociationsBatch` (`api/src/utils/document-crud.ts`, called from `issues.ts`'s list
route) filtered `document_associations` with `da.document_id = ANY($1)`. Postgres cannot see an
array parameter's length at plan time, so it falls back to a fixed low-selectivity guess: measured
at `rows=25` estimated vs `rows=707` actual (this workspace's full 254-issue batch) — a 28x
underestimate — which left `idx_document_associations_document_id` unused in favor of a sequential
scan. The batch itself is correct design (it is what keeps `/api/issues` at a handful of queries
instead of one per issue) — the fix had to keep it, not remove it.

**Both candidates in DB-8's own wording were measured, not guessed:**

- `unnest($1::uuid[]) JOIN` — rejected. Postgres defaults a `Function Scan` on an unnested array to
  a flat `rows=10` estimate regardless of the array's real length, so the misestimate is not fixed
  at all (still `rows=10` vs `rows=707`), and in this measurement it also flipped a downstream join
  from `Hash Join` to a per-row `Nested Loop` + `Index Scan`, raising buffers to 2146 (vs 91 before).
- `JOIN (VALUES ...)` — adopted. A `VALUES` list gives the planner the batch's literal size, so the
  estimate becomes accurate: `rows=635` vs `707` actual (1.1x, down from 28x). At a realistic page
  size (20 ids, matching the opt-in `limit` PR #19/TRO-173 added), buffers fell **90 -> 59 (-34%)**.
  At this workspace's full 254-id batch (an edge case — nearly every issue in one call), the more
  accurate estimate led the planner to a `Nested Loop` + `Memoize`-cached `Index Scan` for the
  `documents` join instead of hashing the whole table once, which cost more buffers in that one
  scenario (91 -> 155) despite fixing the estimate DB-8 is actually about. Recorded here rather
  than hidden: the realistic-page-size case is the one this batch runs at in practice.

Implementation builds the `VALUES` list as `$1::uuid, $2::uuid, ...` — one bind parameter per id,
never interpolated — and de-dupes the input array first, since a repeated id in a `VALUES` join
would (unlike `= ANY`, a set-membership test) multiply output rows.

**TRO-187 / DB-10 — no index on `documents.updated_at` despite `ORDER BY updated_at DESC` in seven route modules.**

`issues.ts`, `documents.ts`, `weeks.ts`, `projects.ts`, `programs.ts`, `dashboard.ts` and
`search.ts` all sort by `updated_at DESC` with no supporting index — invisible at 500 rows (an
unsupported quicksort costs microseconds) but exactly what makes `LIMIT` cheap once a list route
paginates. That sequencing is no longer hypothetical: **API-2/DB-5's opt-in pagination merged as
PR #19** (`limit`/`offset` on `GET /api/issues`, no default limit, verified via `gh pr view 19`),
so this index now has an actual consumer, not just a future one.

**Fix.** Migration `039_documents_updated_at_index.sql` adds
`idx_documents_workspace_updated_at ON documents (workspace_id, updated_at DESC)`.

**Before/after** (representative query: `WHERE workspace_id = $1 AND archived_at IS NULL AND
deleted_at IS NULL ORDER BY updated_at DESC LIMIT 20`; "before" reproduced in the same session via
`SET enable_indexscan/enable_bitmapscan = off` rather than dropping the index):

| | before | after |
|---|---|---|
| Plan | `Seq Scan` + top-N heapsort | `Index Scan using idx_documents_workspace_updated_at` |
| Buffers | 69 shared hit | 4 hit + 2 read |

**Regression tests.**

- **`api/src/db/__tests__/db-6-7-8-10-indexes.test.ts`** (DB-7, DB-10) — index-existence, genuinely
  red-before-green: builds a throwaway database, copies every real migration file *except*
  038/039 into a fixture directory, applies it, and asserts both indexes are absent — then applies
  the real (full) migrations directory on the same database and asserts both exist with the
  expected definition (`workspace_id`, `ticket_number`/`updated_at DESC`, and the partial index's
  `document_type = 'issue'` predicate). Confirmed red first: the first `it()` failed
  (`idx_documents_ticket_number` / `idx_documents_workspace_updated_at` both `undefined`) before
  038/039 existed.
- **`api/src/routes/weeks-retro-lookup.test.ts`** (DB-6) — NOT red-before-green; behavior must not
  change, so this pins it. Runs the pre-TRO-183 3-subquery SQL and the new `LATERAL` SQL side by
  side against the same seeded sprint and asserts identical results, for both a sprint with a
  synthetic matching `weekly_review` (`outcome` set, associated via `relationship_type = 'sprint'`)
  and one without (the common case in real data today).
- **`api/src/utils/__tests__/document-crud.test.ts`** (DB-8) — also a pin, not red-before-green.
  Runs the pre-TRO-183 `= ANY($1)` query and the new `VALUES`-join function side by side across a
  document with two associations, one with one, and one with zero, plus a duplicate-id input case
  (proving the de-dupe keeps `= ANY`'s set-membership semantics), and asserts identical `Map`
  contents.
- **Full `api` suite** (`pnpm --filter @ship/api test`, against the worktree's own database):
  48 files / 609 tests, all green, including the pre-existing 46 `weeks.test.ts` and 27
  `issues.test.ts` cases unchanged by this branch.
- **Plan-shape assertion for DB-7 (EXPLAIN showing `Index Scan`), judged too brittle to automate:**
  each api test file's `beforeAll` truncates `documents` and this file's own tests insert only a
  handful of rows before running — a table that small will correctly get a `Seq Scan` regardless of
  the partial index (small-table cost, not a planner bug), so an `EXPLAIN`-based assertion in the
  gate's own environment would be flaky-to-false rather than a real signal. The captured
  EXPLAIN ANALYZE evidence above (at the audit's 500-row seed) is the evidence of record instead.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api exec vitest run \
  src/db/__tests__/db-6-7-8-10-indexes.test.ts \
  src/routes/weeks-retro-lookup.test.ts \
  src/utils/__tests__/document-crud.test.ts \
  src/routes/weeks.test.ts \
  src/routes/issues.test.ts
```

**Rollback.** Revert the two migrations (both pure additions — `DROP INDEX
idx_documents_ticket_number` / `DROP INDEX idx_documents_workspace_updated_at`, no data changes,
safe to drop anytime) and revert the `weeks.ts` / `document-crud.ts` query changes. No schema
changes to existing columns, no backfill, nothing to undo beyond the two `CREATE INDEX` statements
and the query text.

---

## TRO-207 (TS-2) — the database-to-HTTP response path is no longer implicitly `any`

`@types/pg`'s `query()` defaults its row generic to `any`, and in `api/src` production code
essentially no call site supplied it — so every `.rows` access was implicitly `any` all the way
into the HTTP response. A column rename or a `properties->>'x'` typo would produce `undefined` in a
live API response with zero compile-time signal anywhere in the chain. The only translation layer
between raw rows and the JSON contract the frontend consumes was seven hand-written mappers, all
declared `(row: any)`.

**Verified before touching anything:** the audit's "seven `(row: any)` mappers" claim was accurate
for six; `issues.ts`'s `extractIssueFromRow` had already been typed by an earlier ticket. That fix
was structurally inert, though — none of that file's ~59 `pool.query()` call sites supplied a
generic, so an `any`-typed row satisfied the mapper's typed parameter silently at every call site
(assigning `any` to a typed parameter is always allowed). The real gap wasn't the mapper signature,
it was the query call sites feeding it.

**What changed** — `api/src/routes/{feedback,programs,projects,issues,weeks}.ts`:

- All seven mappers now take a real row interface instead of `any`: `extractProjectFromRow` /
  `extractSprintFromRow` (`projects.ts`), `extractIssueFromRow` (`issues.ts`, parameter now actually
  enforced), `extractProgramFromRow` (`programs.ts`), `extractFeedbackFromRow` (`feedback.ts`),
  `extractSprintFromRow` / `formatStandupResponse` (`weeks.ts`).
- `pool.query<Row>(...)` / `client.query<Row>(...)` added across the five files: **154 call sites**
  newly typed (1 was already typed, in `issues.ts`; 155 of 225 call sites in these files now carry
  an explicit generic). The remaining 70 are bare DML (`INSERT`/`UPDATE`/`DELETE` with no
  `RETURNING`) or transaction control (`BEGIN`/`COMMIT`/`ROLLBACK`) where no `.rows` field is ever
  read downstream — typing the generic there would add nothing, since `.rowCount`'s type doesn't
  depend on it.
- Row interfaces are local to each file (or reuse `api/src/routes/rowTypes.ts`, new — a small shared
  `DocumentRow` plus `document_type`-narrowed variants whose `properties` field is typed against the
  matching `@ship/shared` type: `ProjectProperties`, `IssueProperties`, `ProgramProperties`,
  `WeekProperties`). Verified against `api/src/db/schema.sql` and each query's actual `SELECT` list,
  not guessed. Two facts checked empirically against this project's own Postgres rather than
  assumed: `DATE`/`TIMESTAMP`/`TIMESTAMPTZ` columns come back as real JS `Date` objects, and
  `COUNT(*)`/`SUM(...)` aggregates come back as `string` (bigint/numeric are stringified to avoid
  precision loss) — both now modeled honestly instead of falling through `any`.
- Downstream callbacks fixed: the `.filter((i: any) => ...)` issue-rollup blocks in `projects.ts` —
  **6 sites, not the audit's stated 4** (two identical three-filter blocks, verified by re-counting
  rather than trusting the cited number), plus a 7th, untagged occurrence of the same defect
  (`!['done','cancelled'].includes(i.state)` with no `any` annotation at all, inside
  `generatePrefilledRetroContent`) found and fixed in the same pass. Two more `.filter((i: any) =>
  ...)` in `weeks.ts`'s `/my-week` grouping, plus several `values: any[]` / `params: any[]`
  query-parameter arrays across all five files, now typed to their real unions.
- A handful of `: any` in TipTap-content-building helpers (`generatePrefilledRetroContent` in
  `projects.ts`, `generatePrefilledReviewContent` in `weeks.ts`) were deliberately left — modeling
  TipTap's node structure is finding TS-3, out of this ticket's scope.

**Two narrow, behavior-preserving side effects of typing honestly, not scope creep:**

- Several `row.x === true || row.x === 't'` defensive checks (`has_plan`, `has_retro` in
  `programs.ts`/`weeks.ts`) simplified to `row.x`: once the column is honestly typed `boolean` (SQL
  `CASE WHEN...THEN true ELSE false END` / `COUNT(*) > 0` always return a real JS boolean, never the
  string `'t'`), the `'t'` branch is a compile error (no overlap between `boolean` and a string
  literal) — verified unreachable, not just assumed.
- Two new `client.query('ROLLBACK')` calls in `issues.ts`'s `POST /` (paired with `noUncheckedIndexedAccess`
  guards on `ticketResult`/`createdRow`, which could not previously be written as `!` under G7b).
  Before this fix, an undefined row here would throw and be caught by the route's own `catch`
  block, which already calls `ROLLBACK` and releases the client — so the observable behavior
  (500 response, rolled-back transaction, released connection) is identical; the path is just
  explicit now instead of relying on an uncaught-property-read exception.

**Remainder — explicitly out of scope, for a follow-up ticket:** ~559 bare `pool.query(`/
`client.query(` call sites remain untyped elsewhere in `api/src` (down from ~710), covering routes
outside `projects`/`issues`/`programs`/`weeks`/`feedback` (e.g. `workspaces.ts`, `documents.ts`,
`team.ts`, `dashboard.ts`, `standups.ts`, `admin.ts`, `weekly-plans.ts`, `claude.ts`). None were
touched here per the orchestrator's scope decision.

**How to run it.** `pnpm --filter @ship/api exec tsc --noEmit -p tsconfig.json` (or `pnpm
type-check`) and `pnpm --filter @ship/api test`.

**Measurement (cheap tier — `type-safety-audit`'s counting method, BSD grep, same patterns as
`audit/type-safety/baseline.md`):**

| Metric | Before | After |
|---|---|---|
| `(row\|r): any` mapper signatures | 6 (of 7 — 1 already fixed but inert) | **0** |
| Typed `pool/client.query<...>` call sites, 5 touched files | 1 | **155** (of 225) |
| `pool/client/db.query(` untyped, whole `api/src` prod | 710 | 559 |
| `pool/client/db.query<` typed, whole `api/src` prod | 3 | 157 (158 raw — 1 is the grep matching the phrase "`pool.query<T>(...)`" inside `rowTypes.ts`'s own doc comment, not code) |
| `.rows` accesses, whole `api/src` prod | 771 | 711 |
| `explicit_any` (`count.sh`), whole `api` package | 76 | **55** |
| `as_any`, whole `api` package | 128 | 128 (unchanged — none added, none removed) |
| non-null assertions (tracked pattern), whole `api` package | 42 | 42 (unchanged — none added) |

`as_assertions` moved 1059 → 1086 (+27); verified by grepping the diff's added lines that every one
of those is inside a comment/docstring or an `AS <alias>` SQL clause quoted in a comment (e.g. "COUNT(*)
subqueries — node-postgres returns bigint aggregates **as** strings"), not a real type assertion —
consistent with the baseline's own documented ~15-20% over-count on this pattern.

**Rollback.** Revert the five route files and delete `api/src/routes/rowTypes.ts` and
`api/src/routes/rowTypes.test.ts`. No schema or migration changes; no behavior changes beyond the
two narrow cases documented above.

---

## TRO-289 (ERR-13) — PersonEditor saved title/properties with no error handling at all

**Confirmed against the code, not just the ticket.** `web/src/pages/PersonEditor.tsx` saved the
title (via `useAutoSave`'s `onSave`) and every sidebar property change (`onUpdateProperties`) with a
bare `await apiPatch(...)` — no `.ok` check, no thrown error, no `.status`, no `useMutation`, and no
tag into the write-outcome bus `web/src/hooks/useDocumentWriteStatus.ts` (TRO-190/ERR-3) already
drives every OTHER document type's `SyncStatusIndicator` from. A rejected or throttled person-document
write vanished with zero observable effect: no console error, no toast, no change to the "Saved"
indicator, and (for `onUpdateProperties`) the local optimistic state update happened unconditionally,
even on failure, since nothing ever checked the response.

**What changed.** `web/src/pages/PersonEditor.tsx` gains one `useMutation` (`updatePersonMutation`),
built exactly like `UnifiedDocumentPage.tsx`'s real `updateMutation`:

- `mutationFn` throws an `Error & { status: number }` on a non-ok response (`error.status =
  response.status`), so the shared retry policy (`shouldRetryRequest`/`retryDelayMs` in
  `queryClient.ts`) can back a throttled 429 off on its tuned schedule instead of dropping it, and so
  `isNotFoundError` can tell a 404 apart from any other failure.
- `meta: { operation: 'update person', documentId: id }` tags it into the same document-write-outcome
  bus every other document type's mutation already reports through — no new bus, no new subscriber;
  `Editor.tsx`'s existing `useDocumentWriteStatus(documentId, ...)` call picks it up unchanged and
  flips this document's own `SyncStatusIndicator` to "Not saved" (and raises the existing one-shot
  "document was deleted" notice on a 404), because `PersonEditorPage` already renders through the
  same shared `Editor` (`LazyEditor`).
- The title save (`throttledTitleSave`'s `onSave`) and the property save (`onUpdateProperties`) both
  call `updatePersonMutation.mutateAsync(...)` instead of the bare `apiPatch`. `onUpdateProperties`
  now applies its local optimistic state update only after the write actually succeeds — it is a
  fire-and-forget event handler (`PersonCombobox`'s `onChange` doesn't await it), so the catch also
  swallows the rejection there rather than letting it escape as an unhandled rejection; failure is
  still visible via the shared indicator.

**Regression tests — `web/src/pages/PersonEditor.test.tsx`** (vitest, run by the gate). Renders the
real `PersonEditorPage` against the app's actual `queryClient` singleton (mocking only the
`@/lib/api` network boundary and the lightweight `useAuth`/`useDocuments`/`useWorkspace` context
hooks), paired with a second, independent `useDocumentWriteStatus` subscriber on the SAME
`queryClient` — the same "drive real mutations, don't cast mutation-cache internals" technique
`useDocumentWriteStatus.test.tsx` uses (see commit 9510f8e). Five cases:

1. A successful property save leaves `hasFailedWrite` false.
2. A rejected (400) property save flips `hasFailedWrite` true.
3. A rejected (400) title save (the `useAutoSave`-throttled path) also flips `hasFailedWrite` true.
4. A 404 property save calls the shared `onDocumentGone` notice exactly once, reusing the ERR-4
   deletion notice rather than inventing a second one.
5. A 429 property save is retried on the throttle schedule (`THROTTLE_RETRY_DELAYS_MS`, first retry
   at ≥2s) rather than the generic ~1s exponential schedule any other retryable error gets — confirmed
   under `vi.useFakeTimers()` by asserting no second attempt lands by 1.5s, then that one has by 3s.

Confirmed red first, for the right reason: reverting `PersonEditor.tsx` to its pre-fix version and
re-running this same test file failed 4 of 5 cases with real `AssertionError`s (`hasFailedWrite`
stayed `false`, `onGone` was called 0 times, the 429 case never issued a second `apiPatch` call at
all because there was no mutation/retry policy in play) — not an import error or a typo.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run src/pages/PersonEditor.test.tsx
```

**Rollback.** Revert the commit(s) on `fix/err-13-err-14-editor-save-paths` touching
`PersonEditor.tsx`. `queryClient.ts` and `UnifiedDocumentPage.tsx` are unaffected by this ticket's
half of the branch (see TRO-290 below).

---

## TRO-290 (ERR-14) — a window-focus refetch on a deleted document unmounted the editor and discarded in-progress text

**Reproduced first, as directed — this is the headline claim.** Wrote a jsdom test rendering the
real `UnifiedDocumentPage` route against the app's actual `queryClient` singleton (so `staleTime` and
the default retry policy are exactly production's, not a relaxed test client), loaded a `wiki`
document successfully, marked the `['document', id]` query stale via `queryClient.invalidateQueries({
refetchType: 'none' })` (stale, but no auto-refetch yet — isolates the trigger), then dispatched a
real `window.dispatchEvent(new Event('visibilitychange'))` — the exact event
`@tanstack/query-core`'s `focusManager` listens for. React-query's own focus-refetch machinery fired
a second fetch, mocked to return 404 (another user deleted the document). **Observed:** the second
`apiGet` call landed, and the mocked editor (`data-testid="editor-mounted"`, holding text standing in
for an in-progress, unsaved draft) disappeared from the DOM, replaced by the "Document not found"
screen. This is REPRODUCED, not derived — the failure was watched happening, not inferred from
reading the code.

**Root cause.** `web/src/pages/UnifiedDocumentPage.tsx`'s top-level `useQuery(['document', id])`
never overrode `refetchOnWindowFocus`, so it gets react-query's default background refetch on window
focus. React-query does not clear cached `data` just because a later background fetch failed — `data`
stays the last good snapshot while `error` becomes set. The render, though, checked
`if (error || !document)` — truthy `error` alone was enough to bail into the "not found" screen,
regardless of whether `document` still held a perfectly good, cached copy — unmounting the entire
editor tree and destroying whatever local (Yjs/TipTap/title) state it held.

**What changed — preferred fix from the ticket: one deletion story, not two.**

- The query's `queryFn` now attaches `.status` to its thrown error (same pattern as ERR-3/ERR-4's
  write-path fix), so a 404 can be told apart from any other fetch failure.
- `web/src/lib/queryClient.ts` gains `notifyDocumentGoneOnRead(documentId)`, a thin wrapper around the
  existing (private) `notifyDocumentWriteOutcome` — the READ-path counterpart to the write-outcome
  bus TRO-190/ERR-3 built. No new bus, no new subscriber.
- `UnifiedDocumentPage.tsx` adds one effect: when a background refetch's `error` is a 404
  (`isNotFoundError`) while `document` (cached data) still exists, it calls
  `notifyDocumentGoneOnRead(id)` — routing the read-path deletion through the exact same bus and
  user-facing notice (`Editor.tsx`'s `alert(DOCUMENT_GONE_MESSAGE)`) ERR-4 already gives a failed
  *write* against a deleted document. `useDocumentWriteStatus`'s existing one-shot guard keeps the
  alert to a single firing even if the query keeps re-attempting the failed refetch.
- The render's error branch changed from `if (error || !document)` to `if (!document)` — a background
  refetch failure (404 or otherwise) no longer unmounts the editor as long as a cached document
  exists; a hard failure on the very first load (no cached data at all) still shows the "not found"
  screen exactly as before.

**Regression tests — `web/src/pages/UnifiedDocumentPage.deletedFocusRefetch.test.tsx`** (vitest, run
by the gate). Same real-`queryClient` / real-focus-event technique as the reproduction above:

1. After the focus-triggered 404, the editor stays mounted with its original in-progress text intact,
   the shared bus's `onGone` fires exactly once and `hasFailedWrite` becomes true, and the doc is
   fetched exactly twice (no retry storm, no repeated notice).
2. A hard 404 with no cached document at all (first load) still shows "Document not found" — the
   existing behavior for that case is unchanged.

Confirmed red first, for the right reason: reverting `UnifiedDocumentPage.tsx` to its pre-fix version
and re-running case 1 failed with `expected "vi.fn()" to be called 1 times, but got 0 times` (the
notice never fired) and the DOM showing "Document not found" — exactly the reproduced bug, not an
import error.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run src/pages/UnifiedDocumentPage.deletedFocusRefetch.test.tsx
```

**Rollback.** Revert the commit(s) on `fix/err-13-err-14-editor-save-paths` touching
`UnifiedDocumentPage.tsx` and the `notifyDocumentGoneOnRead` addition in `queryClient.ts`.
`PersonEditor.tsx` (TRO-289 above) is unaffected.

---

## TRO-219 (A11Y-5) + TRO-220 (A11Y-6) + TRO-221 (A11Y-7) — page-shell landmark and heading structure

Three findings, one shared root cause per the assignment: missing landmark/heading structure in the
page shells. Each turned out to need a different fix once actually diagnosed.

**A11Y-5 was mis-filed as a landmark bug on two working pages. It is not: `/search` and `/weeks` are
not routes.** The finding assumed real pages missing `<main>`/`<h1>`. Checking
`audit/error-handling/raw/probe1b-routes.json` first (as the ticket required) showed both routes with
`bodyTextLength: 0` - byte-for-byte identical to `/this-route-does-not-exist`, which was included in
that probe specifically because it's guaranteed not to exist. `web/src/main.tsx` had no
`path="/search"` or `path="/weeks"` entry, and there is no `SearchPage`/`WeeksPage` anywhere in
`web/src/pages/` - `/api/weeks` and `/api/search/mentions` are backend endpoints the audit's route
list conflated with frontend pages. `AppRoutes`'s `<Routes>` had no wildcard fallback, so an unmatched
path under `/` didn't match the parent `<Route path="/">` either and the whole tree rendered nothing -
not a page missing a landmark, a routing gap with no landmark, heading, or content of any kind.
Papering `<main>` around that emptiness would have been decoration; a real catch-all is the fix that
also happens to clear the axe rules the finding named.

**What changed - A11Y-5.**

- `web/src/pages/NotFound.tsx` (new) - a real "Page not found" view with its own `<h1>` and a link
  back to `/docs`. It does *not* render its own `<main>`: every route nested under `AppLayout` already
  gets one for free (`pages/App.tsx:542`), and a second `<main>` would be a duplicate landmark - its
  own axe violation.
- `web/src/main.tsx` - added `<Route path="*" element={<NotFoundPage />} />` as the last child of the
  same `<Route path="/">` that renders `<AppLayout />`, lazy-loaded like every other page (BUN-1
  convention). Placement matters: as a sibling of `dashboard`, `my-week`, etc., it inherits
  `AppLayout`'s persistent `<main>` instead of needing its own.

**A11Y-6: the skip is page chrome, not user-authored TipTap content.** A document view's only
page-level heading is the title `<h1>` (`Editor.tsx:888`). `WikiSidebar` renders nothing but
`<label>` property rows and `BacklinksPanel`, whose "Backlinks" header was an `<h3>` with no `<h2>`
anywhere in the chrome - an h1 -> h3 skip, reproduced on a real seeded wiki document with zero body
headings (`audit/a11y/axe/document_view.json`: `heading-order` targeting `h3`; re-confirmed live
against this worktree's own dev server with the same result). Because it reproduces with no user
content at all, this cannot be a TipTap-authored skip, so the fix does not touch the editor's Heading
extension or constrain what levels a user can type into their own document - only the chrome.
`web/src/components/sidebars/PropertiesPanel.tsx`'s `WeeklyDocumentSidebar` had the identical pattern
(an `<h3>` "Weekly Plan"/"Weekly Retro" header with no `<h2>` above it) for weekly_plan/weekly_retro
documents - same root cause, different document type, fixed alongside it.

**What changed - A11Y-6.**

- `web/src/components/editor/BacklinksPanel.tsx` - all three "Backlinks" headers (loading/error/loaded
  states) promoted from `<h3>` to `<h2>`, the first real section heading under the page's single
  `<h1>`.
- `web/src/components/sidebars/PropertiesPanel.tsx` - `WeeklyDocumentSidebar`'s "Weekly Plan"/"Weekly
  Retro" header promoted the same way, and the function is now exported (was module-private) so its
  own regression test can render it without also mocking `useAuth`/`useWorkspace`, which the exported
  `PropertiesPanel` wrapper calls unconditionally regardless of document type.

**A11Y-7: straightforward - wrap the form in `<main>`.** The entire login page (logo, form, dev-hint)
sat in a plain `<div>` with no landmark anywhere on the page. axe reported `landmark-one-main` and
`region` (five separate un-landmarked blocks, including both form field wrappers) -
`audit/a11y/axe/login_unauth.json`. `web/src/pages/Login.tsx`'s single wrapping `<div
className="w-full max-w-[360px]">` is now a `<main>` with the same class - no visual change, since
Tailwind classes fully control the box's appearance and `<main>`/`<div>` carry no differing default
styles.

**Process note the ticket also asked about.** The repo's e2e a11y specs (`e2e/accessibility.spec.ts`)
filter every assertion to `expect(violations.filter(v => v.impact === 'critical' || v.impact ===
'serious')).toHaveLength(0)` - Moderate violations (all three of these rules) pass those specs by
construction, which is exactly how A11Y-5/6/7 went unnoticed by CI. This PR does **not** tighten that
filter - live-measured before/after below (Serious+ column) shows it would stay green on `/search`,
`/weeks`, and `/login` after this fix, but `document view` already carried a pre-existing Serious
`color-contrast` finding unrelated to this ticket (see below), so tightening the filter repo-wide is a
separate decision for a human, not a side effect of this PR.

**Regression tests** (`web/src/**/*.test.tsx`, run by `pnpm --filter @ship/web test`, the tier the
gate actually executes):

- `web/src/pages/NotFound.test.tsx` - renders an `<h1>`, offers a link back to `/docs`, and does
  *not* render its own `<main>`.
- `web/src/main.routes.test.ts` (extended) - pins the catch-all as a lazy-loaded sibling route inside
  the `AppLayout`-wrapping `<Route path="/">`, not a bare top-level route.
- `web/src/components/editor/BacklinksPanel.test.tsx` - asserts the "Backlinks" heading is `h2` in
  both the loading and loaded states.
- `web/src/components/sidebars/PropertiesPanel.test.tsx` - asserts `WeeklyDocumentSidebar`'s header is
  `h2` for both weekly_plan and weekly_retro.
- `web/src/pages/Login.test.tsx` - asserts the sign-in form, both inputs, and the submit button are
  all reachable inside a single `<main>`.

Every test above was confirmed red first (against the pre-fix markup, restored via file copies -
never `git stash`, per this project's standing rule) for the reason claimed - missing `<main>`/`h1`,
or the wrong heading level - then green after the fix, with no other change to the assertion.

**Measurement (a11y DoD).** axe-core 4.11.0 via `@axe-core/playwright`, tags
`wcag2a,wcag2aa,wcag21a,wcag21aa,best-practice`, Chromium 1217 headless, 1440x900, against this
worktree's own dev servers (`web :5995`, `api :3822`, seeded fresh), authenticated as `dev@ship.local`
except where noted. The seeded user's "Action Items" modal auto-opens on every navigation and was
dismissed after each one before scanning - an earlier pass here that dismissed it only once (right
after login) produced a false-clean reading on the document view, because the modal was still
covering the page for that scan; re-scanning with the modal dismissed on every navigation reproduced
the real `heading-order` violation and is what these numbers reflect.

| Page / state | Before (C/S/M/m, rules) | After (C/S/M/m, rules) |
|---|---|---|
| `/login` (unauthenticated) | 0/0/2/0 - `landmark-one-main`, `region` | 0/0/0/0 |
| `/search` | 0/0/2/0 - `landmark-one-main`, `page-has-heading-one` | 0/1/0/0 - `color-contrast` (see below) |
| `/weeks` | 0/0/2/0 - `landmark-one-main`, `page-has-heading-one` | 0/1/0/0 - `color-contrast` (see below) |
| document view (seeded wiki doc) | 0/0/1/0 - `heading-order` | 0/0/0/0 |

All four of the named axe rules (`landmark-one-main`, `page-has-heading-one`, `heading-order`,
`region`) clear. `/login` and document view are fully clean after the fix.

**New, honestly-reported: `/search` and `/weeks` now surface a pre-existing Serious `color-contrast`
finding that was never reachable before.** Before this fix those two URLs rendered nothing at all, so
they trivially had zero violations of every kind, not just the two landmark/heading ones. Once
`AppLayout` actually mounts there (via the new catch-all), they inherit the same 4-panel chrome every
other authenticated page uses - and `getActiveMode()` (`pages/App.tsx`) has no match for `/search` or
`/weeks`, so it falls through to its `'dashboard'` default, highlighting the "My Work" nav item in
`DashboardSidebar.tsx:36` (and a second item at line 51) with `bg-accent/10 text-accent` - `accent`
(#005ea2) is a *fill* color, documented in `web/tailwind.config.js` as only 2.89:1 as text, the exact
A11Y-3/TRO-217 failure mode. This exact element is never flagged on the real `/my-week` page only
because that one page hides its whole contextual sidebar (`hideLeftSidebar` in `pages/App.tsx`) for
unrelated layout reasons - the defect was always there, just never visible. This is pre-existing
chrome, not something this PR added, and swapping its color token is a visible change to unrelated,
already-shipped UI - out of a landmark/heading ticket's scope per this project's "no visual redesign;
escalate a visible fix" rule, so it is reported here rather than fixed. Recommend a follow-up finding
(`DashboardSidebar.tsx:36,51`, same class as A11Y-3) rather than silently expanding this PR.
`NotFoundPage.tsx`'s own new "Go to Documents" link had the identical mistake (`text-accent` copied
from `UnifiedDocumentPage.tsx`'s existing, equally-affected "Go to Documents" button) and *was* fixed
here, since it's this PR's own new code: swapped to `text-accent-text` (6.08:1), the token this
codebase already defines for accent-colored text.

**Unverified.** Everything above is DOM/axe evidence (observed) or code-read (derived and marked as
such). No claim is made about what a screen reader announces; VoiceOver verification of the new
`<main>`/`<h1>` structure is owed to a human, per this project's standing rule that only a human
listening can confirm announcement behavior.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run \
  src/pages/NotFound.test.tsx \
  src/main.routes.test.ts \
  src/components/editor/BacklinksPanel.test.tsx \
  src/components/sidebars/PropertiesPanel.test.tsx \
  src/pages/Login.test.tsx
scripts/factory/gate.sh
```

**Rollback.** Revert the commit(s) on `fix/a11y-5-6-7-landmarks`. The three fixes are independent:
reverting `web/src/main.tsx`'s catch-all route and deleting `NotFound.tsx` undoes A11Y-5 alone;
reverting the two heading-level changes undoes A11Y-6 alone; reverting `Login.tsx`'s `<main>` undoes
A11Y-7 alone.

---

## TRO-211 (TS-6) — a real ESLint config; `pnpm lint` stops being a silent no-op

**Before, observed by running it.** `pnpm lint` printed `None of the selected packages has a
"lint" script` and exited 0 — no `.eslintrc*` or `eslint.config.*` existed anywhere outside
`node_modules`, and none of `api`, `web`, `shared` defined a `lint` script for root's
`pnpm --recursive run lint` to dispatch to. `.github/workflows/ci.yml` did not call `pnpm lint` at
all; a comment there said explicitly to wire it in "when TRO-211 lands."

**What changed.**

- Added `eslint.config.mjs` at the repo root: ESLint 9.39.5 flat config + `typescript-eslint`
  8.65.0, covering `api/src`, `web/src`, `shared/src` only — not `e2e/`, not config/script files
  (`web/tsconfig.node.json` / build-script coverage is the separate, still-open TS-9).
- Added `"lint": "eslint src"` to `api/package.json`, `web/package.json`, `shared/package.json`.
  Root's `"lint": "pnpm --recursive run lint"` needed no change — it was already the right
  dispatcher, just dispatching to nothing.
- Wired a `Lint` step into `.github/workflows/ci.yml`'s `verify` job, right after `Type check` and
  before `Build all packages`.

**Ruleset — ERROR vs WARN, and why, with baseline counts** (`api` / `web` / `shared`, before any
fix):

| Rule | Severity | Baseline (api/web/shared) | Why |
|---|---|---|---|
| `eqeqeq` (`always`, `{null:'ignore'}`) | **error** | 4 / 2 / 0 → **0 / 0 / 0** | All 6 raw hits were the `== null` / `!= null` idiom (e.g. `api/src/collaboration/index.ts:330`, `web/src/components/ActionItems.tsx:67`). Forcing `=== null` would exclude `undefined` and change behavior — that is a bug, not a fix. Configured ESLint's standard exception instead of touching code; every other `==`/`!=` is still an error. |
| `no-fallthrough` | **error** | 0 / 0 / 0 | Passes clean today (tsc's `noFallthroughCasesInSwitch` already covers most of this; ESLint is belt-and-suspenders, catches cases tsc's flag doesn't). |
| `@typescript-eslint/no-floating-promises` | **warn** | 4 / 209 / 0 (213 total) | Real correctness bugs, but far past "few (<~15) and mechanical" — mostly React event handlers across `web/src/pages/*.tsx`. 4 of the api sites are inside `api/src/collaboration/index.ts`, which `ship-backend`'s own brief flags as a stop-for-human zone with a documented history of async-ordering bugs (ERR-1/ERR-2/ERR-10/ERR-11/ERR-12). Fixing those under a lint-config ticket is exactly the drive-by this ticket was told not to do — follow-up ticket material. |
| `@typescript-eslint/no-misused-promises` | **warn** | 5 / 180 / 0 (185 total) | Same call, same reasoning. |
| `@typescript-eslint/no-explicit-any` | warn | 209 / 31 / 0 (240 total) | Per orchestrator scope: the audit's counted, open finding (TS-1/TS-2/TS-8), already being burned down by dedicated tickets and blocked from growing by G7b. Not this ticket's job to fix. |
| `@typescript-eslint/no-non-null-assertion` | warn | 295 / 33 / 0 (328 total) | Same call — the counted, open TS-4 class. |

**Result.** `pnpm lint` now exits **0** with **0 errors, 966 warnings** (513 api + 453 web + 0
shared) — a real check that passes today, not a vacuous one.

**How to run it.**
```bash
pnpm lint                     # all three packages (what CI runs)
pnpm --filter @ship/api lint  # single package
```

**Demonstrated the gate actually gates (not committed).** Appended a scratch function to
`web/src/lib/api.ts` with `if (a == 1) { ... }`, ran `pnpm --filter @ship/web lint`: exit **1**,
`eqeqeq` error reported (`454 problems (1 error, 453 warnings)`). Reverted with
`git checkout -- web/src/lib/api.ts`; re-ran: exit 0, back to 453 warnings, 0 errors.

**Not fixed here — follow-up.** `no-floating-promises` (213 sites) and `no-misused-promises` (185
sites) at warn, counts above. Two safe, mechanical-looking candidates outside the hazard file:
`api/src/db/migrate.ts:58` and `api/src/db/seed.ts:1259` both call an async `main()`/`seed()` at
top level with no `.catch`. The four sites inside `api/src/collaboration/index.ts` should go
through the same review weight as ERR-1/ERR-2, not a mechanical batch fix.

**Rollback.** Delete `eslint.config.mjs`; remove the `lint` script from `api/package.json`,
`web/package.json`, `shared/package.json`; remove the `eslint`/`typescript-eslint` root
devDependencies; remove the `Lint` step from `ci.yml`.

---

## TRO-203 (BUN-7) + TRO-204 (BUN-8) — an unused dependency and a duplicated Radix version leave the tree

Two Low-severity dependency-hygiene findings, one root cause (drift between what
`web/package.json` declares and what pnpm actually resolves), fixed on one branch.

**BUN-7 — `@tanstack/query-sync-storage-persister` was declared and never used.** Re-verified
against current code, not the audit snapshot, because the ticket flagged `web/src/lib/queryClient.ts`
as recently touched by TRO-190/ERR-3: it imports only the **types** `PersistedClient`/`Persister`
from `@tanstack/react-query-persist-client` and implements its own IndexedDB persister with
`idb-keyval` — it never reaches the sync-storage package. `grep -rE "from
'@tanstack/query-sync-storage-persister" web/src --include="*.ts" --include="*.tsx"` returns 0,
matching the audit exactly. Removed from `web/package.json` `dependencies`; `pnpm install`
re-resolved it out of `pnpm-lock.yaml`. 0 shipped-byte change, as predicted — it was never in any
emitted chunk to begin with.

**BUN-8 — `@radix-ui/react-primitive` and `@radix-ui/react-slot` each resolved to two versions.**
Cause, confirmed by reading both packages' own `package.json`s out of the pnpm store: `cmdk@1.1.1`
declares `"@radix-ui/react-primitive": "^2.0.2"` (a caret range), which pnpm resolves to the newest
match — 2.1.4, pulling in `react-slot@1.2.4` — while `@radix-ui/react-dialog`/`-popover`/`-tooltip`
each pin the **exact** older `2.1.3`/`1.2.3` internally. Neither side is a range pnpm can widen on
its own, so both trees shipped. Fixed with a `pnpm.overrides` entry in the root `package.json`
(with an explanatory `"// overrides (BUN-8 / TRO-204)"` comment key beside it, since a real override
key can't hold prose) forcing every consumer onto the newer pair. Converging *up* rather than down
to 2.1.3/1.2.3 was checked, not assumed: diffing the built `dist/index.mjs` for both version pairs
shows `react-primitive`'s logic is byte-identical between 2.1.3 and 2.1.4, and `react-slot` 1.2.4
only *adds* `React.lazy`-child support over 1.2.3 — a strict superset, not a behaviour change.

**Where the audit's own location claim no longer holds on this branch.** BUN-8 was measured against
the pre-BUN-1..6 tree, where the whole app was one entry chunk, so "both copies land in the entry
chunk" was true then. After TRO-197..202 shipped route/vendor splitting, `web/vite.config.ts`'s
`manualChunks` deliberately leaves Radix/cmdk/dnd-kit out of any vendor group (grouping them was
measured to cost 15 kB gzip on `/docs` and `/documents/:id`, because a route needing one primitive
then downloaded all of them), so Rollup's default splitting places them. Today the duplicate bytes
sit in a lazily-loaded **shared** chunk (`assets/index-CmtDBcUa.js` in this build, reached from
`Editor.tsx`, `App.tsx`, `Documents.tsx` and the document-tab components) — not the true entry chunk
`index.html` references. `/login`'s initial payload is therefore untouched by this fix; only `/docs`
and `/documents/:id` shrink, and only once (it's one physical file), not per route.

**Measured**: `pnpm build:web` from the repo root, `node audit/bundle/measure.mjs`, gzip level 9,
kB = 1000 bytes, Node v23.2.0, pnpm 10.27.0 — this branch vs. `main`@`9a15f43` built in an isolated
`git worktree add --detach` copy (never stashed):

| | Before | After | Change |
|---|---:|---:|---:|
| Total dist (raw / gzip) | 3,365.80 / 1,771.39 kB | 3,364.02 / 1,771.31 kB | −1.78 kB raw / −0.08 kB gzip |
| `/login` initial payload (gzip) | 117.49 kB | 117.47 kB | −0.02 kB |
| `/docs` route closure (gzip) | 182.07 kB | 181.98 kB | −0.09 kB |
| `/documents/:id` route closure (gzip) | 211.72 kB | 211.63 kB | −0.09 kB |

Matches the audit's own estimate (~2.1 kB raw / <1 kB gzip) in order of magnitude — this was always
a hygiene fix, not a payload fix, and is reported as one.

**Duplicate-gone proof**: `pnpm why @radix-ui/react-primitive --recursive` and `pnpm why
@radix-ui/react-slot --recursive` (repo root) show a single resolved version — `2.1.4` and `1.2.4`
respectively — on every path, including through `cmdk`. Parsing `pnpm-lock.yaml`'s `packages:` block
for all 25 `@radix-ui/*` entries confirms zero remaining duplicates (down from the 2 named above).

**Regression guard** (BUN-8 has one; BUN-7 removing an unimported package needs no behavioural test):
`web/src/lib/radixVersionDedupe.test.ts` (new) reads the real `pnpm-lock.yaml` and asserts every
`@radix-ui/*` package resolves to exactly one version — scoped to that family, not a blanket claim
about the whole tree, since other packages legitimately carry two majors. Confirmed it fails for the
right reason: run against a copy of the pre-fix lockfile it reports `@radix-ui/react-primitive
resolved to 2 version(s) (2.1.3, 2.1.4)` and the same for `react-slot` (1.2.3, 1.2.4), then passes
clean once the fixed lockfile is restored. Runs inside `pnpm --filter @ship/web test`, which the
factory gate executes.

**Verified nothing broke**: `pnpm install`, `pnpm --filter @ship/web test` (38 files / 390 tests),
`pnpm test` (api: 46 files / 604 tests), `pnpm build` (shared + api + web), `pnpm run type-check` —
all green.

**Rollback**: revert the two `package.json` edits — restore the
`"@tanstack/query-sync-storage-persister": "^5.90.18"` line to `web/package.json`'s `dependencies`,
delete the `"pnpm"."overrides"` block from the root `package.json` — then `pnpm install` to
regenerate `pnpm-lock.yaml`. Delete `web/src/lib/radixVersionDedupe.test.ts`.

---

## TRO-218 (A11Y-4) + TRO-222 (A11Y-8) — /issues Radix popovers open unnamed, and the selection column header is empty

Both are the last two accessibility gaps on /issues, the improvement target for Category 7
(all Critical/Serious axe violations fixed on the 3 most important pages). A11Y-4 was the last
open Serious; A11Y-8 the remaining Minor.

**What was broken — A11Y-4.** axe's "issues menu open" scan reported a Serious `aria-dialog-name`
violation: `<div data-state="open" role="dialog" id="radix-:rj:" class="z-50 w-[var(--radix-...">`
(`audit/a11y/axe/issues_menu_expanded_state.json`). Radix's `Popover.Content` defaults to
`role="dialog"` (`@radix-ui/react-popover` dist/index.mjs:243) with no name unless one is supplied.
`web/src/components/ui/Combobox.tsx:68` (the `Popover.Content` this class string belongs to) never
passed `aria-label`/`aria-labelledby`, so the popover the axe scan actually opened — the "Filter
issues by program" combobox, confirmed by inspecting the live DOM after the click — announced only
as an unnamed dialog.

**The mechanism is a shared wrapper, not a one-off.** `Combobox` is consumed by
`IssuesList.tsx` (program/project/sprint filters), `DocumentListToolbar.tsx` (the sort dropdown —
itself reused by `/issues`, `/projects`, `/programs`, and `/documents`), `IssueSidebar.tsx`
(assignee, week pickers), and `WeekSidebar.tsx` (owner picker). Fixing the one component clears the
unnamed-dialog defect on all of those surfaces. Every existing call site already passes
`aria-label` (verified: `grep -n "<Combobox" -A 12` across all 5 consumer files), so this is a
complete fix in practice; the fallback below is defense for any future caller that omits it.

A second, separate `Popover.Content` on the same page — the "Customize columns" picker inline in
`DocumentListToolbar.tsx:147` — is not the `Combobox` wrapper and had the identical defect
independently (its own unnamed Radix dialog). It shares the same page and the same missing-name
mechanism, so it is fixed alongside rather than left as a second unnamed dialog on /issues.

**What changed — A11Y-4.**
- `web/src/components/ui/Combobox.tsx:69` — `Popover.Content` now gets
  `aria-label={ariaLabel || placeholder}`, naming the dialog from the caller's label (or, if a
  future caller omits it, the always-present placeholder text) instead of leaving it unnamed.
- `web/src/components/DocumentListToolbar.tsx:148` — the column-picker's own `Popover.Content`
  gets `aria-label="Customize columns"`, matching its trigger button's existing label.

**What was broken — A11Y-8.** The same scan reported a Minor `empty-table-header` violation:
`<th class="w-10 px-2 py-2" aria-label="Selection"></th>` (same JSON file). The `<th>` already
carried `aria-label="Selection"` — but axe's `empty-table-header` rule checks only the
`has-visible-text` alternative (axe-core 4.11.1 `axe.js`: `{ id: 'empty-table-header', any:
['has-visible-text'] }` — no `aria-label`/`aria-labelledby` fallback, unlike most other
name-required rules in the same file). That check's evaluator (`hasTextContentEvaluate` →
`subtree_text_default`) walks the element's rendered subtree text; an `aria-label` attribute never
populates it. The header needed actual (visually-hidden) text content, not just an ARIA attribute.

**What changed — A11Y-8.** `web/src/components/SelectableList.tsx:134` — the selection column
`<th>` now wraps a `<span className="sr-only">Select</span>` instead of carrying only
`aria-label="Selection"`. `sr-only` is the repo's existing visually-hidden utility class (already
used nearby, in this same file's selection announcer at line ~192).

**Evidence.** Both measured on this branch, same conditions: worktree ports (`.factory-env`,
API `:3413` / web `:5586`), seeded via `pnpm db:seed` (104 issues), authenticated as
`dev@ship.local` via a fresh `session_id` obtained through `/api/csrf-token` + `/api/auth/login`,
axe-core 4.11.1 via `@axe-core/playwright`, Chromium (Playwright 1.57.0's bundled build), scanning
`/issues` static and after clicking the first `button[aria-haspopup], [aria-expanded]` control
(the same selector `audit/a11y/axe-scan.mjs` uses for its "issues menu/expanded state"). "Before"
was measured by copying the three fixed files aside, `git checkout --` reverting them to `HEAD`,
scanning, then restoring the copies — never `git stash` (this repo's shared-stash hazard, see
`lessons.md`).

| Measurement — /issues | Before | After |
|---|---|---|
| static: all severities | C0 S0 M0 **m1** | C0 S0 M0 **m0** |
| static: `empty-table-header` | 1 node (`th[aria-label="Selection"]`) | absent |
| menu open: all severities | C0 **S1** M0 **m1** | C0 S0 M0 m0 |
| menu open: `aria-dialog-name` | **Serious**, 1 node | absent |
| menu open: `empty-table-header` | Minor, 1 node | absent |

**Regression tests.**
- `web/src/components/ui/Combobox.test.tsx` — renders the real `Combobox`, opens the popover, and
  asserts the `role="dialog"` element has an accessible name (one test with an explicit
  `aria-label`, one exercising the placeholder fallback). Needed two jsdom environment shims
  (`ResizeObserver`, `Element.prototype.scrollIntoView`) that `cmdk` requires and jsdom doesn't
  implement — same class of shim as `EmojiPicker.test.tsx`'s `IntersectionObserver` stub, not a
  stub of the component under test. Confirmed red first: before the fix, both tests failed with
  `Error: expect(element).toHaveAccessibleName() — Received: ""` — not an environment error (the
  shims were already in place at that point) or an import failure.
- `web/src/components/SelectableList.test.tsx` — renders `SelectableList` with `selectable` and
  asserts the selection `<th>`'s `textContent` is non-empty, deliberately checking subtree text
  rather than accessible name so the test fails for the same reason axe's rule does. Confirmed red
  first: `AssertionError: expected '' not to be ''`.

**How to run it.**

```bash
pnpm --filter @ship/web test -- src/components/ui/Combobox.test.tsx src/components/SelectableList.test.tsx
pnpm --filter @ship/web exec tsc --noEmit
```

To re-measure against a browser: start the worktree's API and Vite, log in for a fresh
`session_id` (via `/api/csrf-token` then `/api/auth/login`), open `/issues`, run an axe scan, then
click the program-filter (or sort, or column-picker) button and scan again.

**Roll back.** Revert the three `aria-label`/`sr-only` additions (`git revert` the commit on
`fix/a11y-4-8-issues-page`), or drop them individually — `Combobox.tsx:69`,
`DocumentListToolbar.tsx:148`, `SelectableList.tsx:134-138`. The regression tests fail immediately
if any of them come back unnamed/empty.

**Not established.** What a screen reader actually announces for either fix — this closes the axe
contract violations (a name exists, and discernible text exists), but no human ran VoiceOver
against either surface. The repo's three Playwright a11y specs were not re-run here (not executed
by the factory gate; they also only assert `impact === 'critical'`, and both these findings were
already below that threshold, so they would not have caught either one regardless).

---

## TRO-193 (ERR-6) / TRO-227 (TEST-5) — Abandoning a pending inline comment now always removes its highlight mark

Starting a comment via the bubble menu or `Cmd+Shift+M` sets a `commentMark` — a TipTap **Mark**,
i.e. persisted, Yjs-synced document content (`web/src/components/editor/CommentMark.ts:69`), not a
decoration — before any comment row exists. Only an explicit `unsetComment` call removes it. Before
this fix, the *only* path that ever called `unsetComment` was the pending input's own `keydown`
handler seeing `Escape` with the input itself as `event.target`
(`CommentDisplay.tsx`'s `handleDOMEvents.keydown`, previously ~line 322) — which requires the input
to already hold focus. It is focused in a `requestAnimationFrame` scheduled after the widget mounts
(`CommentDisplay.tsx:259-263`).

**Two confirmed mechanisms, one root cause (unset-on-abandon had no owner):**

- **ERR-6 — blur / click away had no handler at all**, not a race. Grepping
  `CommentDisplay.tsx`/`Editor.tsx` for any blur, click-outside, or `focusout` handling around the
  pending comment found none. `audit/error-handling/raw/probe8-comment-orphan-blur.json` confirms
  this end-to-end: the mark is written into persisted content with **0** backing comment rows and
  survives a reload.
- **TEST-5 — Escape genuinely races the auto-focus `requestAnimationFrame`.** Confirmed, not just
  hypothesized: `e2e/inline-comments.spec.ts:118` failed both attempts in 2 of 3 audit runs
  (`audit/test-quality/runs/e2e-run1-failures.txt`, `-run3-failures.txt`) with the highlight still
  present after `page.keyboard.press('Escape')`, which sends the key to whatever currently has
  focus — not to the not-yet-focused pending input.

**The fix.** Rather than patch each dismissal path separately, `CommentDisplay.tsx`'s
`commentDisplay` ProseMirror plugin gets a `view()` lifecycle that is the single owner of the
"abandon a pending comment" invariant: document-level capture-phase listeners for `keydown`
(Escape) and `mousedown` (outside click), plus a `focusout` listener for a real blur/Tab-away, all
gated only on `storage.pendingCommentId` — never on the event's target or on whether focus has
reached the input. A `destroy()` callback abandons any still-pending comment when the editor itself
goes away (component unmount, or a route change that recreates the editor for a different
document). Submitted comments are tracked (`onSubmitComment` marks the id before clearing
`pendingCommentId`), so `onCancelComment` is a no-op for a comment that was actually created —
the invariant is "a mark may only remain if its comment was created," in both directions. The
Escape branch in `handleDOMEvents.keydown` was removed as dead/duplicate code now that the
document-level listener supersedes it; Enter-to-submit is unchanged.

**Provenance on route-change/unmount:** verified, not just reasoned about. `Editor.destroy()` ->
`EditorView.destroy()` calls `destroyPluginViews()` (which invokes our `destroy()`) *before* it nulls
`docView`, so `editor.commands.unsetComment(...)` still dispatches correctly from inside that
callback (confirmed empirically — see the regression test below, not just read from
`prosemirror-view`'s source).

**Regression tests — `web/src/components/editor/CommentDisplay.test.ts`** (new, vitest, driving a
real `@tiptap/core` `Editor` with the real `CommentMark` + `CommentDisplayExtension`, same pattern as
`DetailsExtension.test.ts`/`MentionExtension.test.ts`):

1. Blur/outside-click (`mousedown` outside the widget) dismissal leaves no `commentMark` in the doc
   JSON (ERR-6).
2. A genuine `focusout` on the pending input itself, to something outside the widget, also leaves no
   mark — exercised directly rather than assuming `mousedown` coverage implies it (see CodeRabbit
   triage below).
3. Escape dispatched with focus still on `document.body` — the pending input rendered via a forced
   decorations recompute but its `requestAnimationFrame` focus callback deliberately never flushed —
   leaves no mark (TEST-5's exact race, reproduced without fake timers by simply never yielding to
   let the rAF run).
4. A normally-submitted comment keeps its mark, including through a subsequent outside click/Escape
   (the "don't strip a real comment" half of the invariant).
5. Bonus: destroying the editor while a comment is still pending (route change/unmount) also
   removes the mark.

**Red before green.** All of 1/3/5 failed against the pre-fix `CommentDisplay.tsx` (copied aside via
`git show HEAD:...`, never `git stash`) with `AssertionError: expected true to be false` on
`hasCommentMark(editor)` — the exact behavior claimed, not an import error or a crash. Case 4 (happy
path) passed both before and after, confirming it was never broken and isn't a false positive. Case 2
was added afterward (see below) and verified red by temporarily disabling only the `focusout`
listener registration — that one test failed while the other four stayed green, confirming it
exercises that listener specifically rather than being redundant with the `mousedown` case. All five
pass against the fix.

**CodeRabbit review (G9), triaged:**

- **Major, applied** — a real click-away fires both the capture-phase `mousedown` and (as its native
  consequence) a `focusout` on the pending input before `storage.pendingCommentId` round-trips back
  to `null` via the React state update that clears it, so both listeners could call
  `onCancelComment` for the same id. Added an `abandonedPendingId` guard so it fires exactly once per
  pending comment — harmless today given `unsetComment`'s idempotency, but a real sharp edge for any
  future non-idempotent `onCancelComment`.
- **Minor, applied (corrected)** — added test case 2 above for direct `focusout` coverage. The
  suggested diff dispatched the event on `editor.view.dom`, which does not satisfy
  `isInsidePendingWidget(event.target)` and would not have exercised the intended branch; dispatched
  on the pending input itself instead, and verified it actually reds when that listener is disabled.
- **Minor, applied** — the "click elsewhere" test target is a plain `div`, not a `button` (no
  interactive semantics needed for an arbitrary outside-click target).
- **Minor, applied** — the e2e reload assertion now waits for the actual persisted text to reappear
  before asserting the highlight is gone, and asserts a DOM count of `0` rather than
  `not.toBeVisible()` (see e2e section below).

**e2e:** `e2e/inline-comments.spec.ts:118` (`canceling a comment removes the highlight`) already
asserted the right thing (`.comment-highlight` not visible after Escape) and needed no strengthening.
Added `dismissing a comment by clicking away removes the highlight` for ERR-6, which had zero e2e
coverage before, including a reload check matching probe8's persistence finding — waits for the
actual persisted text to reappear before asserting the highlight is gone (not just the editor shell
being visible, which could pass vacuously while content is still loading), and asserts a DOM count of
`0` rather than `not.toBeVisible()` (CodeRabbit finding, applied). Not executed as part of this
change — no prebuilt `api`/`web` `dist` exists in this worktree, so `e2e/global-setup.ts` would
trigger a full fresh build of both packages; the jsdom unit tests above already give real
red-before-green proof of both mechanisms, so that cost wasn't justified here.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run src/components/editor/CommentDisplay.test.ts
pnpm --filter @ship/web exec tsc --noEmit -p tsconfig.json
```

**Rollback.** `git checkout main -- web/src/components/editor/CommentDisplay.tsx
e2e/inline-comments.spec.ts && git rm web/src/components/editor/CommentDisplay.test.ts` and drop
this entry. No schema or API change accompanies this fix.

---

## TRO-247 — [RULE-6] One-command local start from a clean checkout

**What changed.** `./start.sh` at the repo root: from a genuinely clean checkout, one command
installs dependencies if needed, ensures the database exists, runs every migration, seeds sample
data, finds free ports, starts both servers, and prints the resolved URLs. Re-running it is safe —
every step is idempotent, so a second run heals a partially-set-up checkout instead of assuming
yesterday's state still holds.

`start.sh` is a thin preflight (Node/pnpm on PATH, with actionable install instructions if not) that
hands off to `scripts/dev.sh`, which now does the actual database bootstrap unconditionally (not
only when `api/.env.local` is missing, as before) and is also what `pnpm dev` runs — one
implementation, not two that can drift apart.

`scripts/dev.sh` previously shelled out to `psql`/`createdb` to create the database, which are
absent on any machine that only runs Postgres via Docker with the port published to the host (this
project's own factory machine is one — `ship-audit-pg` on `:5433`). New `api/src/db/ensureDatabase.ts`
replaces that with a plain `pg` connection to the server's `postgres` maintenance database, which
works identically over TCP for a native install or a Docker container — no shell dependency either
way, and it fails with an actionable message ("start it, then re-run — here's the native command and
the Docker command") when Postgres is unreachable at all, rather than a bare `createdb` error.

New `api/src/db/verifyMigrations.ts` makes the DB-1 (TRO-178) fix's "42/42 applied" claim an
executed check rather than a trusted exit code: it reuses `migrationRunner.ts`'s own
`listMigrationFiles()` — the exact file discovery the fixed runner uses — and compares it against
`schema_migrations`, printing `Migrations: 42/42 applied` or failing loudly, naming the missing
files, if the runner's guarantee is ever violated. `migrate.ts`/`migrationRunner.ts` themselves are
unchanged; DB-1's fix (throw-on-any-failure) was independently re-confirmed live in this tree by
running `migrationRunner.test.ts`'s real-migration-set suite against a throwaway database (7/7
passing) rather than only re-reading the code.

DATABASE_URL resolution (documented in `scripts/dev.sh`'s header): an explicit `DATABASE_URL` env var
always wins; otherwise an existing `api/.env.local` keeps its own value (a plain re-run never
silently switches databases under a configured worktree); otherwise the same default as before
(`postgresql://localhost/$DB_NAME`, native Postgres, no password). The README's new "Cold start"
section documents both bundled Docker Postgres options (`docker-compose.yml` on :5432,
`docker-compose.local.yml` on :5433) with the exact `DATABASE_URL` override for each.

README also corrects one stale claim while updating this: the fork banner's hazard list still
described root `pnpm test` as silently skipping `web/` (TEST-1). That was already fixed by TRO-223
(PR #11, `pnpm run test:api && pnpm run test:web`) — the banner text already said "resolved" in one
place but the "Getting Started" section had not been reconciled with `start.sh`. Both now describe
current behavior only.

**Regression tests.** `api/src/db/__tests__/ensureDatabase.test.ts` (9 cases: identifier validation,
create-when-missing, idempotent no-op, and the actionable unreachable-Postgres message — confirmed
red-before-green by temporarily removing the `CREATE DATABASE` call and observing the exact two
tests fail for the right reason) and `api/src/db/__tests__/verifyMigrations.test.ts` (2 cases: a
fully-migrated database reports N/N, and a DB-1-shaped gap — a `schema_migrations` row deleted out
from under an otherwise-complete database — is detected and named). No `!`, `as any`, or fixed
sleeps anywhere in the diff; the one bounded wait (Postgres connection) uses a `connectionTimeoutMillis`
on the client, not a sleep.

**How to run it.** `./start.sh` from a clean checkout. To target Docker Postgres instead of a native
install: `docker compose -f docker-compose.local.yml up -d postgres && DATABASE_URL=postgresql://ship:ship_dev_password@localhost:5433/ship_dev ./start.sh`.
A throwaway database name works the same way: `DATABASE_URL=.../a_new_name ./start.sh`.

**Rollback.** Revert the merge of `fix/rule-6-one-command-start`. `scripts/dev.sh` reverts to only
bootstrapping the database when `api/.env.local` is absent, and back to requiring `psql`/`createdb`
on PATH; `pnpm dev`/`pnpm db:migrate`/`pnpm db:seed` are unaffected as standalone commands either way.

---

## TRO-248 — [RULE-7] Retries, timeouts and circuit breakers on outbound calls

Assignment rule 7 asks for an assessment of every outbound-call boundary in the ticket's table,
not just a pile of new retry code — several rows had already been addressed by other merged
tickets since the table was written, and re-verifying that against current code is itself part of
the deliverable.

**Row-by-row verdicts (current code, re-checked, not taken from the ticket text):**

1. **`api/src/db/client.ts:24` `connectionTimeoutMillis: 2000`, hardcoded pool `max` 10/20.**
   Confirmed still hardcoded. **Gap — fixed.** See below.
2. **`statement_timeout: 30000` hardcoded.** Confirmed. **Assessed, no change.** This is a
   runaway-query/DDoS guard (its own comment says so), the same category as `index.ts`'s server
   timeouts below — not a "waiting on a dependency that might be slow" value, so the tunability
   argument for row 1 doesn't apply to it.
3. **`api/src/index.ts:31-33` server timeouts (Slowloris protection).** Confirmed unchanged,
   confirmed deliberate (inline comment says so). **Assessed, no change**, per the ticket's own
   steer.
4. **`web/src/lib/queryClient.ts` 429 handling.** The ticket's premise — "429 is never retried" —
   is **stale**. `shouldRetryRequest`/`retryDelayMs` (added under TRO-172/API-1, commit
   `9f3885c`, well before TRO-248 was written) already retry HTTP 429 with a jittered backoff
   schedule (`THROTTLE_RETRY_DELAYS_MS = [2000, 8000, 20000, 45000]`, summing past the server's
   60s rate-limit window) for **both** `queries` and `mutations` — the client's
   `defaultOptions.mutations.retry`/`retryDelay` are wired to the same predicate, not left on
   react-query's default (which does treat every 4xx, including 429, as permanent). Every other
   4xx (400/401/403/404/409/422) is still correctly treated as permanent.
   `web/src/lib/queryClient.test.ts` (pre-existing, 11 cases) already pins this for both query and
   mutation defaults, including "still retries 5xx", "gives up on 429 eventually", and "backs off
   past the rate-limit window". Checked PR #51 (`fix/err-13-err-14-editor-save-paths`, open) for
   collision: it edits `queryClient.ts` too, but only to add `notifyDocumentGoneOnRead()` after the
   write-outcome bus — it does not touch the retry-policy section, so there is no conflict.
   **No code change; verified only.**
   One adjacent, narrower gap noticed but out of this ticket's table and not fixed here:
   `UnifiedDocumentPage.tsx:79` sets `retry: false` on the top-level document-by-id query, and its
   `queryFn` throws plain `Error`s with no `.status` attached — so even without the override, a
   429 on that specific fetch wouldn't be recognized as throttling by `shouldRetryRequest`. Worth
   its own ticket; not touched here (drive-by fixes outside this ticket's table are out of scope).
5. **`api/src/config/ssm.ts` — no timeout, no retry.** Confirmed: `getSSMSecret` awaited
   `client.send(command)` directly. TRO-243 (`11e93b6`) added a fallback to env-supplied secrets
   *after* a failure, but nothing bounded how long a single attempt could hang or retried a
   transient one. **Gap — fixed.** See below.
6. **Circuit breakers: none, strongest candidate the collaboration WebSocket.** Checked whether
   ERR-1/ERR-2's merged fix already does this job. Two things verified in the current tree, not
   assumed:
   - `y-websocket`'s `WebsocketProvider` (the client the editor uses,
     `node_modules/y-websocket/src/y-websocket.js:158-167`) already reconnects on exponential
     backoff (`2^wsUnsuccessfulReconnects * 100ms`, capped at `maxBackoffTime` = 2500ms by
     default) — a bounded retry schedule already exists for the transient case, from the library,
     with no code in this repo re-deriving it.
   - ERR-1/ERR-2's merged fix (`Editor.tsx:441-495`) sets `wsProvider.shouldConnect = false` on
     the three permanent-failure close codes (4401 session invalid, 4403 access revoked, 4100
     document converted) — i.e. it **opens the breaker and leaves it open** on exactly the
     conditions where retrying could never succeed, rather than reconnecting forever against a
     doomed socket. `SyncStatusIndicator` (ERR-1) then reports the true unsynced state instead of
     a false "Saved". Together, bounded-backoff-for-transient plus stop-forever-for-permanent plus
     truthful state surfacing **is** the behavior a circuit breaker is for.
   **Assessed, no change** — building a second breaker here would duplicate a job already done,
   which the ticket itself flagged as the risk to check for.

**What changed.**

- **`api/src/db/poolConfig.ts` (new).** Pure `resolvePoolTiming(env)` — same pattern as the
  existing `ssl.ts`/`resolveDatabaseSsl` decision file — resolving `connectionTimeoutMillis` from
  `DB_POOL_CONNECTION_TIMEOUT_MS` and pool `max` from `DB_POOL_MAX` (production) /
  `DB_POOL_MAX_DEV` (else), each falling back to today's hardcoded values (2000ms, 20/10) for any
  unset, empty, non-numeric, zero, negative, **or fractional** override — `Number.isInteger`, not
  just `Number.isFinite`, because a pool size or millisecond timeout of `1.5` is as meaningless as
  `"abc"` (CodeRabbit caught the original version accepting fractional overrides). `client.ts` now
  calls it instead of inlining the numbers; **defaults are unchanged**, so behavior does not change
  unless an operator sets one of the three env vars. Failure mode this protects against: `ssl.ts`'s
  own file header already documents what a fixed 2000ms timeout does against a managed Postgres
  with a slow cold start — every connection attempt in that window fails and, under
  restart-on-crash infra, the process crash-loops before the database is ever actually reachable.
- **`api/src/config/ssm.ts`.** `getSSMSecret` now runs each SSM call through `sendWithRetry`: a
  5s per-attempt timeout (`AbortController` passed as `send`'s `abortSignal`, per the
  `@aws-sdk/client-ssm` `HttpHandlerOptions` shape) and up to 3 total attempts, backing off between
  them with full jitter capped at 2000ms (`Math.random() * min(200 * 2^attempt, 2000)`) so that
  the five parameters `loadProductionSecrets` fetches concurrently (`Promise.all`) don't retry in
  lockstep if they all fail on the same underlying blip. The `SSMClient` is now constructed with
  `maxAttempts: 1`, so this file's loop is the **only** retry layer — the SDK's own default
  (`maxAttempts: 3` with its own internal backoff) would otherwise silently compound with it,
  making "3 total attempts" untrue and applying this file's jitter schedule to the wrong layer
  (CodeRabbit caught the first version missing this). `ParameterNotFound` — what the real SSM API
  actually rejects with for a genuinely missing name, not a resolved-with-empty-value response as
  the first version of this fix assumed — is classified as non-retryable and propagates on the
  first attempt; a resolved-but-empty-value response (belt-and-braces, in case that shape is ever
  possible) is also not retried, for the same reason. Exhausting the retryable attempts re-throws
  into the existing `loadProductionSecrets` catch block unchanged, so the already-correct
  fallback-to-env-vars behavior from TRO-243 is untouched. Concurrency note (rule 18): this is a
  bounded, one-shot retry inside a single awaited call, not a `setInterval` —
  `loadProductionSecrets()` is invoked exactly once, in `index.ts`'s `main()`, before the app is
  created, so there is no in-flight-guard question.

**Regression tests (new).**

- `api/src/db/__tests__/poolConfig.test.ts` — 15 cases: defaults match the previous hardcoded
  values; `DB_POOL_CONNECTION_TIMEOUT_MS`/`DB_POOL_MAX`/`DB_POOL_MAX_DEV` overrides apply
  independently per `NODE_ENV`; malformed overrides (empty/non-numeric/zero/negative/**fractional**)
  fall back to the default rather than propagating `NaN` or an unsafe pool size. New capability
  with unchanged defaults, not a bug fix — no pre-existing broken behavior to reproduce red for;
  confirmed green against the implementation.
- `api/src/config/ssm.test.ts` — 7 cases against a mocked `SSMClient`, fake timers driving the
  timeout/backoff (no real waiting): success-first-try; retries-then-succeeds; exhausts all 3
  attempts and throws the last transient error; a hung call is bounded by the per-attempt timeout
  and then retries; a successful-but-"not found" response is never retried; **the real
  `ParameterNotFound` rejection** the live API actually throws is never retried either (1 `send`
  call only); the `SSMClient` is constructed with `maxAttempts: 1`.
  **Confirmed red before the fix**, for the right reason: reverted `ssm.ts` to the pre-fix version
  (copied aside, not stashed — the `git stash` ref is shared across every worktree in this repo per
  `lessons.md`) and re-ran the same test file. 3 of 5 cases present at that point failed: "retries a
  transient failure" failed with the raw `ECONNRESET` propagating (no retry existed); "gives up
  after exhausting attempts" failed on `expected 3 calls, got 1`; "bounds a hung call" failed with a
  `TypeError` reading `abortSignal` off `undefined`, because the old code never passed a second
  argument to `send` at all — a faithful demonstration that no timeout wiring existed, not a typo
  in the test. The other 2 cases passed unchanged on old code (a first-try success and a "not
  found" response were never going to exercise retry logic either way). Restored the fix; all 7
  (after the `ParameterNotFound`/`maxAttempts` additions below) pass.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api exec vitest run \
  src/db/__tests__/poolConfig.test.ts \
  src/config/ssm.test.ts \
  src/db/__tests__/ssl.test.ts
```

**Rollback.** Revert this ticket's commits. `client.ts` and `ssm.ts` return to their previous
inline values with no functional loss elsewhere — nothing else imports `poolConfig.ts`, and
`loadProductionSecrets`'s fallback behavior (TRO-243) is untouched either way.

---

## TRO-235 (TF-2) — prod had two divergent Terraform roots; converged onto the flat root

**HOLD FOR HUMAN APPROVAL.** This entry documents a deletion of tracked infra config
(`terraform/environments/prod`), which is an escalation-gate-2 item. The PR carries the same
banner; nothing here has been applied to real infrastructure — no `terraform apply`/`destroy`/
live `init` was run, per the hard safety rules for this ticket.

**The problem.** Prod was managed by two independent Terraform root configs with separate state:
the flat `terraform/*.tf` (74 resource blocks) and the modular `terraform/environments/prod` +
`terraform/modules/*` (66 resource blocks). They had already drifted — the flat root had a WAF
(`waf.tf`) and CloudFront realtime logging (`cloudfront-logging.tf`) the modular path lacked
entirely — and nothing prevented both from being applied to the same AWS account, which would
collide on hard-coded resource names. `audit/AUDIT_REPORT.md` (TF-2) and
`audit/terraform/baseline.md` have the full analysis.

**What changed.**

- Deleted `terraform/environments/prod/` (5 files, including its own `.terraform.lock.hcl`) —
  the actual TF-2 duplicate. Confirmed unused by any deploy tooling first: `scripts/deploy.sh`,
  `scripts/deploy-web.sh`, and `scripts/terraform.sh` all route `prod` to the flat `terraform/`
  root unconditionally and never reference `environments/prod`.
- Diffed every one of the 66 modular resource blocks against the flat root by type+name before
  deleting (full reconciliation table in the PR body). Three genuinely missing security-hardening
  arguments were found and ported into the flat root instead of silently dropped:
  - `database.tf` — 5 Aurora parameter-group settings (`max_connections`,
    `idle_in_transaction_session_timeout`, `statement_timeout`, `log_connections`,
    `log_disconnections`) that `modules/aurora/main.tf` had and `database.tf` did not.
  - `elastic-beanstalk.tf` — 8 CPU-based autoscaling trigger/cooldown settings that
    `modules/elastic-beanstalk/main.tf` had and `elastic-beanstalk.tf` did not.
  - `ssm.tf` — `secretsmanager:PutSecretValue` on the EB instance role's Secrets Manager policy.
    Without it, `saveCAIACredentials()` (`api/src/services/secrets-manager.ts:136`) gets
    `AccessDenied` from `PutSecretValueCommand` the first time it updates an *existing* CAIA
    secret under prod's real IAM role — `CreateSecret`/`UpdateSecret` alone do not cover it. This
    is a real, currently-live bug in the flat root that the modular path had already fixed.
- **`terraform/environments/dev`, `terraform/environments/shadow`, and `terraform/modules/*` are
  kept — this is a deliberate deviation from "remove environments/ + modules/ entirely."** TF-2's
  finding is specifically that prod is managed by two configs; dev and shadow are different,
  non-overlapping AWS environments the flat root cannot deploy at all (its resource names are
  hard-coded for prod). `scripts/deploy.sh`/`scripts/deploy-web.sh`/`scripts/terraform.sh`
  currently route dev and shadow exclusively through `terraform/environments/$ENV`, and
  `CLAUDE.md` documents shadow as an active step in the merge workflow ("Deploy to shadow ...
  before merging to master"). Deleting modules/dev/shadow would have silently broken that live
  tooling for no TF-2 benefit — it was never part of the "same infrastructure" collision. See the
  PR body for the full reasoning; this is flagged prominently for human review, not buried.
- `scripts/check-single-tf-root.sh` (new) — fails if a second AWS Terraform root (a directory with
  a `.tf` file declaring `provider "aws"`) exists outside the allowed set (`terraform`,
  `terraform/bootstrap`, `terraform/environments/dev`, `terraform/environments/shadow`), or if
  `terraform/environments/prod` specifically reappears. Wired into `.github/workflows/ci.yml` as
  a step in the `verify` job, right after checkout (pure bash/grep, no dependencies).
- `terraform/README.md` — new "Authoritative config for prod" section explaining the convergence,
  why, and what happened to the modular path (including the dev/shadow exception above); directory
  structure diagram, multi-environment rationale, and Quick Start updated to match (prod is no
  longer under "Environment Directories").

**What did NOT change.** No flat-root resource files were rewritten beyond the three additions
above (`database.tf`, `elastic-beanstalk.tf`, `ssm.tf`); `security-groups.tf` was read for the
reconciliation but not touched (a sibling ticket, TF-7, is editing it concurrently). No provider
version pin or lock file changed (TF-3/TF-4 are separate tickets).

**How to run it.**

```bash
# Terraform binary: temp-downloaded 1.9.8 (matches audit/terraform/baseline.md; the repo's pinned
# 1.6.0 cannot `init` at all — TF-3, expired provider-signing key). Not committed to the repo.
cd terraform
terraform init -backend=false -input=false
terraform validate
terraform fmt -check -recursive .
rm -rf .terraform .terraform.lock.hcl   # leaves git status terraform/ clean, per audit methodology
cd ..

./scripts/check-single-tf-root.sh   # run from repo root; should print "OK: single authoritative Terraform root confirmed"
```

**Verification note.** `terraform validate` was run on the flat root before AND after this change
with the same 1.9.8 binary: both report `Success!` with the same single pre-existing warning
(TF-5, `s3-cloudfront.tf:426`'s uploads lifecycle rule) — this change introduces no new warnings or
errors. `terraform/environments/dev` and `terraform/environments/shadow` were also validated
post-change (unaffected, since neither was edited) and both still pass with the same TF-5 warning.
The guard script was verified to actually fail: tested with a simulated re-added
`terraform/environments/prod` (caught) and a simulated new sibling root directory outside
`terraform/` entirely (also caught), both removed before committing. The audit's cloud-free
drift-demo (`audit/terraform/drift-demo/`) was not re-run — it demonstrates local-provider drift
detection unrelated to this ticket's root-convergence change, so re-running it would not verify
anything this PR touches.

**Rollback.** `git revert` the commit(s) on `fix/tf-2-unify-terraform-roots`. This restores
`terraform/environments/prod` and reverts the three ported arguments in `database.tf`,
`elastic-beanstalk.tf`, and `ssm.tf` — returning to the pre-TRO-235 two-root state (i.e.
un-fixing TF-2). It does not touch any live AWS state, since no `apply` was ever run against
either root.

---

## TRO-299 — [TF-10] Render-provider Terraform config for the deployed fork

Ship's Render deployment (`ship` / `srv-d9kf2t942hec73aofrt0`, `ship-db` /
`dpg-d9kgth6417fc7386hhh0-a`) was hand-built via the dashboard and one-off API calls — the last
piece of Category 8 not backed by Terraform (`memory-bank/techContext.md`: "Not yet
Terraform-managed — the service and database were created by hand and API call."). This adds a
config that can reproduce it.

**What changed.**

- **`terraform/render/`** (new): `versions.tf` pins `render-oss/render` `1.9.1` (verified latest
  stable on the public registry) and `required_version >= 1.9.0`; `postgres.tf`/`web_service.tf`
  declare `render_postgres.ship` (pg16, oregon, free) and `render_web_service.ship` (docker
  runtime, this repo/`main`, oregon, free, health check `/health`); `variables.tf` gives every
  input a description, with `render_api_key`/`session_secret` marked `sensitive = true` and no
  real default. `DATABASE_URL` is derived from `render_postgres.ship.connection_info.internal_connection_string`
  (a resource reference, never a literal). `outputs.tf` deliberately omits anything sensitive.
- **`terraform/render/terraform.tfvars.example`** (new): placeholders only.
- Root `.gitignore` gains `terraform/render/*.tfplan` and `terraform/render/tfplan` — the one
  genuine gap: no existing pattern covered a captured plan file under this new directory.
  `terraform/.gitignore`'s pre-existing, unrelated `*.tfvars` / `.terraform/` / `*.tfstate*`
  patterns (no leading slash, so unanchored — they already apply recursively under `terraform/`)
  turn out to **already cover** `terraform/render/`'s `.terraform/` cache, `terraform.tfvars`, and
  state files, verified empirically against the pre-this-ticket version of that file. **This
  corrects `memory-bank/techContext.md`**, which asserted "a new `terraform/render/terraform.tfvars`
  would NOT be ignored" — that check looked only at the root file's `terraform/`-specific lines and
  missed the nested file's blanket coverage; filed as a memory-bank correction rather than silently
  treated as a non-issue. One negation, `!render/.terraform.lock.hcl` (added to the nested file),
  so this directory's provider lock file is committed — deliberately unlike every other `terraform/*`
  subdirectory, none of which commit theirs (the gap TF-4 flagged for the flat root specifically).
- **`terraform/render/README.md`** (new): verified-vs-on-record fact table, why this directory
  sits inside `terraform/` given PR #41's single-root guard (it wouldn't be flagged either way —
  the guard greps for `provider "aws"`, and this declares `provider "render"`), confirmation that
  `audit/terraform/drift-demo/` already satisfies the local-provider deliverable (2 pinned
  `local_file` resources — no changes needed there), and the import-vs-apply adoption memo.
- **`terraform/render/plan/plan-annotated.md`** (new): the captured, redacted `terraform plan`
  output plus one-sentence-per-resource blast-radius annotations.

**Verified live against the Render API (2026-07-30)**, via `GET /v1/services/{id}`,
`/v1/postgres/{id}`, `/v1/services/{id}/env-vars` (names only), `/v1/owners` — not re-derived from
the memory bank: service id/name/region/runtime/plan/URL, health check path (now set to `/health`,
newer than an older memory-bank note calling it unset), repo/branch/auto-deploy/Dockerfile path,
database id/name/region/version/plan, owner id, and that the three expected env var names
(`DATABASE_URL`, `SESSION_SECRET`, `CORS_ORIGIN`) are the only ones set. One fact only *partially*
confirmed: Postgres `ipAllowList` reads `null` via the API, not `[]` — functionally equivalent per
the provider's docs but not a byte-for-byte match, called out as such in the README rather than
rounded up to "verified."

**What did NOT change / was not run — hard safety rules.** No `terraform apply` or
`terraform import` ran against the live account; `terraform plan` is read-only and was run with
real credentials (`RENDER_API_KEY` sourced from the gitignored repo-root `.env`, never printed,
echoed, or committed). The plan shows `2 to add, 0 to change, 0 to destroy` — Terraform proposing
brand-new resources, because nothing was imported; this is the expected "hand-built resource, empty
state" collision the ticket anticipated, not a defect, and is not "fixed" here. The
adoption-path decision (import vs. a clean-machine apply that creates a parallel service) is a
human call — see the PR body's **"HOLD FOR HUMAN: apply/import decision (gate 2)"** and the memo in
`terraform/render/README.md`.

**Regression test: honestly, none applies.** This ticket's deliverable is Terraform configuration
and documentation — there is no `api/**/*.test.ts` or `web/**/*.test.tsx` change for
`scripts/factory/gate.sh`'s regression-test check (G6) to find, and it is expected to fail
honestly rather than be satisfied by a manufactured vitest case with nothing to regress-test. The
real verification is `terraform validate` (clean, no warnings) + `terraform fmt -check -recursive`
(clean, after one formatting pass) + the live `terraform plan` capture referenced above, all shown
in the PR body.

**How to run it.**

```bash
cd terraform/render
terraform init -input=false          # downloads render-oss/render 1.9.1
terraform validate
terraform fmt -check -recursive .
cp terraform.tfvars.example terraform.tfvars   # fill in session_secret; gitignored
set -a; source ../../.env; set +a              # RENDER_API_KEY
terraform plan -var-file=terraform.tfvars -input=false
```

**How to roll it back.** Delete `terraform/render/`, revert the two `.gitignore` edits. Nothing on
Render itself needs rolling back — no `apply`/`import` ever touched the live account.

---

## TRO-208 — [TS-3] The Yjs <-> TipTap converter — the persistence path for every document's content — was fully untyped

`api/src/utils/yjsConverter.ts` carried 12 `any` in 245 lines, the highest any-per-line density of
any production file, on the only code path that translates collaborative CRDT state into the
durable `documents.content` column: `collaboration/index.ts:151` (`persistDocument()`, right before
the write) and `routes/documents.ts:456` (content served over REST). `api/src/types/y-protocols.d.ts`
added 7 more `any` on the awareness/sync surface underneath. Every exported signature was untyped —
`yjsToJson(fragment): any`, `jsonToYjs(doc, fragment, content: any)`,
`loadContentFromYjsState(yjsState): any | null` — so a shape regression here would silently corrupt
or drop user-authored content with nothing failing to compile.

**What changed — types only, no behavior change.**

- **`api/src/types/tiptap.ts` (new).** One recursive TipTap/ProseMirror JSON node type —
  `TipTapNode` (`type`, optional `attrs`/`content`/`marks`/`text`), `TipTapMark`, `TipTapDoc`, and the
  `TipTapAttrValue` union (`string | number | boolean | null`) node/mark attributes actually hold.
  Kept API-local by design (see "Not done" below).
- **`yjsConverter.ts`** — all five signatures now use these types instead of `any`:
  `yjsToJson(fragment): TipTapDoc`, `jsonToYjs(doc, fragment, content: TipTapNode): void`,
  `loadContentFromYjsState(yjsState): TipTapDoc | null`, plus the internal
  `extractTextWithMarks`/`yjsElementToJson`. A new `typeAttributes()` helper centralizes the one
  existing `Record<string, unknown>` -> typed-attrs conversion (unchanged logic, just typed); a new
  `setAttributeValue()` helper centralizes the one real, documented gap this fix could not type away:
  Yjs's own ambient `XmlElement.setAttribute` pins attribute values to `string`, but this codebase has
  always written some attributes (a numeric heading `level`) using their real JS type and relies on
  Yjs's runtime not enforcing that — a `value as string` assertion there is the one non-`any` cast in
  the diff, isolated and commented rather than repeated at each of the two call sites it used to
  appear at.
- **`y-protocols.d.ts`** — `any` replaced with `unknown` throughout (transaction origins, awareness
  state records, event callback args), except `Awareness.on`/`off`, which gained a real overload for
  the one event this codebase actually listens for (`AwarenessChange { added, updated, removed }`)
  plus a loose `unknown[]` fallback for anything else — a fully untyped variadic callback would have
  accepted a mistyped `'update'` handler just as silently as a correct one.
- **`collaboration/index.ts`** — two type-only edits, no control-flow change: `isTipTapDocContent`'s
  type predicate now asserts `value is TipTapDoc` instead of an inline `{ type: 'doc'; content:
  unknown[] }`, so its narrowed value satisfies `jsonToYjs`'s new parameter type.
- **`collaboration/__tests__/api-content-preservation.test.ts`** — this pre-existing test file calls
  `yjsToJson`/`loadContentFromYjsState` directly and, once they stopped returning `any`, tripped real
  `noUncheckedIndexedAccess` errors on chained array indexing (`convertedBack.content[0].content[0].text`)
  that `any` had been silently swallowing. Fixed with optional chaining (`?.`) and one narrowing
  `if (!result) throw ...` for the nullable `loadContentFromYjsState` case — no assertion was
  loosened; all 18 cases in the file still pass unchanged.

**Found, not fixed (out of scope for a types-only ticket).** Writing the round-trip regression test
below surfaced a real, pre-existing behavioral quirk: `jsonToYjs`/`jsonToYjsChildren` apply text
marks via Yjs's native `YXmlText.format()`, but `yjsToJson`'s read side only recognizes marks
represented as nested `Y.XmlElement` wrapper tags (e.g. `<bold>...</bold>`), which is how the actual
browser TipTap/y-prosemirror binding represents them — not how `.format()` does. `YXmlText.toString()`
(`node_modules/yjs/src/types/YXmlText.js:68-100`) serializes format-delta attributes back as literal
pseudo-XML baked into the plain-text string, so round-tripping a marked text node through
`jsonToYjs` -> `yjsToJson` produces `{ type: 'text', text: '<bold>bold</bold>' }`, not a `marks` array.
This only fires on the one-time JSON->Yjs migration path for documents created via the API and never
opened in the collaborative editor before their first collaboration-server load
(`collaboration/index.ts`'s `loadDoc()`) — verified present, byte-for-byte identical, on both the
unfixed and fixed code (see measurement below), so it predates this ticket and this fix does not
touch it. Worth a follow-up finding; not attempted here per the ticket's explicit "types-only, no
behavior change" scope.

**Not done.** Promoting `TipTapNode`/`TipTapDoc` to `shared/` so the frontend imports the identical
type is a natural next step but is TS-5's business (the `shared/` contract is a separate, open
finding), not this ticket's.

**Regression test — `api/src/utils/__tests__/yjsConverter.test.ts`** (new, vitest, run by the gate).
Two independent parts, per the ticket:

1. Six `expectTypeOf` assertions (`yjsToJson`/`jsonToYjs`/`loadContentFromYjsState` each `.not.toBeAny()`
   plus `.toEqualTypeOf<...>()`) proving the exported signatures are real types. These are
   compile-time-only — `vitest run` transpiles via esbuild and does not evaluate them, so they pass
   silently either way at runtime; verified red **only** via `tsc --noEmit`, by temporarily restoring
   the pre-fix `yjsConverter.ts`/`y-protocols.d.ts`/`collaboration/index.ts` (backed up first, no
   `git stash`) and re-running `pnpm --filter @ship/api exec tsc --noEmit`. Against the unfixed code
   it fails with real, on-point errors — `TS2349: This expression is not callable` on each
   `.not.toBeAny()`, and `TS2344: Type 'TipTapDoc' does not satisfy the constraint 'never'` on each
   `.toEqualTypeOf<...>()` — not an import error or a typo. Restoring the fix returns `tsc --noEmit`
   to clean.
2. Two runtime round-trip tests: a representative document (heading with a numeric `level` attr,
   a paragraph with bold text and a link mark, a nested 2-item bullet list) through
   `jsonToYjs` -> `yjsToJson`, and a second through a real binary Yjs update via
   `loadContentFromYjsState`. Both pin the exact output observed by running the conversion directly
   (`tsx`, no DB) against both the unfixed and fixed `yjsConverter.ts` and diffing — byte-for-byte
   identical — proving the types change altered nothing at runtime, including the marks quirk noted
   above.

**Measurement** (`~/.claude/skills/type-safety-audit/scripts/count.sh`, the audit's own method —
`explicit_any` pattern `:\s*any\b|<any>|\bany\[\]|Array<any>`, BSD grep, counts matching lines):

| Scope | Before | After |
|---|---|---|
| `api/src/utils/yjsConverter.ts` | 12 | **0** |
| `api/src/types/y-protocols.d.ts` | 7 | **0** |
| `api/` package-wide (`explicit_any`) | 78 | **59** (-19) |

The api-wide before (78) matches `audit/type-safety/baseline.json`'s tracked `perPackage.api.anyTotal`
exactly; the -19 delta is precisely the two files' combined reduction, confirmed by isolated
before/after counts on every other file this diff touches (`collaboration/index.ts` and
`api-content-preservation.test.ts` are unchanged on every tracked metric — `explicit_any`,
`as_assertions`, `as_any`, `non_null_assertions` — before vs after). The regex undercounts by its own
documented blind spot (`Record<string, any>` doesn't match `:\s*any\b|<any>`, since `any` isn't
preceded directly by `:`): two such sites in each of `yjsConverter.ts` and `y-protocols.d.ts` were
fixed too and are real reductions the tracked number doesn't reflect.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api exec tsc --noEmit
pnpm --filter @ship/api exec vitest run \
  src/utils/__tests__/yjsConverter.test.ts \
  src/collaboration/__tests__/api-content-preservation.test.ts
```

**Rollback.** `git checkout main -- api/src/utils/yjsConverter.ts api/src/types/y-protocols.d.ts
api/src/collaboration/index.ts api/src/collaboration/__tests__/api-content-preservation.test.ts &&
git rm api/src/types/tiptap.ts api/src/utils/__tests__/yjsConverter.test.ts` and drop this entry. No
schema, route, or runtime-behavior change accompanies this fix, so rollback is type-signature-only.

---

## TRO-206 (TS-1) — `web/tsconfig.json` now extends the root config; 156 latent type errors fixed

`web/tsconfig.json` re-declared `strict: true` standalone instead of extending `../tsconfig.json`,
so it silently ran without the root's `noUncheckedIndexedAccess`, `noImplicitReturns`, and
`noFallthroughCasesInSwitch` — the only two packages that extend the root (`api`, `shared`) had
them; `web` did not. `research/configs/web/tsconfig.json` (a reference copy in the repo) already
`extends: "../tsconfig.json"`, confirming this was drift, not an intentional divergence.

**Ticket hypothesis vs. observed.** The audit (measured at commit `076a183`) recorded 102 errors
under the restored flags. Reproducing the identical command
(`cd web && ./node_modules/.bin/tsc -p tsconfig.json --noEmit --noUncheckedIndexedAccess
--noImplicitReturns --noFallthroughCasesInSwitch`) on this branch's base — `main` had gained ~30
merged tickets since the audit, adding new files (`lib/contrast.ts`, `lib/contrast.test.ts`,
`pages/MyWeekPage.contrast.test.tsx` from TRO-217, plus other unrelated changes) — produced **156**
errors, not 102: 63 TS2532, 41 TS18048, 26 TS2345, 17 TS2322, 8 TS7030, 1 TS18047, across 29 files.
The fix direction held; the count was stale. All 156 are fixed, not just the original 102.

**What changed.**

- `web/tsconfig.json` — added `"extends": "../tsconfig.json"`; kept web's `target`/`lib`/`module`/
  `moduleResolution`/`jsx`/`noEmit`/`baseUrl`/`paths` overrides (all of which differ from or add to
  the root, e.g. `module: "ESNext"` + `moduleResolution: "bundler"` vs. the root's `NodeNext`, and
  `lib` adding `DOM`/`DOM.Iterable`). Dropped the overrides that were byte-identical to the root
  (`strict`, `skipLibCheck`, `esModuleInterop`, `allowSyntheticDefaultImports`,
  `forceConsistentCasingInFileNames`, `isolatedModules`) since inheriting them is the whole point.
- `web/tailwind.config.d.ts` — the hand-written ambient type for `tailwind.config.js` typed
  `colors` as a bare `Record<string, string>`, so every dot-accessed token (`palette.background`,
  `palette.muted`, ...) came back `string | undefined` under the restored flag. Gave the six tokens
  actually dot-accessed by `contrast.ts`/`contrast.test.ts`/`MyWeekPage.contrast.test.tsx` explicit
  (non-optional) properties, kept a `[key: string]: string` index signature so dynamic lookups
  (`palette[name]`) stay honestly optional.
- 28 source files fixed with genuine narrowing — destructure-then-check, explicit `undefined`
  guards, or an `?? null`/`?? ''` fallback at the point a nullable value crosses into a non-nullable
  slot. No `!`, `as any`, `as unknown as`, or `: any` anywhere in the diff (`node
  scripts/factory/review-patterns.mjs` — G7b — reports clean). Densest: `CommandPalette.tsx` (13),
  `hooks/useSelection.ts` (12), `editor/CommentDisplay.tsx` (12), `editor/AIScoringDisplay.tsx` (12),
  `lib/cn.ts` (12).
- `pages/ReviewsPage.tsx` — the one fix that is more than type-satisfying. Three optimistic-update
  handlers (`approvePlan`, `requestChanges`, `rateRetro`) did
  `updated.reviews[personId][weekNumber] = { ...updated.reviews[personId][weekNumber], patch }`.
  Spreading `undefined` is legal JS and this type-checked before the fix, but for a person/week
  pair with no prior review row it silently produced a `ReviewCell` missing every field except the
  one just patched (`hasPlan`/`hasRetro`/`sprintId`/`planDocId`/`retroDocId` all `undefined` instead
  of their contract). Extracted `emptyReviewCell`/`mergeReviewCellPatch` (both exported) so all
  three handlers merge over a real default instead of a possibly-missing lookup.
  **Reachability, checked rather than assumed:** every UI path that can call these three handlers
  (`ReviewsPage.tsx:919-935`, `:1115`) is gated on `cell.hasPlan`/`cell.hasRetro` already being
  `true`, which requires an already-fetched cell — so this specific corruption was not reachable
  through today's UI. It is a genuine type-safety fix against a real invariant gap, not a
  demonstrated production crash; recorded as such rather than oversold.

**What did NOT change.** No product behavior. `pnpm --filter @ship/web test` is 37 files / 366
tests green before and after (quarantine is already empty per TEST-1); the fixes are narrowing,
not behavior changes, with the one exception above, which changes nothing observable given the
current gating.

**How to run it.**

```bash
source .factory-env
# Reproduce the flag-restoration count (should be 0 now that tsconfig extends root):
cd web && ./node_modules/.bin/tsc -p tsconfig.json --noEmit \
  --noUncheckedIndexedAccess --noImplicitReturns --noFallthroughCasesInSwitch
# Or just the normal check, since the flags are now inherited permanently:
pnpm --filter @ship/web type-check
# Regression test for the ReviewsPage fix:
pnpm --filter @ship/web exec vitest run src/pages/ReviewsPage.reviewCellMerge.test.ts
```

**Rollback.** Revert the commits on `fix/ts-1-web-tsconfig`. Reverting just
`web/tsconfig.json`'s `extends` line restores the pre-fix (silently non-strict) behavior without
touching the 29 narrowed files, which remain correct either way since the narrowing is a strict
superset of the original logic. `emptyReviewCell`/`mergeReviewCellPatch` can be reverted
independently by inlining the old spread in the three `ReviewsPage.tsx` handlers, which restores
the (unreached, per above) invariant gap.

---

## TRO-286 (TEST-14) — no e2e test can pass without executing an assertion any more

TEST-2 (TRO-224) fixed the 8 vacuous tests that gave false *security* assurance and deliberately
stopped, reporting the boundary. This finishes the job and clears two adjacent defects it surfaced.

**Part 1 — the remaining conditional-only tests: 62 → 0.**

Measured with the repo's own detector, `audit/test-quality/runs/vacuous.mjs`, which finds tests
whose every `expect()` sits inside a conditional branch — i.e. tests that pass with zero assertions
executed. On `main` (`c4e92c2`) it reports `testsWithOnlyConditionalExpects: 62`. On this branch it
reports **0**, across the same 870 scanned test blocks.

Every `if (await x.isVisible()) { …expects… }` became an assertion carrying an actionable message,
per the pattern already in `bulk-selection.spec.ts:793`. Converted tests also record *why* the
precondition holds, so the next reader does not re-derive it — seed data creates sprints from
`currentSprintNumber-2` through `+2` (`e2e/fixtures/isolated-env.ts`), so completed sprints always
exist; `cleanupExtraSprints` in `beforeEach` guarantees an empty future week window.

By file: `program-mode-week-ux.spec.ts` (33), `accessibility-remediation.spec.ts` (6),
`context-menus.spec.ts` (6), `features-real.spec.ts` (5), `performance.spec.ts` (2),
`admin-workspace-members.spec.ts` (2), `ai-analysis-api.spec.ts` (1), plus 7 more not named in the
ticket's table that the detector caught.

Two of these were more than a mechanical conversion. `admin-workspace-members.spec.ts` needed the
fixture work the ticket flagged as risky — `isolated-env.ts` now seeds a second workspace and an
unattached user — and the workspace-switcher and admin-dashboard specs were checked for fallout.
`features-real.spec.ts` turned out to be hiding a **real file-chooser race** behind its guard, which
is exactly the failure mode a silently-passing test conceals.

**Part 2 — a user was being told the wrong rate limit.** `api/src/services/ai-analysis.ts` enforces
`RATE_LIMIT = 120`/hour while `api/src/routes/ai.ts` told the user "Max 10 analysis requests per
hour" — off by 12×. Rather than pick a number, the message is now derived from the constant
(`RATE_LIMIT_MESSAGE`), so the two cannot drift apart again, and `api/src/routes/ai.test.ts` (new)
asserts the 429 body reports the enforced limit.

The e2e test that provoked this is marked `test.fixme()` **with a written reason** rather than left
lying. Asserting the real limit needs either 121 requests — 120 of which attempt Bedrock, blowing
the 60s timeout — or an injectable limit, which is a production seam added solely to enable a test.
That is a maintainer's call, not the factory's, and is left open deliberately.

**Part 3 — `.husky/pre-commit` is now `100755` in the index**, where it was `100644`. It *did* still
run, because `core.hooksPath` is `.husky/_` and husky v9's wrapper **sources** the hook rather than
exec'ing it — but that made the mode a latent trap: if the wrapper ever exec'd instead, every
pre-commit check would stop running silently, including the compliance scan.

The ticket carried an unreproduced report that hooks do not fire in a linked worktree. **That is
now disproved**: committing from `Ship-wt-tro_286` (a linked worktree) fired `check-empty-tests.sh`
and `check-api-coverage.sh` and printed their output, as did every commit from the main checkout
throughout the run. Hooks fire in both.

Unrelated but worth stating plainly: `comply` is not installed in this environment, so the secrets
scan warns and passes. **A successful commit is not evidence that scan ran.**

**Part 4 — CodeRabbit review triage on PR #40.** 22 line comments, all real defects in code this PR
touched, none out of scope — every finding was either fixed here or dismissed with a written reason
in the ledger (`audit/factory/review-findings.jsonl`), never silently dropped.

Six were Majors that reintroduced the exact defect class this ticket exists to fix: two fixed
`waitForTimeout` sleeps standing in for synchronization (`admin-workspace-members.spec.ts`,
`program-mode-week-ux.spec.ts`, plus siblings in `issue-display-id.spec.ts` and
`status-colors-accessibility.spec.ts`), the swallowed-failure pattern
`isVisible().catch(() => false)` in an availability-indicator check, a `dashCount === rowCount`
comparison that could pass while filtering nothing correctly (`td` filtered by `—` also matches
assignee/estimate/due-date cells), a near-tautological "highlight" check that matched every card in
the timeline regardless of active state, and non-deterministic fixture restoration in the carol/Test
Space cleanup (`isVisible().catch(() => false)` could silently skip removing her, leaving the next
test in the worker to find her already attached).

Fixing finding 18 (point-in-time `rows.count()` preconditions) surfaced three tests in
`program-mode-week-ux.spec.ts` — "issue row has quick menu (⋮) button" and its two siblings — that
assert a per-row hover-revealed actions button. Traced the full render path
(`IssuesList.tsx` → `IssueRowContent` → `SelectableList.tsx`): no such button exists in list view,
only a right-click context menu and the bulk "Move to Week" toolbar action already covered
elsewhere. TRO-286 Part 1 had already tightened these from "passes whether the feature exists or
not" to a real assertion, which would now fail hard, not vacuously — same shape as the
team-directory quick-menu gap already `test.fixme()`'d in `context-menus.spec.ts`. Marked
`test.fixme()` with the same reasoning rather than left to fail.

One finding was dismissed rather than fixed: WCAG 3.3.3 recovery guidance on the login-error test.
The message is exactly `"Invalid email or password"` (`api/src/routes/auth.ts`), a deliberate
security choice, and `Login.tsx` has no recovery link at all — tightening the assertion would only
ever fail without a UI change, which is a product accessibility gap, not a test bug. Filed as a
follow-up rather than fixed here.

One derived claim was checked and found not to transfer: CodeRabbit's suggested fix for the fixed
sleeps in `program-mode-week-ux.spec.ts` was `page.waitForResponse(...)` on `/api/issues`. Traced
`IssuesList.tsx:569-570` — the sprint filter dropdown filters already-fetched issues client-side; no
new request fires when it changes. Used a retrying DOM assertion instead, which is what the
mechanism actually calls for.

**How to run it.**

```bash
node audit/test-quality/runs/vacuous.mjs        # expect testsWithOnlyConditionalExpects: 0
git ls-files -s .husky/pre-commit               # expect mode 100755
pnpm --filter @ship/api test src/routes/ai.test.ts
```

The Playwright specs themselves need a live app — use `/e2e-test-runner`, never `pnpm test:e2e`
directly, which produces enough output to crash the session.

**Roll back.** `git revert` this merge commit. The conditional guards return (and with them the 62
silently-passing tests), the 429 message goes back to quoting 10/hour against 120/hour enforcement,
and `.husky/pre-commit` reverts to mode `100644`. No schema, API surface, or product behaviour is
touched by any of it — the only production change is the text of one error message.

---

## TRO-246 (rule 5) — CI builds the image once and pushes it by SHA; Render still rebuilds it a second time (switch prepared, not executed)

TRO-242 made the root `Dockerfile` buildable from a clean checkout (multi-stage: builds
`shared`→`api`→`web` inside the image, instead of requiring pre-built `dist/` in the build context).
That closed the "build on a laptop" problem but not the "build once" one: CI verified the source, and
then Render separately built the *same* Dockerfile itself, on its own infrastructure, at its own
time — two independent builds of the same commit, never proven to be the same artifact.

**What changed.**

- `.github/workflows/ci.yml` gains a `build-image` job that builds the root `Dockerfile` with
  `docker/build-push-action` and pushes to `ghcr.io/troysatchell/ship`, authenticated with the
  workflow's own `GITHUB_TOKEN` (job-scoped `permissions: packages: write`). `needs: verify`, so it
  never runs on code that failed typecheck/build/the test-regression check.
  - Tags: the full git SHA (immutable — the identity a rollback promotes/demotes by) and a moving
    `main` tag.
  - Pushes only on an actual push to `main` (`SHOULD_PUSH` gate). Every pull request still **builds**
    (unauthenticated, no push) — this proves the Dockerfile stays buildable from whatever the PR
    changed, without ever needing registry credentials (which a fork PR's `GITHUB_TOKEN` doesn't have
    write scope for anyway).
  - Third-party actions (`docker/setup-buildx-action`, `docker/login-action`,
    `docker/build-push-action`) are pinned to full commit SHAs, matching this file's existing
    convention for non-`actions/*` steps.
- `docs/deployment-artifact-lifecycle.md` (new): what's built, where it's stored, the tagging
  scheme, and — the actual "promote" and "roll back to a previous SHA" procedures — plus a
  ready-to-run Render switch runbook.
- `docs/application-architecture.md`: one-line pointer from the (stale, AWS-only) Deployment section
  to the new doc and to `memory-bank/techContext.md`'s Render facts, so the two don't silently
  diverge further. The AWS-only diagram/infra list itself is untouched — out of scope here.

**What did NOT change — the Render switch itself is prepared, not executed.** Changing the live
`ship` service (`srv-d9kf2t942hec73aofrt0`, currently `runtime: docker` building the Dockerfile on
Render's own infrastructure) from a repo-build to an image-deploy is an outward-facing, largely
irreversible action against the graded submission URL (`https://ship-rr6m.onrender.com`) —
escalation gate 2. No Render API call was made, no credential was read or moved, and the repo-root
`.env` was not touched. `docs/deployment-artifact-lifecycle.md`'s runbook is the exact procedure for
whoever runs it, including the parts that could not be independently verified from here (Render's
`image` field on the Update Service API is documented to exist but its full sub-schema was not
reachable this session — flagged explicitly, with a documented dashboard fallback that needs no
schema guessing).

**Regression test: honestly, none applies.** This ticket's deliverable is a CI workflow change plus
documentation — there is no application code path for a vitest regression test to exercise, and
`scripts/factory/gate.sh`'s regression-test check (G6, which counts added `it(`/`test(` cases in
`*.test.ts`/`*.test.tsx`/`*.spec.ts`) is expected to fail honestly rather than be satisfied by a
manufactured, vacuous test. YAML validity of the workflow file was checked instead — see PR body for
the exact method (the repo's own `js-yaml` dependency, since `actionlint` is not installed here).

**How to run it.**

```bash
# Local build proof — same Dockerfile path CI runs, from a clean tree:
docker build -t ship:tro-246-local -f Dockerfile .
docker images ship:tro-246-local   # 482 MB, observed this session

# YAML-validate the workflow (repo's own transitive js-yaml dep, no actionlint installed):
node -e "require('./node_modules/.pnpm/js-yaml@4.1.1/node_modules/js-yaml') \
  .load(require('fs').readFileSync('.github/workflows/ci.yml','utf8')); console.log('ok')"

# The real test of the CI behavior itself is derived, not run here — the first push to `main`
# after this merges is the live test of build-image actually pushing to GHCR.
```

**How to roll it back.**

- CI job: revert the `build-image` addition to `.github/workflows/ci.yml`; `verify`/`inventory` are
  untouched and keep running exactly as before.
- Docs: delete `docs/deployment-artifact-lifecycle.md` and revert the one-line pointer in
  `docs/application-architecture.md`.
- Nothing to roll back on Render — the switch was never executed.

---

## TRO-216 — [A11Y-2] `aria-expanded` on a plain `<div>` in the editor wrapper

**What was broken.** axe reported a Critical `aria-allowed-attr` violation on `.tiptap-wrapper >
div`: `<div style="position: relative;" aria-expanded="false">` — a plain `<div>` with no role,
carrying an ARIA attribute that role does not support. It only appeared in the "editor focused"
state, which is why the repo's own axe specs (which scan static viewports) never caught it.

**The mechanism — found, not guessed.** `.tiptap-wrapper > div` is the `<div>` `@tiptap/react`'s
`<EditorContent>` renders to host the ProseMirror view; once mounted it is also
`editor.options.element`. The comment `<BubbleMenu>` in `Editor.tsx` (~line 1008) is implemented by
`@tiptap/extension-bubble-menu`'s `BubbleMenuPlugin`, whose `BubbleMenuView.createTooltip()`
(2.27.2, `dist/index.js:122-136`) calls `tippy(editorElement, { interactive: true, ... })` the
first time the selection or doc changes after mount — i.e. `editorElement` **is**
`editor.options.element`, the same div. tippy's default `aria: { expanded: 'auto' }` combined with
`interactive: true` makes it call `referenceEl.setAttribute('aria-expanded', ...)` on that div
unconditionally (`tippy.js`'s `handleAriaExpandedAttribute`, `dist/tippy.cjs.js:801-813`), whether
or not the bubble menu is ever shown. The `position: relative;` inline style on the same node is a
second, independent library write to the identical element — `DragHandleExtension`
(`web/src/components/editor/DragHandle.tsx:206`) sets it on `view.dom.parentElement`, which is the
same wrapper — confirming both clues in the axe `html` string point at one node for two unrelated
reasons.

The div itself does not expand or collapse anything; it is only tippy's positioning anchor for the
floating "Comment" button. This is subtraction, not a role fix — there was never a widget here.

**What changed.** `web/src/components/Editor.tsx`: the comment `<BubbleMenu>`'s `tippyOptions` is
now a named export, `commentBubbleMenuTippyOptions`, with `aria: { expanded: false }` added. That
tells tippy never to manage `aria-expanded` on its reference element for this instance. No
behavioural change: the bubble menu still shows and hides identically on selection; only the
ARIA bookkeeping attribute on the unrelated wrapper div is suppressed. The element does not become
focusable and no keyboard behaviour changes, so this does not require the escalation path for a
user-perceivable interaction change.

**Evidence.** Both ends measured on this branch, same conditions: `http://localhost:5906`
(worktree ports), Chrome for Testing (Playwright 1217 build) headless, 1440×900, axe-core 4.11
(`@axe-core/playwright`), authenticated as `dev@ship.local` via a fresh `session_id`, wiki document
`7b254b07-e251-46bc-8e14-d4e10b76dd2b` ("Welcome to Ship"), editor focused by clicking into
`.ProseMirror`. Each measurement restarted the Vite dev server first and the served module content
was diffed directly (`curl .../src/components/Editor.tsx`) to confirm which code path was live
before scanning — Vite's dev transform cache does not always invalidate on save alone.

| Measurement — "document editor focused" | Before | After |
|---|---|---|
| axe `aria-allowed-attr` | **Critical, 1 node** (`.tiptap-wrapper > div`) | **absent** |
| axe all severities | **C1** S0 M0 m0 | **C0** S0 M0 m0 |

**Regression test.** `web/src/components/Editor.bubbleMenuAria.test.tsx` imports the real
`commentBubbleMenuTippyOptions` from `Editor.tsx` (not a copy) and calls the same `tippy(...)`
invocation `BubbleMenuView.createTooltip()` makes, against a stand-in `.tiptap-wrapper > div`,
asserting no element carries `aria-expanded`. It does not mount the real `<BubbleMenu>` +
`<EditorContent>` + a driven selection change: `@tiptap/extension-bubble-menu` is only a transitive
dependency of `web` (not resolvable directly from a test file), and its prebuilt ESM bundle's own
`import tippy from 'tippy.js'` does not interop cleanly through vitest's module runner reached via
that path — confirmed by direct experiment (`tippy` resolves to the whole CJS exports object, not
the callable, only through that nested import chain; a direct `import tippy from 'tippy.js'`
in a test file resolves correctly). That is a pre-existing environment limitation of this
dependency chain, not a defect under test — the same class `LazyEditor.test.tsx` already documents
("mounting real TipTap + Yjs in jsdom proves ... a great deal about jsdom").

Confirmed red first, for the right reason: with the unfixed (no `aria` key) options object, the
test failed with `AssertionError: Expected the element not to have attribute: aria-expanded /
Received: aria-expanded="false"` — not an import error or a locator failure.

**How to run it.**

```bash
pnpm --filter @ship/web test src/components/Editor.bubbleMenuAria.test.tsx
pnpm --filter @ship/web exec tsc --noEmit
```

To re-measure against a browser: start the worktree's API and Vite (`.factory-env` ports), log in
for a fresh `session_id`, open a wiki document, click into `.ProseMirror` to focus the editor, then
run an axe scan and check `aria-allowed-attr` is absent.

**Roll back.** Remove `aria: { expanded: false }` from `commentBubbleMenuTippyOptions` in
`Editor.tsx` (or `git revert` the commit on `fix/a11y-2-editor-aria`). The regression test fails
immediately if it comes back.

**Not established.** What a screen reader announces about the comment bubble menu — this fix only
removes an invalid ARIA attribute axe can detect; no human ran VoiceOver against it. The repo's
three Playwright a11y specs were not re-run here (not executed by the factory gate; they also only
assert `impact === 'critical'`, which this finding already was, so they would have caught it had
they scanned the focused-editor state — they scan static viewports only).

---

## TRO-190 (ERR-3) + TRO-191 (ERR-4) — the sync indicator stops claiming "Saved" over a write it never confirmed

Both findings are the same lie from two different causes. ERR-3 is a rejected title/property write
(429/500 on a PATCH). ERR-4 is a write against a document someone else already deleted (404).
Neither reaches the Yjs collaboration socket `SyncStatusIndicator` (TRO-188/ERR-1) watches — title
and properties are not CRDT content, they go straight over REST — so both used to leave the
indicator reading "Saved" with a rejected value still sitting in the field. `probe6-mixed.json`
(6.1/6.2): forced 429 then 500 on a rename, DB title unchanged both times, indicator stayed
"Saved". `probe7-retry-and-revocation.json` (7a): 14 PATCH attempts, a transient "Failed to update
document" toast fires, indicator still "Saved". `probe4-concurrency.json` (4c): another user
deletes the open document; this user's own typing keeps failing with 404, with **no** notice beyond
a console error on backlinks the user never sees.

**What changed.**

- `web/src/lib/queryClient.ts` gains `isNotFoundError`/`NOT_FOUND_STATUS` (same shape as the
  existing `isThrottleError`/`THROTTLE_STATUS` from API-1) and a small document-write-outcome bus
  (`subscribeToDocumentWriteOutcome`), fed from the real `MutationCache`'s `onError` (extended) and a
  new `onSuccess`, for any mutation tagged `meta.documentId`.
- `web/src/hooks/useDocumentWriteStatus.ts` (new) subscribes to that bus filtered to one
  `documentId`, exposing `hasFailedWrite` and calling `onDocumentGone` exactly once per document
  when a write 404s — so a retry storm (probe7a's 14 attempts) cannot open 14 blocking alerts.
- `web/src/components/editor/SyncStatusIndicator.tsx` — reused, not replaced: `deriveSyncIndicator`
  gains one optional input, `hasFailedWrite`, checked ahead of `isSynced`. A rejected write now
  overrides an otherwise-fully-synced Yjs socket and returns the exact same "Not saved" (red) view
  ERR-1 already built. No new state, no new copy in the indicator itself.
- `web/src/components/Editor.tsx` calls `useDocumentWriteStatus(documentId, () => alert(...))` and
  passes `hasFailedWrite` into the indicator. The one-time notice reuses the exact `alert()` pattern
  already in this file for the 4403 (access revoked) and 4100 (document converted) WebSocket close
  codes — not a new toast/modal system.
- `web/src/pages/UnifiedDocumentPage.tsx`'s `updateMutation` now attaches `.status` to the thrown
  error (it previously threw a bare `Error`, so `errorStatus()` could not see 429 vs 404 vs 500 at
  all) and tags `meta: { operation: 'update document', documentId: id }` so the bus above fires for
  it.

**New user-facing copy** — `Editor.tsx`, shown once per document, via the same blocking `alert()`
ERR-1's sibling fixes already use for this class of event:

> This document was deleted by someone else. Your changes here were not saved - copy anything you
> want to keep before leaving this page.

No other new copy or flow. The indicator itself reuses ERR-1's existing "Not saved" label and
detail text verbatim — this PR adds no new indicator copy.

**What did NOT change.** The field keeping the user's typed-but-unsaved text is pre-existing
`Editor.tsx` behaviour (`hasLocalChangesRef` / the `initialTitle` sync effect) and is untouched here
— rolling back the optimistic query-cache entry on a failed write never overwrote it, before or
after this fix. This PR only changes what the indicator is allowed to claim.

**Correcting TRO-190's own cross-reference.** TRO-190 describes ERR-3 as blocked on API-1's retry
predicates returning `false` for every 429/500. API-1 (TRO-172) is merged and that is no longer
true: `shouldRetryRequest` (`web/src/lib/queryClient.ts`) already retries 429 up to 4 times (delays
summing past the 60s rate-limit window) and plain 5xx/network errors up to 3 times, globally, as
the default for every mutation. The gap this PR closes is downstream of that: once retries
genuinely exhaust, nothing told the indicator. Separately, `UnifiedDocumentPage.tsx`'s mutation had
no `.status` on its thrown error, so a 429 hitting *this* mutation specifically fell back to the
generic 3-retry/1-2-4s schedule instead of the tuned one — too short to outlast the 60s window —
which this PR also fixes as part of attaching `.status` for the 404 case.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run \
  src/components/editor/SyncStatusIndicator.test.tsx \
  src/hooks/useDocumentWriteStatus.test.ts \
  src/lib/queryClient.test.ts
scripts/factory/gate.sh
```

**Verification note.** `probe6.1/6.2/7a/4c` need a live app with forced 429/500/404 responses; they
were not re-run here. The tests above drive the real `queryClient` `MutationCache` config directly
(the same technique `MutationErrorToast.test.tsx` already used for API-1) rather than a mock or a
mounted page, so they prove the actual production wiring reacts correctly — that is mutation-layer
proof, not a rerun of the original browser-level probes.

**Rollback.** Revert the commit(s) on `fix/err-3-err-4-silent-write-failure`. To disable
independently: pass `hasFailedWrite={false}` (or omit it) from `Editor.tsx` to restore ERR-1's
original indicator behaviour without touching `UnifiedDocumentPage.tsx`; or remove the
`meta: { documentId }` line there to stop the bus from ever firing for document writes.

---

## TRO-282 — [TEST-13] Program Weeks tab linked to a dead `/sprints/` route and bounced the user out

**Reproduced first, as the ticket required.** The finding was derived (read from `main.tsx` and
`UnifiedDocumentPage.tsx`, "nobody has reproduced this in a browser"). A component test rendering the
real route tree (`documents/:id/*` -> `UnifiedDocumentPage` -> the real program tab config -> the
real `ProgramWeeksTab`) and clicking a week card confirmed it: the app logged
`Invalid tab "sprints" for document type "program", redirecting to base URL` and the location became
the bare `/documents/:id` — no tab, no selected week. The bug was real, not rescued by a fallback.

**Root cause.** `web/src/components/document-tabs/ProgramWeeksTab.tsx` (lines 28, 34, 71 as of this
branch) navigated to `/documents/:id/sprints/:sprintId` on selecting or opening a week, and back to
`/documents/:id/sprints` from the week detail view. Commit 7713ef0 renamed the program tab's id from
`sprints` to `weeks` in `web/src/lib/document-tabs.tsx`, but the tab's own navigation calls were never
updated. `UnifiedDocumentPage.tsx`'s tab-validation effect (~line 93-102) treats any URL tab segment
absent from `tabConfig` as invalid and redirects to the bare document URL — so every click bounced.
Same root commit as five of the thirteen TEST-1 failures; TRO-223 fixed the tab *label* half, this is
the navigation half, which no unit test covered.

**What changed.**

- `ProgramWeeksTab.tsx` — all three navigate targets now point at `weeks` instead of `sprints`.
- `UnifiedDocumentPage.tsx` — added a small `LEGACY_TAB_ALIASES` map (`{ program: { sprints: 'weeks' } }`)
  consulted by the invalid-tab effect. A URL segment matching a known legacy alias now redirects to
  the tab's current id (preserving any nested path, e.g. the sprint/week id) instead of being treated
  as a plain invalid tab and dropped to the document root.

**Decision: redirect, not 404, for old `/sprints/` links.** The rename already shipped, so a bookmark
or shared link from before it is a normal, expected case — a 404 would be a second, quieter defect (a
link that silently stopped working) layered on top of the first. Redirecting keeps those links alive
with the same behavior a fresh rename-aware click gets.

**Regression test — `web/src/pages/UnifiedDocumentPage.programWeeksNav.test.tsx`** (vitest, run by the
gate; this is the tier that actually executes, per `ship-qa`). Two cases:

1. Clicking a week card lands on `/documents/:id/weeks/:sprintId`, not the document root.
2. A bookmarked `/documents/:id/sprints/:sprintId` URL redirects to the equivalent `/weeks/` URL.

Confirmed red first, for the right reason: both cases failed with
`AssertionError: expected '/documents/prog-1' to be '/documents/prog-1/weeks/a1b2c3d4-…'`, and the
console carried the real `Invalid tab "sprints"...redirecting to base URL` warning — not a crash, not
a bad selector. After the fix, both pass with no warning.

**Also updated, additive only.** `e2e/program-mode-week-ux.spec.ts:369-417` asserted the stale
`/sprints/` URL after clicking/double-clicking a week card; updated to expect `/weeks/`. This suite is
not run by the gate or CI (`ship-qa`), which is exactly why the stale assertions never caught the
break — the vitest test above is the actual proof.

**How to run it.**

```bash
cd <worktree> && source .factory-env
pnpm --filter @ship/web test -- src/pages/UnifiedDocumentPage.programWeeksNav.test.tsx
```

**Roll back.** `git checkout main -- web/src/components/document-tabs/ProgramWeeksTab.tsx
web/src/pages/UnifiedDocumentPage.tsx e2e/program-mode-week-ux.spec.ts && git rm
web/src/pages/UnifiedDocumentPage.programWeeksNav.test.tsx` and drop this entry.

---

## TRO-288 — [TEST-15] session-activity-race's "did the burst race" precondition was a scheduling hope, not a guarantee

**Not one of the audit report's 68 baseline findings** — a merge-queue blocker introduced by the
DB-2/API-6 work (TRO-179/TRO-177, PR #13) that landed on `main` afterward.

**What was broken.** `api/src/middleware/__tests__/session-activity-race.test.ts` fires a burst of
10 concurrent `authMiddleware()` calls via `Promise.all` and expects all 10 to read the session's
stale `last_activity` before any of them writes it. On an idle box `Promise.all` starting all 10
calls in the same synchronous tick is normally enough. It is not a guarantee: this repo's CI job
runs on a 2-vCPU `ubuntu-latest` runner with Postgres as a co-located service container sharing
those same 2 vCPUs (`.github/workflows/ci.yml`) — a far more contended environment than a dev
box — where connection acquisition and query dispatch can serialize enough that a later request's
SELECT lands after an earlier request's UPDATE has already committed. That request then correctly
reads the just-refreshed row and correctly skips writing, collapsing `updateStatements` to 1 and
failing the test's own "did the burst actually race" precondition
(`session-activity-race.test.ts:216-219`, `toBeGreaterThan(1)`). Because the test lives on `main`,
the factory gate compared this against the quarantine baseline and reported it as a *new* failure on
branches that never touch auth — observed blocking PR #29 (failed CI, then passed on a plain re-run
of the identical commit) and PR #11 (failed CI on this single identity, `newFailures: 1`).

**Correcting the ticket's own framing.** The ticket (and this test's name) describes the fragile
half as "modifies the session row exactly once." Confirmed directly, not inferred: reproducing the
non-overlapping case (a throwaway experiment invoking the burst fully sequentially instead of via
`Promise.all`, deleted before this commit) produced `updateStatements=1, rowsModified=1` —
the *precondition* check failed while the *exactly-once* check still passed. The exactly-once
assertion held in every timing pattern tried (fully concurrent, half-staggered, fully sequential);
Postgres's `WHERE ... AND last_activity < $3` predicate arbitrates correctly regardless of arrival
order, exactly as DB-2 intended. The fragile half was never "exactly once" — it was "did the burst
race at all."

**What changed — `api/src/middleware/__tests__/session-activity-race.test.ts` only.** Added
`createArrivalBarrier()`, installed as a plain property reassignment of `pool.query` *underneath*
the existing `vi.spyOn` (not through `mockImplementation`, which would collapse `pool.query`'s
overloaded signature to its last — callback-style — form, the wrong shape for this codebase's
promise-based calls). Also added two dedicated, database-free unit tests for the barrier helper
itself (`describe('createArrivalBarrier ...')`) — the release-on-count-reached behavior and the
passthrough for non-matching SQL — so a regression in the barrier's own logic fails fast rather than
only showing up as a reintroduced flake in the concurrent-burst test. The barrier holds every
session-lookup SELECT until all 10 concurrent callers
have asked to send one, then releases them together.

**Concurrency argument.** While any of the 10 calls is waiting at the barrier, none of them has yet
sent its SELECT, so none has read anything, so none can have decided a write is due, so no UPDATE
can exist yet. That makes it structurally impossible for any of the 10 SELECTs to observe anything
other than the original stale `last_activity` — not "unlikely under contention" but unreachable by
construction, independent of how slow or reordered the surrounding scheduling is. Validated by
instrumenting the barrier with an arrival counter and confirming all 10 arrivals fire before release
(temporary, removed before this commit) — the mechanism engages on the real SQL, it is not a no-op.

No fixed sleep was added or would help — this is a timing-determinism fix, and a sleep only
narrows a race, it does not close it.

**Not touched:** `api/src/middleware/auth.ts` — the throttle and its `WHERE`-clause predicate are
correct and unchanged. Verified by temporarily reverting the predicate to the pre-DB-2 unconditional
`UPDATE sessions SET last_activity = $1 WHERE id = $2` (file copied aside, never `git stash`d, and
restored — `git diff` against this branch shows zero changes to `auth.ts`): the barriered test goes
red for the right reason, `AssertionError: expected 10 to be 1`, i.e. all 10 requests now
deterministically raced and all 10 landed a write against the broken code. Restored immediately
after.

**How to run it.**
```bash
source .factory-env
pnpm --filter @ship/api exec vitest run src/middleware/__tests__/session-activity-race.test.ts
```
10 consecutive runs passed under deliberate load: 14 CPU-bound busy-loop worker processes (pure
`Math.sqrt` summation, no I/O) saturating all 14 physical cores of the host (load average
~40-54 on a 14-core machine), plus 3 concurrent full `pnpm --filter @ship/api test` suite runs
against a separate scratch database on the shared `ship-audit-pg` container, generating simultaneous
Postgres contention alongside the CPU load. All scratch load (busy-loop processes, the extra
database) was torn down after measurement. Standalone (no artificial load) and the full local api
suite (592/592) also pass. **Not verified**: reproducing the original CI failure directly on this
14-core dev machine — 20+ standalone/loaded attempts under busy-loop and concurrent-suite load did
not reproduce a failure against the pre-fix test, consistent with the mechanism needing CI's
specific 2-vCPU-shared-with-Postgres constraint rather than raw CPU contention on a larger box. The
fully-sequential white-box experiment (above) is the direct confirmation of the failure mode in lieu
of that reproduction.

**How to roll it back.** Revert this commit; the prior test file returns with the same
scheduling-dependent precondition. No production code, migration, or other file changes to undo.

---

## TRO-223 (TEST-1) — the web unit suite is green, and `pnpm test` now actually runs it

**13 web unit tests failed, in 3 files, and the root `pnpm test` never ran them.** Root `"test"` was
`pnpm --filter @ship/api test`, so `pnpm test` reported green while those 13 stayed red. CI *did*
run the web suite (`.github/workflows/ci.yml:105-118`, under `continue-on-error` with a quarantine
diff), so the failures were visible there — they were invisible to anyone running the suite locally,
which is where they needed to be caught. The suite
was 151 tests when the factory captured its baseline and 172 by the time this branch measured it —
the same 13 failing in both. They were five months of accumulated drift that a suite nobody ran
could not catch.

**The judgement this ticket turned on: for each failure, was the test wrong or the source wrong?**
It was not uniform, and it did not fall the convenient way. Of the 13: **11 were stale
assertions**, **1 was a source defect**, and **1 was a defect in the test harness**.

*Stale tests — 11 (source was right, assertions were corrected — a correction, not a weakening):*

- **`sprints` → `weeks` (5 assertions).** `7713ef0` renamed the tab id in both the project and
  program configs. `e2e/project-weeks.spec.ts:121` navigates to `/documents/:id/weeks`, confirming
  the new id is the live contract. Tests still asserted `'sprints'`.
- **Project tabs reordered (1 assertion).** `b1e4c5a` ("streamline navigation") moved `details`
  below `issues`, so a project opens on its issue list. The test asserted `details` was first.
- **Sprint documents gained tabs (2 assertions).** `9f77237` added a status-aware sprint tab set,
  landing *after* the test file was written. The tests asserted sprints had none.
- **`DetailsExtension` content model (1 assertion) and schema construction (2 errors).** The node's
  `content` is `'detailsSummary detailsContent'`; the test asserted `'block+'` and built an `Editor`
  without the two child nodes, so ProseMirror threw `No node type or group 'detailsSummary' found`.
  `Editor.tsx:628-630` registers all three together — the test now does the same.

*Source defect — 1 (the test was right; the product was fixed):*

- **`web/src/lib/document-tabs.tsx` — the project Weeks tab stopped showing its count.** In one
  hunk, `7713ef0` renamed the id *and* collapsed `label` from a count function to the bare string
  `'Weeks'` — while leaving the identical function intact on the program tab beside it. That
  asymmetry inside a single commit is the fingerprint of an accident, and
  `UnifiedDocumentPage.tsx:133,141` still fetches project weeks and computes `weeks:
  projectWeeks.length` for a consumer that no longer existed. Label function restored; the two
  callbacks are now byte-identical.

*Test-harness defect — 1 (no product code changed):*

- **`web/src/hooks/useSessionTimeout.test.ts` — the stub, not the hook, caused the phantom logout.**
  `lib/api.ts` reads `response.headers.get('content-type')`; the stub had no `headers`, so `apiPost`
  threw a `TypeError`, and `resetTimer` catches every throw as "network error — force logout".
  Observed, not inferred: stderr printed `Network error extending session - forcing logout` — the
  `catch` branch — and never `Failed to extend session`, the `!response.ok` branch. **The assertion
  was correct and is untouched, and the hook's fail-closed logout was deliberately left alone**: a
  session that cannot be extended *should* end. Only the stubs changed — they now hand the code
  under test a real `Response`. Two new tests assert the logout still fires when extend-session
  returns non-ok or rejects, so "fixed the stub" and "neutered the logout" cannot be confused.

**Also changed.** Root `"test"` is now `test:api && test:web`, with `test:api`/`test:web` for
single suites. CI already ran both (`.github/workflows/ci.yml:105-118`) and diffs them against the
quarantine baseline, so this closes the *local* gap only — it does not duplicate CI. All 13
entries were removed from `audit/factory/quarantine.json`; both suites are now green on arrival.
`README.md:43`, which documented this finding as open, is updated.

**Run it.**

```bash
pnpm test:web                    # 345 passed / 345 total, 33 files
pnpm test                        # api (needs DATABASE_URL), then web
scripts/factory/gate.sh          # full evidence gate
```

Those totals are measured on this branch *after* merging `main` a second time (`main` moved from
`84f05ff` to `f7b15c9`, nine more PRs, including route-level code splitting and a deferred editor).
That merge brought in another round of web test files written by other tickets. Sequence of
measurements on this branch: 186 tests before the first `main` merge, 214/214 across 24 files
after it, 345/345 across 33 files after this second one — the 13 identities this ticket fixes did
not change across any of those merges, only the file count around them did.

15 test cases were added to the three repaired files: sprint status-aware tab selection (previously
uncovered — which is how `getTabsForDocumentType('sprint')` drifted from `[]` to four tabs
unnoticed), project/program week count-label symmetry, the zero-count convention asserted across
every count-aware label, a guard that no config exposes a `'sprints'` id again, `setDetails`
document structure, and the two session fail-closed tests. Assertions in the three repaired files
went from 131 to 147.

**Correction post-merge.** The `fix(web): drop test-side casts` commit's message claimed both
test-side casts flagged by CodeRabbit were removed. Only the `useSessionTimeout.test.ts` fetch cast
was; `DetailsExtension.test.ts`'s pre-existing `(editor.commands as any).setDetails` — inside the
same quarantined test this ticket claims to have fixed, `should allow inserting details via
command` — was untouched and still present after merging `main`. Removed now (no cast needed:
`setDetails` is typed via module augmentation, same as the sibling test already relied on).
`node scripts/factory/review-patterns.mjs main` reports clean before and after, because the cast
predates this branch and G7b only diffs added lines — it would not have caught this on its own.

**Roll back.** `git revert` the commits on `fix/test-1-web-suite-green`. Reverting restores the 13
failures, so the `knownFailing` list in `audit/factory/quarantine.json` must come back too —
otherwise the gate reads them as new regressions and fails every branch.

`previousCapture` now carries the 13 identities directly, under `previousCapture.webKnownFailing`.
Copy them back into `packages.web.knownFailing`; no git archaeology required.

Two traps were found while writing this, both worth knowing:

- `previousCapture` originally held only `capturedAt`, `capturedAtCommit` and `totals` — so the
  earlier instruction to "restore from `previousCapture`" pointed at data that was not there.
- The obvious replacement was equally wrong. `capturedAtCommit` (`ae2a00e`) is the commit the
  **measurement** was taken against; `audit/factory/quarantine.json` **did not exist yet** at that
  commit, so `git show ae2a00e:…` fails outright. The file was introduced at `ea2dcd3`, now recorded
  as `previousCapture.fileAtCommit`.

That is why the identities are stored inline rather than referenced: a rollback instruction is read
under pressure, and two successive versions of this one pointed somewhere that could not answer.

---

## TRO-284 (ERR-11) + TRO-285 (ERR-12) — the collaboration server stops dropping frames and serving blank documents during its own document load

**The user-facing cost.** Two ways a collaborative editor could load and simply show nothing, with
no error anywhere. ERR-11: a client's very first sync message could vanish silently, so the editor
sat empty forever with no server reply. ERR-12: a second person opening the same not-yet-open
document at the same moment as a first could get a blank document that never fills in. Observed for
ERR-12, non-deterministically, at `--workers=1 --retries=0`: run 1 clean, run 2 the weekly **plan**
opened blank, run 3 the **retro** opened blank.

**Root cause — one mistake, found three times.** `wss.on('connection')` in
`api/src/collaboration/index.ts` is `async` and `await`s a database round trip before the socket is
fully wired up. Everything registered after that `await` — a message listener, a shared cache entry
— is exposed to whatever arrives in the gap between the moment a connection becomes reachable and
the moment it can actually respond. This is the same defect class as the already-merged ERR-10 (an
`'error'` listener attached after an `await`); ERR-11 and ERR-12 are the `'message'`-listener and
document-cache versions of it, found independently by two different agents on the same day.

- **ERR-11**: `ws.on('message')` was registered only after `await getOrCreateDoc()`. A
  `y-websocket` client sends sync step 1 on the very first tick after `'open'`; a frame landing in
  the gap had no listener, and Node's `EventEmitter` discards an event with no listener **silently**
  — no error, no log, nothing. The server never replies with step 2, so the client never learns the
  server's state. Observed deterministically on loopback before the fix: frames received were
  `[3, 0, 1, 1]` (cache-clear, the server's own step 1, two awareness updates) and no step 2, ever.
- **ERR-12**: `getOrCreateDoc()` (`api/src/collaboration/index.ts`) published a brand-new `Y.Doc`
  into the shared `docs` map **before** awaiting the database read and the JSON→Yjs conversion, and
  attached the broadcasting `doc.on('update')` handler only afterwards. A second connection arriving
  in that gap found the doc already cached — so it triggered no load of its own — received the
  **empty** doc as its server state, and had no listener yet attached to notice when the real
  content landed a moment later.

**What changed.**

- **ERR-11.** `ws.on('message')` is now registered as a **bounded buffering handler** right after
  ERR-10's error-listener registration (still the first statement) and, like it, before the `await`.
  Frames that arrive before the document has
  loaded are queued, not processed — processing them early against a `doc`/`Awareness` that do not
  exist yet would just move the bug. Once the load finishes, the buffering listener is swapped for
  the real one and the queue is drained, in order — all within the same uninterrupted synchronous
  stretch of code that already sent the server's own sync step 1, so replying to a drained client
  step 1 remains race-free, the same invariant `concurrent-merge.test.ts` already relied on for the
  server's outbound step 1. The buffer is bounded at **1 MiB of buffered bytes**
  (`MAX_PRELOAD_BUFFER_BYTES`): this handler sees attacker-controlled bytes before their content can
  be validated (ERR-10's own finding), so an unbounded queue during the load window is a
  memory-exhaustion vector. Exceeding the bound closes the socket with a new code,
  `WS_CLOSE_PRELOAD_BUFFER_FULL` (4429, mnemonic HTTP 429), rather than growing further.
- **ERR-12.** The `docs` map now stores the **load promise**, not the eventual `Y.Doc`
  (`loadDoc()` / `getOrCreateDoc()`). A second caller arriving while the first is still loading
  awaits that same promise and is guaranteed a fully-loaded doc — there is no intermediate step at
  which an unloaded doc is ever handed to anyone, which removes the window rather than narrowing it.
  `doc.on('update')` is attached before the database read / JSON→Yjs conversion, not after, so the
  very first update — the one that carries the loaded content — has a listener. A failed database
  read now **rejects** (previously it was swallowed and the doc silently stayed empty) and
  **evicts** its own map entry, but only if it is still the current entry — a caller that arrived
  after the failure may already have published a fresh attempt of its own, and an unconditional
  delete would tear that down instead. Malformed *stored data* (a corrupt `yjs_state` blob,
  unparsable JSON `content`) is deliberately **not** treated the same way: retrying decodes the exact
  same bytes again, so those two branches keep their own try/catch and fall back to an empty
  document, matching this function's behavior before ERR-12.

**Concurrency argument.** Both fixes close the window instead of narrowing it. ERR-11 no longer
depends on the message listener winning a race against the database read, because every frame that
can arrive before the doc is ready is captured (bounded) and replayed in order — there is no gap
left in which a frame has nowhere to go. ERR-12 no longer depends on one connection's read of the
`docs` map happening to land after another's load completes, because the map holds the one promise
every concurrent caller converges on; "the doc is in the map but not yet loaded" is no longer a
state the map can be in.

**Provenance, marked.** ERR-11's mechanism was reproduced directly (not merely reasoned about): a
regression test connects and writes in the same tick as `'open'`, red on the pre-fix module with the
exact `[3,0,1,1]` frame signature the ticket predicted. ERR-12's two-concurrent-caller mechanism was
also **observed directly** — a test issues two `getOrCreateDoc()` calls back to back and shows the
second one returning an empty doc on the pre-fix logic, an `AssertionError`, not a crash — which is a
step up from "derived from code, not instrumented," the state this finding was in when picked up.
What was **not** independently instrumented is a live two-socket connection count in a running
server outside the test harness; the two-real-socket regression test below is the closest evidence
of that shape and it is described as such, not as proof of a separately-measured connection count.

**How to run it.**

```bash
source .factory-env   # api tests TRUNCATE 16 tables; never run without this
pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/preload-message-buffer.test.ts
pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/concurrent-doc-load.test.ts
pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/concurrent-merge.test.ts
```

`preload-message-buffer.test.ts` (ERR-11): a frame sent in the same tick as `'open'` is processed,
not dropped; flooding past `MAX_PRELOAD_BUFFER_BYTES` closes the socket with
`WS_CLOSE_PRELOAD_BUFFER_FULL` instead of growing the queue. Both cases force a **real** load delay
(no mocked timing) by seeding the target document with a large `content` value, which measurably
slows the one database read `loadDoc()` issues (~70-110ms observed locally for a 20MB value, versus
well under 1ms for a small row) — long enough to reliably land inside the window without touching
production internals.

`concurrent-doc-load.test.ts` (ERR-12): two `getOrCreateDoc()` calls issued back to back resolve to
the same, fully-loaded doc; a load failure (a syntactically invalid UUID — a real Postgres error,
not a mock) rejects and evicts, proved by observing that a second call issues a **fresh** query
rather than reusing a cached rejection; two real clients connecting simultaneously to the same
not-yet-loaded document both receive the seeded content rather than a blank one.

`concurrent-merge.test.ts` (TRO-226/TEST-4, already on `main`) documented the ERR-11 drop as a
workaround: it withheld a client's sync step 1 until after the server's first frame, specifically to
dodge the bug. That workaround is now removed — the acceptance signal for ERR-11 — and the file
still passes: red first (2 of 4 cases timed out waiting for sync step 2, frame signature
`[3,0,1,1]`), green and **faster** after the fix (10.5s vs 44.5s wall time, no timeouts).

No fixed sleeps (TEST-11 / TRO-233): every wait is an observable — a socket `'close'` event, a
database row polled until a predicate holds, or a Yjs `update` event.

**How to roll it back.**

```bash
git revert <commit>
```

No schema change, no migration, no config, no API surface change for a well-behaved client. Reverting
restores both windows: `ws.on('message')` moves back after the `await`, and `docs` goes back to
storing the doc directly instead of its load promise.

---

## TRO-279 — [DB-12] Concurrent `pnpm db:migrate` is broken — 5 of 6 simultaneous schema applies failed

**What was broken.** `CREATE TABLE IF NOT EXISTS` (and `CREATE INDEX IF NOT EXISTS`) is
check-then-create, not atomic. Two `pnpm db:migrate` processes racing against the same database
could both pass the existence check and both attempt the create; one loses on the catalog's unique
index. `Dockerfile:35` runs migrations on every container boot, so a rolling deploy, a scale-out, or
a crash-restart overlapping a fresh boot runs this concurrently against one database — this is not a
theoretical race, it is the normal shape of this deployment.

**Why it was worse than a failed deploy.** `applySchema` runs `schema.sql` as one simple query, so
Postgres executes it as a single implicit transaction: a duplicate-object error at statement *k*
rolls back statements 1..*k*-1 too. PR #8 (TRO-178) put `42710` in the tolerated-error set and added
a retry, which recovers *that* case — but the raw race mostly raises **23505** (`unique_violation` on
`pg_type_typname_nsp_index`), which is deliberately *not* tolerated (23505 is the generic
unique-violation code; tolerating it would also swallow a genuine data conflict). Left unfixed, a
losing run under a still-tolerant retry policy could apply nothing and still exit 0 — DB-1's exact
failure mode, reachable only through this race.

**What changed.** `api/src/db/migrationRunner.ts` — `runMigrations` now takes one Postgres
**session-level advisory lock** (`pg_advisory_lock` / `pg_advisory_unlock` on a fixed key,
`MIGRATION_ADVISORY_LOCK_KEY = 0x53686970`, spelling "Ship" in hex) around the entire run: `applySchema`,
`ensureMigrationsTable`, and the migration loop in `runPendingMigrations`. The lock is acquired
**before** anything else touches the database — in particular before `runPendingMigrations`' first
query, the `schema_migrations` read — because locking after that read would preserve the exact race
this closes.

- A single `PoolClient`, checked out once for the whole run, now flows through
  `applySchema`/`ensureMigrationsTable`/`runPendingMigrations` instead of each call going through
  `pool.query(...)` independently. `runPendingMigrations` no longer opens its own connection per
  migration file; each migration's transaction now runs sequentially on the one client that holds
  the lock. This means the fix does not depend on the pool having a second connection free while the
  lock-holder is checked out — it works even against a pool sized for exactly one connection.
- The lock is released in a `finally` on every exit path, success or failure. The unlock call is
  wrapped in its own inner `try/catch` so that if unlocking itself fails, it cannot mask a real error
  already propagating from the migration work. If the explicit unlock did not run or failed, the
  connection is force-destroyed (`client.release(true)`) instead of returned to the pool — ending the
  session is the backstop that still releases the lock even when the explicit unlock command could
  not be sent.
- **Concurrency argument.** A second `pnpm db:migrate` process blocks at `pg_advisory_lock` until the
  first releases (or its session ends), so the two runs' critical sections cannot overlap in time —
  this closes the window rather than narrowing it. A runner that dies while holding the lock does not
  wedge every future run: session-level advisory locks are released when their session ends, cleanly
  or otherwise (documented Postgres behaviour), and this is verified directly — not just assumed —
  by a test that opens a lock, ends that connection without unlocking, and confirms a second
  connection can then acquire it immediately.
- **`applySchema`'s duplicate-object retry (from PR #8) is left in place, not removed.** With the
  lock held, only one session is ever inside `applySchema` at a time, so the concurrent case it was
  added for should no longer reach it — but it is still the correct response to a genuine
  non-concurrent duplicate-object error (a stray manual `psql` session, a future caller that bypasses
  the lock), and removing a defensive path that is merely believed-unreachable is out of scope here.
- **The tolerated-error set is unchanged — 23505 is still not in it.** Widening it would swallow a
  real data conflict the day `schema.sql` stops having zero DML; the lock removes the need to
  tolerate the concurrent case at all, which is the point of fixing this at the actual race instead
  of widening what errors are forgiven.
- Regression tests: `api/src/db/__tests__/migrationLock.test.ts` (new). `MIGRATION_ADVISORY_LOCK_KEY`
  is now exported from `migrationRunner.ts` so tests can assert the lock is actually free via
  `pg_try_advisory_lock`, rather than only inferring release from a second run's success.

**How to run it.**

```bash
source .factory-env                      # or otherwise point DATABASE_URL at the target
pnpm db:migrate
pnpm --filter @ship/api test src/db/__tests__/migrationLock.test.ts
pnpm --filter @ship/api test src/db/__tests__/migrationRunner.test.ts   # DB-1 regressions, unaffected
```

**Verified**, all against PostgreSQL 15 in the `ship-audit-pg`-style container on `:5433`, using the
real `tsx src/db/migrate.ts` entry point (what `pnpm db:migrate` invokes) unless noted:

- **Before the fix** (pre-fix `migrationRunner.ts` restored from `main`, six `tsx src/db/migrate.ts`
  processes launched concurrently against one fresh throwaway database): 1 of 6 exited 0, 5 of 6
  exited 1, all five with SQLSTATE `23505` on `pg_type_typname_nsp_index` — reproducing the ticket's
  numbers with this branch's own harness before trusting it.
- **After the fix**, same harness, a fresh throwaway database: all six processes exited 0,
  `schema_migrations` held exactly 42 distinct rows, no duplicate-object or unique-violation output
  in any of the six logs.
- A single, non-concurrent `tsx src/db/migrate.ts` against a fresh throwaway database: exit 0, 42/42
  migrations recorded.
- A genuine failure (a deliberately broken migration file added temporarily, removed immediately
  after) via the real CLI: exit 1, naming the failure — DB-1's exit-non-zero guarantee still holds
  and is unaffected by this change (`migrate.ts` itself was not modified).
- `api/src/db/__tests__/migrationLock.test.ts`, run against the **pre-fix** runner first: the
  six-concurrent-runs test failed with five real `23505` `unique_violation` errors (red for the
  right reason); the two lock-semantics tests failed too, but because `MIGRATION_ADVISORY_LOCK_KEY`
  does not exist on the pre-fix module — expected, since those tests exercise a lock that does not
  exist yet. Restoring the fix turned all three green.
- `pnpm --filter @ship/api test` (full suite, factory database `ship_wt_tro_279`): 43 files, 595
  tests, all green.
- `pnpm --filter @ship/api exec tsc --noEmit`: clean.

**Not verified.** No run against PostgreSQL 16 (production; CI and this work run pg15 — see the pin
in `.github/workflows/ci.yml`), and no run against production or shadow. The advisory-lock mechanism
itself is standard Postgres behaviour independent of major version, but this was not measured against
16 directly.

**Rollback.** `git revert` the commit(s) on `fix/db-12-migrate-advisory-lock`, or restore
`api/src/db/migrationRunner.ts` from `main` and delete `api/src/db/__tests__/migrationLock.test.ts`.
Rolling back returns `pnpm db:migrate` to PR #8's retry-only mitigation — `42710` recovers, `23505`
does not, and the race described above is live again. No database state is affected by rolling back;
the lock itself leaves no persistent artifact (advisory locks are session-scoped, never written to
disk).

---

## TRO-240 — [DB-11] The application's database pool negotiated no TLS while migrate and seed did

**What was broken.** Three pools connect to Ship's database with three different SSL policies.
`api/src/db/migrate.ts:32` and `api/src/db/seed.ts:44` each carried their own copy of
`ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false`.
`api/src/db/client.ts:17-26` — the pool the entire running application uses — had **no `ssl` key at
all**. A fourth pool, `api/src/db/scripts/orphan-diagnostic.ts:34`, had none either.

An absent `ssl` key is not "let pg decide sensibly". `pg`'s `ConnectionParameters` does
`this.ssl = typeof config.ssl === 'undefined' ? readSSLConfigFromEnvironment() : config.ssl`, and
with `PGSSLMODE` unset that resolves to `defaults.ssl`, which is `false`
(`pg/lib/connection-parameters.js:100`, `pg/lib/defaults.js:43`). So the app pool connected in
**plaintext**, unconditionally, in production.

**Why it never surfaced on AWS.** Aurora is in-VPC and the connection is internal, so plaintext
works. The gap only appears against a managed Postgres that requires TLS on a public endpoint —
i.e. every PaaS, including the Render deployment.

**Why the failure signature misdirects.** `Dockerfile:35` is
`node dist/db/migrate.js && node dist/index.js`. `migrate.ts` *did* configure SSL, so it connected,
ran, exited 0, and the `&&` proceeded — then `index.js` started and `client.ts` failed to connect.
The logs read "migration succeeded, database unreachable", which looks like a database problem
rather than a client-config one. `connectionTimeoutMillis: 2000` turned it into a fast crash-loop
instead of a legible TLS error.

**What changed.** The drift was the defect, so the fix is one decision in one place rather than a
fourth copy of the ternary. New `api/src/db/ssl.ts` exports `resolveDatabaseSsl(nodeEnv?)`, and all
four pools under `api/src/db/` now call it:

- `api/src/db/client.ts:23` — **the actual bug**; previously passed nothing.
- `api/src/db/migrate.ts:33`, `api/src/db/seed.ts:45` — inline ternary replaced by the helper.
- `api/src/db/scripts/orphan-diagnostic.ts:37` — previously passed nothing; same defect class.

The returned value is unchanged from what the scripts already did: `{ rejectUnauthorized: false }`
in production, `false` otherwise. A fresh object per call, so no two pools share a mutable TLS
config. `nodeEnv` is a parameter defaulting to `process.env.NODE_ENV` purely so the decision is
testable without env stubbing; production code calls it with no arguments.

**Behaviour outside production is byte-for-byte identical.** Local dev, CI and the factory
databases previously got `false` by pg's default and now get `false` by explicit decision.

**`rejectUnauthorized: false` was carried over deliberately, not endorsed.** It encrypts the
connection but does not verify the server certificate chain — it stops passive eavesdropping, not an
active man-in-the-middle. Managed providers sign with their own CA, absent from Node's trust store,
so verification fails without the provider bundle. A federal deployment probably wants
`rejectUnauthorized: true` plus an explicit `ca`. Tightening it here would be a silent posture
change that no test in this repo can verify, so it is left as a follow-up that needs the CA bundle
decided first. This is called out in the header comment of `api/src/db/ssl.ts`.

**Precedence — the helper is not the only input, and not the strongest.** There is a third SSL
surface besides these pools and the helper: the connection string. Raised by CodeRabbit, then
established by reading pg rather than inferring it from the finding above, and confirmed empirically
against pg 8.16.3 / pg-connection-string 2.9.1.

`pg/lib/connection-parameters.js:56` does
`config = Object.assign({}, config, parse(config.connectionString))` — the parsed URL is the **last**
source, so its `ssl` key overwrites the caller's; the comment on `:54` says so outright.
`pg-connection-string/index.js:76` sets `ssl = {}` whenever `sslmode` is present, and `:133-135` sets
`ssl = false` for `disable`. `connection-parameters.js:81` then uses that value as-is.

Effective order, weakest to strongest: **pg defaults → `PGSSLMODE` → the `ssl` option this helper
returns → `sslmode` in the connection string.**

Measured, passing an explicit `{ rejectUnauthorized: false }` throughout:

| `sslmode` in URL | effective `ssl` | on the wire |
|---|---|---|
| absent | `{ rejectUnauthorized: false }` | encrypted — our option survives |
| `disable` | `false` | **plaintext — our option is discarded** |
| `prefer` / `require` / `verify-ca` / `verify-full` | `{}` | encrypted |
| `no-verify` | `{ rejectUnauthorized: false }` | encrypted |

So `DATABASE_URL=...?sslmode=disable` silently defeated the fix, in exactly the way these strings
arrive — copied from a provider dashboard. The helper would report the right value, every test would
pass, and production would be in the clear.

The `ssl` option can never win that argument, so `resolveDatabaseSsl` **refuses to start** instead:
in production, an `sslmode` that pg resolves to plaintext throws with the parameter named and the
remedy stated. `disable` is the only such value — the other five all encrypt, and are allowed
through untouched. Outside production `sslmode=disable` is still fine, because local Postgres and
the CI container are plaintext-only.

It deliberately does **not** rewrite the URL. Silently editing an operator's explicit instruction is
the same class of mistake as the original bug: the code would report one thing and do another.

Note in passing: `sslmode=require` resolves to `{}`, which leaves Node's `rejectUnauthorized` at
`true` — stricter than this helper, and it will **fail** against a provider using a private CA. That
is a loud connection error rather than a silent downgrade, so it is left alone.

**Deployment precondition — check this before rolling out.** If the production `DATABASE_URL` in SSM
already contains `sslmode=disable`, this turns a currently-working in-VPC deploy into a startup
failure with the message above. The value lives in SSM and could not be inspected from here, so this
is stated as a risk, not a cleared check. If plaintext is genuinely intended for that deployment,
that is a decision for a human to make explicitly.

**Out of scope, deliberately.** `api/scripts/migrate-shadow.ts:32`, `api/scripts/create-test-user.ts:35`
and `api/scripts/check-db-user.ts:10,19` set `ssl: { rejectUnauthorized: false }`
**unconditionally** — a fifth and sixth policy. They are operator scripts outside
`api/tsconfig.json`'s `include: ["src/**/*"]`, always pointed at a remote AWS endpoint. Routing them
through a `NODE_ENV`-conditional helper would silently **downgrade** them to plaintext whenever
`NODE_ENV` is unset, which is how they are normally invoked. Changing them needs its own ticket and
its own verification.

**Evidence.** `pnpm --filter @ship/api test` against
`postgresql://ship:***@localhost:5433/ship_wt_tro_240` (docker `ship-audit-pg`, postgres:15-alpine),
`NODE_ENV` unset in the shell so vitest sets `test`. 31 files, **491 passed, 0 failed**.
`pnpm --filter @ship/web test`: 13 failed / 186 passed — the same 13 identities quarantined as
TEST-1 / TRO-223, in the same three files; nothing in `web/` was touched. `pnpm type-check` clean
across shared, api and web.

The regression test is `api/src/db/__tests__/ssl.test.ts` (22 cases), covering four things:

1. the decision per `NODE_ENV`, including that `production` is matched exactly, so a deploy setting
   `NODE_ENV=Production` cannot silently drop to plaintext;
2. that `client.ts`'s pool actually applies it — re-imported under a stubbed env, since the pool is
   built at module scope. **7 failed / 8 passed** against the unfixed call sites, every failure an
   `AssertionError` on the claimed behaviour, the headline being
   `expected undefined to deeply equal { rejectUnauthorized: false }` — DB-11 stated as a test;
3. the precedence above: two tests **characterise pg itself**, pinning that `sslmode=disable`
   discards the explicit option and that the other five values do not. If a future pg makes the
   option win, those tests fail, which is the signal the throw can be relaxed. Then the guard:
   **2 failed / 6 passed** against the unguarded helper, both `expected [Function] to throw an
   error`. Only two of the eight went red on purpose — the other six assert behaviour that must
   *not* change (dev still permits `sslmode=disable`, encrypting modes still pass, a malformed URL
   is still pg's to report);
4. that **no** pool under `api/src/db/` sets `ssl` to anything other than `resolveDatabaseSsl()`.
   This is what prevents recurrence — a future file adding `new Pool(...)` with its own policy fails
   the suite rather than quietly adding a fifth policy.

Beyond the suite, the **compiled** artifact was exercised directly, since `Dockerfile:35` runs
`dist/`, not the TypeScript: `NODE_ENV=production` with a clean URL yields
`{"rejectUnauthorized":false}`; with `?sslmode=disable` importing `dist/db/client.js` throws the
guard message; `NODE_ENV=development` with `?sslmode=disable` still yields `false`.

**How to run it.**

```bash
source .factory-env                                             # api tests TRUNCATE 16 tables
pnpm --filter @ship/api test src/db/__tests__/ssl.test.ts       # 22 cases, the regression test
pnpm --filter @ship/api test                                    # full api suite: 491/491
pnpm type-check

# the guard, on the compiled artifact (throws; prints the remedy)
pnpm --filter @ship/api build
cd api && NODE_ENV=production DATABASE_URL='postgresql://u:p@h:5432/d?sslmode=disable' \
  node -e "import('./dist/db/client.js').catch(e => console.log(e.message))"
```

**Rollback.** `git revert` the commits on `fix/db-11-pool-ssl`, or by hand: delete
`api/src/db/ssl.ts` and `api/src/db/__tests__/ssl.test.ts`, drop the `ssl:` line and the import from
`client.ts` and `scripts/orphan-diagnostic.ts`, and restore the inline ternary in `migrate.ts` and
`seed.ts`. Reverting reinstates plaintext connections from the application pool. To keep the fix but
drop only the startup guard, delete the `PLAINTEXT_SSL_MODES` check in `resolveDatabaseSsl` — that
restores the state where `sslmode=disable` in `DATABASE_URL` silently wins.

**Not verified — do not read this as a fixed deployment.** No test here proves TLS actually
negotiates. Proving that needs a managed Postgres endpoint that *requires* TLS on a public address;
there is none in this repo's test environment, and the local docker Postgres speaks plaintext only,
so a passing local suite is silent on the real failure mode. What is verified is the decision logic
and its propagation to all four call sites — everything up to the socket. The claim "Render now
starts" remains **untested**; confirming it means deploying and reading the startup logs.

---

## TRO-226 — [TEST-4] Concurrent multi-client editing / Yjs merge had no executing test

**What was missing.** The CRDT is the entire justification for the Yjs architecture
(`docs/unified-document-model.md`), and nothing verified it. A regression that silently dropped one
collaborator's edits would have shipped green. Two tests looked like they covered this and did not:

- `api/src/collaboration/__tests__/collaboration.test.ts:144` "should merge concurrent Yjs updates
  correctly" exchanges updates between two bare `Y.Doc`s with `Y.applyUpdate`. That is a test of the
  yjs library. No server, no socket, no persistence — a bug in
  `api/src/collaboration/index.ts` cannot fail it.
- `e2e/mentions.spec.ts:374` is the only two-client test. It uses `browser.newPage()` (one browser,
  sequential), every assertion sits inside `if (await option.isVisible())`, and it synchronizes with
  `waitForTimeout(2000)`/`waitForTimeout(3000)`. It is also in `e2e/`, which neither `gate.sh` nor
  `.github/workflows/ci.yml` executes.

**What changed.** One new file, `api/src/collaboration/__tests__/concurrent-merge.test.ts`, in the
vitest project the gate actually runs. Four tests drive two independent Yjs clients — separate
`Y.Doc`s, separate WebSockets, separate sessions — against the real `setupCollaboration()` over real
sockets, speaking the real `y-protocols` sync protocol in **both** directions, and assert on the
`documents` row.

- **control** — one client's edit reaches `content` and `yjs_state`. Without this, a broken harness
  and a broken merge look identical.
- **different regions** — both clients append a paragraph in one synchronous block, so neither
  update is in the other's causal history. Concurrency is *asserted*, not assumed: each replica must
  not yet contain the other's marker at edit time. Then both replicas must converge to a
  byte-identical document containing both edits, and both edits must be in `yjs_state`.
- **same region** — the crux. A seeded paragraph is the contested text; both clients insert at the
  same character offset in the same `Y.XmlText`. Asserts both inserts survive, the replicas converge
  on one identical string, and the pre-existing text is intact. The interleaving *order* is
  deliberately not asserted — Yjs breaks the tie by client id, which is not stable across runs.
- **offline divergence** — one client's socket is closed, it edits anyway, the other edits online,
  then it reconnects. Asserts the offline edit is merged in rather than discarded, the online edit is
  not clobbered, and the result persists. This is the expensive regression: a user's work silently
  lost on reconnect.

Persistence is checked by decoding `documents.yjs_state` into a fresh `Y.Doc` in the test process,
not by trusting the `content` JSON mirror. `api/src/collaboration/index.ts` is **not modified** —
this is coverage only, and three branches are in flight against that file.

**Plus an additive browser spec, clearly labelled as not run by CI.**
`e2e/concurrent-editing.spec.ts` does the same two scenarios through two real
`browser.newContext()`s — separate cookie jars, separate sessions, separate IndexedDB — logged in as
two different users, typing concurrently via `Promise.all` on two keystroke streams. It covers the
one layer the vitest test cannot reach: TipTap and the real `y-websocket` client rather than a
hand-rolled protocol client. It is **additive, not the proof** — `.github/workflows/ci.yml` has no
Playwright job and `gate.sh` executes only the two vitest projects, so a test living only in `e2e/`
satisfies the gate's added-test check while never running. That is the TEST-2 failure mode, and the
file's header says so.

**No fixed sleeps.** Convergence is awaited on Yjs `update` events. Persistence — which emits no
event — is awaited by re-reading the row until a predicate holds, with a 50ms gap between reads and
a hard deadline. Every wait is a condition, never a duration guessed to be long enough (TEST-11 /
TRO-233).

**How to run it.**

```bash
cd <worktree> && source .factory-env      # api tests TRUNCATE 16 tables
pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/concurrent-merge.test.ts

# the additive browser spec — deliberate, never as part of the full suite
pnpm build && npx playwright test e2e/concurrent-editing.spec.ts --workers=1 --retries=0
```

**Evidence — the test was proved capable of failing.** New coverage has no bug to go red on, so the
server was temporarily sabotaged twice (both reverted; `git diff main -- api/src/collaboration/index.ts`
is empty on this branch).

1. *Merge sabotage* — `handleMessage` was made to silently discard `messageYjsUpdate` frames from any
   client that is not the first connection in the room. Both concurrent tests failed; the control and
   offline tests still passed, so the harness was provably fine. Failure text:
   `clientA never received clientB's concurrent edit (BOB_…) — local replica:
   <paragraph></paragraph><paragraph>ALICE_…</paragraph> frames received: [3,0,1,0,1]`.
2. *Persistence sabotage* — the `UPDATE documents SET yjs_state = …, content = …` in
   `persistDocument()` was reduced to writing only `properties`. In-memory merge still worked; all
   four tests failed on the database assertion:
   `merged content never reached documents.content: database predicate never held within 30000ms
   (576 reads)`.

Both are `AssertionError`/explicit-condition failures naming the missing edit, not import or setup
errors.

The **e2e spec was proved capable of failing too**, under the same merge sabotage (rebuilt through
`pnpm --filter @ship/api build`, since the e2e harness runs `api/dist/index.js`). Both browser tests
failed with `Error: clientA lost clientB's concurrent edit / Expected substring: "BBB-…" / Received
string: "AAA-…"`, then passed again after the source was restored and rebuilt.

**Stability.** 5 consecutive standalone runs of the vitest file, 4/4 passing each time, ~10.4s per
run. Full api suite green: 473 passed / 31 files (up from 469 / 30). The e2e spec: 2/2 passing,
verified with `--retries=0` so a retry cannot mask a flake, ~33-51s for the pair on one worker.

**Coverage delta on `api/src/collaboration/index.ts`.** v8 provider, full api suite
(`vitest run --coverage`), factory database `ship_wt_tro_226` on the `ship-audit-pg` container at
`:5433`, macOS, measured twice under identical conditions with the new file present and absent:

| | statements | branches | functions | lines |
|---|---|---|---|---|
| without this test | 60.68% | 40.57% | 67.24% | 62.07% |
| with this test | **62.50%** | **45.41%** | **70.68%** | **63.04%** |

The ticket's "25.0% function coverage (7 of 28)" figure is **not reproducible today** and is not the
baseline above: `session-revocation.test.ts` (ERR-2 / TRO-189) landed on the same file earlier the
same day and had already lifted functions to 67.24%. The v8 provider also counts closures, so its
denominator is not 28. `@vitest/coverage-v8` is not a dependency of this repo; it was installed to
take the measurement and `api/package.json`/`pnpm-lock.yaml` were reverted afterwards, so
`--coverage` will not run without installing it again.

**Second new finding, not fixed here, and it probably affects other e2e specs.**
`web/src/components/ActionItemsModal.tsx` is a Radix `Dialog`, and the seeded workspace has 32
overdue accountability items, so it opens on load over the document editor. While it is open it both
covers the editor — `locator.click()` never passes hit-testing and dies as a bare 60s timeout with no
assertion — and traps focus, so `document.activeElement` can never become the editor. Observed
directly: three failed e2e runs before the dialog was identified. Any e2e test that drives the editor
after a direct `page.goto('/documents/:id')` has to dismiss it first; the new spec does. Derived, not
verified: this is a plausible contributor to the existing editor-spec flakiness in TEST-11 / TRO-233.

**New finding, not fixed here.** Building the test surfaced a real race in the server.
`wss.on('connection')` in `api/src/collaboration/index.ts` `await`s `getOrCreateDoc()` — a database
round trip — and registers `ws.on('message')` only afterwards. A client frame that arrives inside
that window has no listener and is dropped by the EventEmitter. A y-websocket client sends sync step
1 immediately on `open`, so on a low-latency link its step 1 is lost, the server never replies with
step 2, and **the client never receives the server's document state** — the editor stays empty while
the client's own state is pushed up. Observed deterministically on loopback (frames received were
`[3,0,1,1]`: cache-clear, the server's own step 1, two awareness updates, and no step 2). Derived,
not measured, for production: over a real network the client's step 1 normally arrives after the DB
read completes, so this reads as a dev/loopback defect — but the window is real and widens with
database latency. The test client works around it by sending its step 1 only after the server's first
frame, which is race-free because the server sends that frame in the same synchronous block that
attaches the listener.

**Roll back.** `git rm api/src/collaboration/__tests__/concurrent-merge.test.ts
e2e/concurrent-editing.spec.ts` and drop this entry. Nothing else on this branch touches product
code.

---

## TRO-277 — [TEST-12] Load-sensitive api flake: leaking mock queues and an unguarded shared test database

**What was broken.** The api suite failed an otherwise-good branch four times in one day, on a
different test each time, and passed on standalone re-run. `audit/factory/quarantine.json` records
api as `knownFailing: 0`, so each occurrence burned a gate attempt against the 3-retry cap. One
occurrence was on a branch touching only `web/` and `vite.config.ts`, which cannot break an api
DELETE test — so the cause was never in the ticket's diff. Two independent defects were found.

**Defect 1 — `vi.clearAllMocks()` does not drain queued once-values.** Confirmed on vitest 4.0.17:
`clearAllMocks` wipes call records but leaves unconsumed `mockResolvedValueOnce` responses queued.
A test that queues more responses than its handler consumes therefore leaves one behind, and the
next test receives that stale response first — shifting every subsequent mock in that test by one
and surfacing as a failure in an unrelated place. Five api test files combined the two.

**Defect 2 — nothing stopped two api suites from sharing one database.**
`api/src/test/setup.ts` `TRUNCATE`s 16 tables in the `beforeAll` of *every* api test file, and each
file then builds fixtures it depends on for the rest of the file. `fileParallelism: false` makes
that safe within one process and does nothing across processes. Two suites on one `DATABASE_URL`
delete each other's fixtures mid-file. Reproduced deliberately by running two suites against one
database: **18 and 20 failures**, dominated by `expected 401 to be 200` (the session row was
truncated away) and `violates foreign key constraint "documents_workspace_id_fkey"` in nested
`beforeAll` hooks — the exact shapes of all four recorded flakes.

**This also explains the phantom skips.** Two full runs had previously reported
`450 passed | 6 skipped (456)` with no `.skip`/`.todo`/`.fixme` marker anywhere in
`api/src/**/*.test.ts`. When a `beforeAll` hook fails, vitest reports that describe's tests as
**skipped, not failed** — an intermittently-absent assertion that reads as a pass. The two-suite
run reproduced it at scale: **11 and 33 skipped**, same zero markers.

**What changed.**

- `api/src/test/setup.ts` — takes a session-level Postgres advisory lock, held for the duration of
  each test file, before truncating. Concurrent suites now serialize at file granularity instead of
  corrupting each other; on timeout it fails with a message naming the cause rather than producing a
  mystery 401. Advisory lock spaces are per-database, so worktrees with their own database never
  contend, and the lock is released on disconnect so a crashed run cannot wedge the next one. The
  hook timeout is raised above the lock deadline deliberately: a hook that vitest abandons keeps
  running and would truncate outside vitest's control — that hole caused a residual failure in
  testing before it was closed.
- `api/src/routes/issues-history.test.ts`, `api/src/routes/iterations.test.ts`,
  `api/src/__tests__/activity.test.ts`, `api/src/__tests__/auth.test.ts`,
  `api/src/__tests__/transformIssueLinks.test.ts` — `resetAllMocks` in place of the clear-only
  variant. Mock factories in the first two were rewritten from `vi.fn().mockResolvedValue(x)` to
  `vi.fn(impl)`, because `resetAllMocks` restores an implementation passed to `vi.fn()` but wipes one
  chained on afterwards; a naive conversion would have turned those mocks into undefined-returning
  stubs. `issues-history.test.ts` also drops three now-redundant re-establishment lines, one of
  which was an `as any` cast.
- `api/src/__tests__/mock-isolation.test.ts` — new. Pins the four vitest semantics the fix rests on,
  and scans every api test file to fail the suite if the clear-plus-once-queue combination returns.

**Defect 3 — deadlines sized for an idle machine.** With the two mechanisms above fixed, 20 api runs
under concurrent build load still failed 6 times, and half of those failed on nothing but
`Test timed out in 5000ms` — on tests that take 10-70ms unloaded. A deadline 80x a test's normal
duration says nothing about correctness on an oversubscribed machine, and it cost a gate attempt each
time. Separately, `rate-limit.test.ts`'s 320-request burst was the single most frequent failure in
the suite, because `request(app)` binds a throwaway server per call and the burst created 320 of
them; it failed as `socket hang up` and as a 5s timeout.

- `api/vitest.config.ts` — `testTimeout` 5s → 15s, `hookTimeout` 10s → 30s. No assertion is raised or
  removed and nothing is skipped. The hook deadline is the more consequential one, because a hook
  that merely misses its deadline reports its describe's tests as *skipped* — silently dropping
  assertions instead of flagging anything.
- `api/src/middleware/__tests__/rate-limit.test.ts` — the burst binds one server for all 320
  requests, measuring the limiter instead of the ephemeral-port supply. The assertion is byte-for-byte
  unchanged: still 320 requests on one session key, still zero tolerated 429s.

**Evidence.** Red-before-green for the guard test: with two pre-fix files restored it fails with an
`AssertionError` naming `__tests__/activity.test.ts` and `routes/issues-history.test.ts`. Everything
else here is proven by repetition, since converting a mock-reset call has no meaningful unit test.

| Condition | Before | After |
|---|---|---|
| Two api suites, one database | 18 and 20 failures; 11 and 33 phantom skips | 1 failure in 950 tests; **0 skips** |
| 20 api runs under concurrent build load (load avg ~29 on 14 cores) | 6 runs failed | **1 run failed** |
| Phantom skips across those 20 runs | — | **0, in all 20** |
| `rate-limit.test.ts` alone, 25 runs under the same load | failed 3 times in 20 full runs | 25/25 |

**What is still broken, and is not fixed here.** Two residual failures remain, each seen once, and
neither is the mechanism above:

- `sprint-reviews.test.ts > POST /api/weeks/:id/review > returns 403 without auth (CSRF check first)`
  exceeded even the 15s deadline once in 20 runs — a hung request, not a slow one, so a larger
  deadline is not the answer.
- `workspaces.test.ts > POST /api/admin/workspaces > should return 403 for non-super-admin` returned
  **200** once in the two-suite run. An authorization assertion failing open deserves its own
  investigation on its own merits, separately from any flake question.

Both need their own ticket. Neither was reproduced twice, so no mechanism is claimed for either.

**How to run it.**

```bash
source .factory-env    # api tests TRUNCATE 16 tables; never run them without this

# The guard, and the four vitest semantics the fix rests on.
pnpm --filter @ship/api test --run src/__tests__/mock-isolation.test.ts

# Defect 2, directly: two suites against one database. Both must now pass.
# Before the lock they reported 18 and 20 failures, and 11 and 33 phantom skips.
pnpm --filter @ship/api test --run & (sleep 4; pnpm --filter @ship/api test --run); wait

# The repetition the flake actually needed: build load in parallel with the suite.
for i in 1 2 3 4; do (while :; do pnpm --filter @ship/api type-check; done >/dev/null 2>&1) & done
for n in $(seq 1 20); do pnpm --filter @ship/api test --run >/dev/null 2>&1 || echo "run $n FAILED"; done
kill %1 %2 %3 %4
```

**Rollback.** `git revert` the commits. The lock is confined to the test setup file and the
converted files are self-contained; nothing in `api/src` production code changed.

---

## TRO-181 (DB-4) + TRO-176 (API-5) — dashboard standups collapsed from one request per active week to one

Both findings are the same client-side fan-out seen from two sides — DB-4 from the SQL layer, API-5
from the HTTP layer — and share one fix.

**What was broken.** `web/src/pages/Dashboard.tsx:69-85` mapped the 5 active weeks returned by
`GET /api/weeks` to one `fetch('/api/weeks/${sprint.id}/standups')` each inside a `Promise.all` — 5
of the dashboard's 12 requests, each returning exactly 2 bytes (`[]`), and 25 of the flow's 42
steady-state queries (5x sprint access check, 5x standups `SELECT`, 5x the auth trio). The audit's
hypothesis held on direct inspection: the handler originally at `api/src/routes/weeks.ts:1833`
(now `:1927`, shifted down by the new route added above it) already batches issue-link lookups via
`batchLookupIssues` — the N+1 was entirely client-side, not a server defect. The per-week query also had no `LIMIT` and
shipped every standup's full `content`, though `Dashboard.tsx:92` immediately discarded everything
but the 10 most recent across all weeks.

**What changed.**

- `api/src/routes/weeks.ts` — new `GET /api/weeks/standups?week_ids=uuid,uuid,...`, registered
  *before* `GET /api/weeks/:id` so Express doesn't swallow `standups` as an `:id`. `week_ids` is
  validated with zod (`.split(',')` piped through `z.array(z.string().uuid()).min(1).max(50)`),
  rejecting anything malformed with **400** before it reaches SQL — the ids are only ever bound via
  parameterized `= ANY($1)`, never interpolated. One query narrows the requested ids to sprints that
  exist and are visible to the caller; one query fetches standups for all of them via
  `parent_id = ANY($1)`, `ORDER BY created_at DESC LIMIT 10` — server-side, so the endpoint stops
  shipping rows the client only ever discarded. Issue-link transformation reuses the existing
  `batchLookupIssues`/`transformIssueLinks` helpers, now batched once across every sprint's standups
  instead of once per sprint.
- `api/src/openapi/schemas/weeks.ts` — registered `GET /weeks/standups` (schema + zod, tags,
  summary/description) so Swagger and the generated MCP tool both pick it up.
- `web/src/hooks/useWeeksQuery.ts` — new `useRecentStandupsQuery(weekIds)`, one `react-query` call
  to the batched endpoint instead of the page doing its own fan-out.
- `web/src/pages/Dashboard.tsx` — replaced the `useState`/`useEffect`/`Promise.all` fan-out with
  `useRecentStandupsQuery`; `sprint_title`/`program_name` are now attached client-side from the
  already-fetched `activeWeeks` list (unchanged UI, unchanged `Standup` shape).
- The old `GET /api/weeks/:id/standups` route is untouched — nothing else that calls it (if
  anything does) is affected.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database
pnpm --filter @ship/api exec vitest run src/routes/weeks.test.ts -t "batched"
pnpm --filter @ship/web exec vitest run src/pages/Dashboard.standupsFanout.test.tsx src/pages/Dashboard.test.tsx
scripts/factory/gate.sh
```

The api tests assert the batched response shape, that a non-UUID or missing `week_ids` 400s, that
an unauthenticated call 401s, and that hitting the endpoint with 1 vs. 5 week ids costs the same
number of `pool.query` calls (spied directly — no query-count scaling with the number of weeks
requested). The web test does not mock `useWeeksQuery`; it lets the real hooks run against a mocked
`global.fetch` and asserts exactly one request matches `/api/weeks/standups`, and fails the test if
any request matches the old per-week shape.

**Measured, same seeded database (`ship_wt_tro_181`, postgres:15-alpine in the `ship-audit-pg`
Docker container on `:5433`), 5 active weeks x 1 standup each, one session, sequential requests, no
concurrent load from the measurement itself.** Because the old per-week route was left in place,
both sides were measured against the same running server rather than estimated: 5 sequential
`GET /api/weeks/:id/standups` calls (the old client behaviour) cost **5 requests / 30 queries**; one
`GET /api/weeks/standups` call for the same 5 ids costs **1 request / 6 queries** — an 80% cut in
both, for the standups portion of the flow specifically. The audit's own baseline (12 total dashboard
requests, 5 of them this fan-out; 42 total flow queries, 25 of them this fan-out) was not
re-measured end-to-end here — combining it with this delta (12 − 5 + 1 = 8 requests) reproduces the
audit's projected 8, which is a consistency check on the audit's number, not an independent
re-verification of the other 7 requests.

**Rollback.** Revert the commits on `fix/db-4-api-5-dashboard-fanout`. To roll back just the client
(keeping the server endpoint): revert the `Dashboard.tsx`/`useWeeksQuery.ts` changes only — the old
`GET /api/weeks/:id/standups` route still exists and still works. To remove the endpoint entirely:
delete the `router.get('/standups', ...)` block in `api/src/routes/weeks.ts` and its
`registry.registerPath` counterpart in `api/src/openapi/schemas/weeks.ts` — nothing else depends on
either.

---

## TRO-192 (ERR-5) + TRO-195 (ERR-8) — malformed path/query params returned 500 instead of 400/404

Both findings are one root cause: request **bodies** are validated up front with zod and return a
clean 400 (`createDocumentSchema.safeParse(req.body)` in `routes/documents.ts`), but path and query
params bypassed that layer entirely. `GET /api/documents/not-a-uuid` reached Postgres, failed an
`invalid input syntax for type uuid` cast, and surfaced as an uncaught 500
(`audit/error-handling/raw/probe3-api.txt`) — same for `GET /api/documents/:id/backlinks`,
`GET /api/weeks/:id`, and `?type=bogus` on the documents list (ERR-5). Separately, `?limit=-1` and
`?limit=999999999` on the documents list both returned the full ~300 KB payload, because the route
never read `limit` from the query at all (ERR-8).

**What changed.**

- **`api/src/middleware/paramValidation.ts` (new)** — the shared fix, extending the repo's existing
  body-validation pattern to params/query instead of inventing a new one:
  - `validateUuidParam` — an Express `router.param` callback. Registered once per router
    (`router.param('id', validateUuidParam)`), it guards **every** route using `:id` in that router
    against a malformed uuid, returning `{ error: 'Invalid input', details: [...] }` (the same shape
    body validation already used) instead of letting the pg cast error reach the client as a 500. A
    well-formed but nonexistent id is untouched and still falls through to the route's own 404.
  - `limitQuerySchema(max)` — a zod schema for an optional `limit` query param. Absent → unchanged
    behavior (no default cap introduced, so callers that never pass `limit` are unaffected).
    Non-numeric or non-positive (`-1`, `0`, `"abc"`) → fails validation (400). Above `max` → clamped
    down to `max` rather than rejected (ERR-8's "cap at a sane maximum").
- **`api/src/routes/documents.ts`** — `router.param('id', validateUuidParam)` guards `GET /:id`,
  `GET /:id/content`, `PATCH /:id/content`, `PATCH /:id`, `DELETE /:id`, `POST /:id/convert`,
  `POST /:id/undo-conversion`. `GET /` (list) gets a `listDocumentsQuerySchema` validating `type`
  against the full `document_type` Postgres enum (10 values, matching the already-registered
  OpenAPI `DocumentTypeSchema` — **not** the narrower 8-value set `createDocumentSchema` accepts for
  creation, since `standup`/`weekly_review` documents are created via their own routes but are real
  rows this filter already matched) and `limit` via `limitQuerySchema(100)`. When `limit` is
  provided, it is now applied as a real SQL `LIMIT`; `parent_id` handling is untouched.
- **`api/src/routes/backlinks.ts`** — `router.param('id', validateUuidParam)` guards
  `GET /:id/backlinks` and `POST /:id/links`.
- **`api/src/routes/weeks.ts`** — `router.param('id', validateUuidParam)` guards all 18 `:id` routes
  (`GET/PATCH/DELETE /:id`, `/:id/plan`, `/:id/issues`, `/:id/standups`, `/:id/review`,
  `/:id/carryover`, `/:id/approve-*`, `/:id/request-*-changes`, `/:id/scope-changes`, `/:id/start`).
  The probe's literal `GET /api/weeks/not-a-number` targets this same uuid path param — "number" was
  the malformed test string, not the field's real type.
- **`api/src/openapi/schemas/documents.ts`** — added `limit` to `GET /documents`'s documented query
  params and a `400` response, since that param is new. The `:id` uuid path params were already
  typed `UuidSchema` in every registration touched here (documents, backlinks, weeks) — the
  documented contract didn't change, only the runtime now enforces what was already promised.
  Regenerated `api/openapi.yaml` / `api/openapi.json` (additive only — `git diff --stat` shows +92/-0).

**Left alone on purpose.** `api/src/routes/issues.ts` has the identical `GET /:id` gap
(`GET /api/issues/not-a-uuid` also 500s per the probe) but was **not** touched: it has an open PR
against it right now, and both findings are fully covered by the routers above without it. Same
root cause, same fix (`router.param('id', validateUuidParam)`) would apply as a fast-follow.
`api/src/routes/associations.ts` (mounted at `/api/documents`) has the same `:id` gap and is outside
the audit's reproduced evidence — also not touched here.

**Frontend impact: none.** The only call site for `/api/documents?type=` sends `type=wiki`
(`web/src/hooks/useDocumentsQuery.ts:29`) — a valid enum value, still 200. No web code sends
`limit` to this endpoint, so the new validation and the `LIMIT` clause only activate for a query
string no current caller sends.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database
pnpm --filter @ship/api exec vitest run src/routes/param-validation-regression.test.ts
pnpm --filter @ship/api exec vitest run src/middleware/__tests__/paramValidation.test.ts
scripts/factory/gate.sh
```

`param-validation-regression.test.ts` hits the live routes via supertest (not the middleware in
isolation), covering both tickets: malformed uuid → 400 on `/api/documents/:id`,
`/api/documents/:id/backlinks`, and `/api/weeks/:id`; well-formed-but-absent uuid → 404 on the same
two GET-by-id routes (unaffected by this change); `?type=bogus` → 400 and `?type=wiki` → 200 on the
list; `?limit=-1`/`0`/`abc` → 400; `?limit=5` against 12 seeded documents → exactly 5 rows back
(proving the `LIMIT` is real, not just accepted); `?limit=999999999` → 200, no crash.
`paramValidation.test.ts` unit-tests the two helpers directly, including clamping against a small
`max` to prove the cap logic independent of the 100-row default.

**Rollback.** Revert the commits on `fix/err-5-err-8-param-validation`, or by hand: remove the three
`router.param('id', validateUuidParam)` lines (documents.ts, backlinks.ts, weeks.ts), remove
`listDocumentsQuerySchema`'s use in `documents.ts`'s `GET /` (restore the raw `req.query`
destructure and drop the `LIMIT` clause), delete `api/src/middleware/paramValidation.ts` and its
three imports, and revert the `limit`/`400` additions in
`api/src/openapi/schemas/documents.ts` (then re-run `pnpm --filter @ship/api openapi:generate`).

---

## TRO-197 (BUN-1) + TRO-198 (BUN-2) + TRO-199 (BUN-3) + TRO-200 (BUN-4) + TRO-202 (BUN-6) — the app stops shipping as one 2 MB file

Five findings, one root cause: `web/dist/index.html` referenced exactly **one** module script —
2,074.98 kB raw / 588.62 kB gzip — because nothing in the app split at a route boundary. Everything
else followed from that. There was no seam at which to defer the editor (BUN-2), the syntax
grammars (BUN-3) or the emoji picker (BUN-4), and no vendor chunk to cache (BUN-6). They ship as one
branch because fixing any one of them alone moves almost nothing.

**What a user actually downloads now**, by route. This is the static-import closure of the entry
chunk plus that route's chunk — not the `index.html` figure, which code splitting improves by
construction and therefore flatters any change of this kind:

| Route | Before | After | Change |
|---|---:|---:|---:|
| `/login` (unauthenticated first paint) | 601.47 kB gzip | **117.34 kB** | −484.13 (−80.5%) |
| `/docs` (4-panel layout + list) | 601.47 kB gzip | **181.92 kB** | −419.55 (−69.8%) |
| `/documents/:id` (layout + editor shell) | 601.47 kB gzip | **211.39 kB** | −390.08 (−64.9%) |

The audit's target was 600.75 → ≤ 480.60 kB gzip. Every route clears it. Total emitted bytes are
essentially unchanged (1,761.82 → 1,770.55 kB gzip, +0.5%) — as the audit predicted, this moves
bytes rather than deleting them, and total-bundle size is the wrong yardstick for it.

**The metric itself was corrected before these numbers were trusted.** The first version of
`audit/bundle/measure.mjs` derived each route's closure by walking `import "./x.js"` specifiers out
of the emitted chunks. That walk cannot see stylesheets, so CSS belonging to a lazy chunk was
omitted and every route read smaller than it is — the replacement for a flattering metric was
flattering in the same direction (CodeRabbit finding 1 on PR #14). It now reads
`dist/.vite/manifest.json` and follows `imports` while collecting `css` at every node, which is the
same graph Vite uses to emit modulepreload and stylesheet links.

Re-measured, the correction moves the numbers by **+0.05 kB gzip on `/login`, +0.02 on `/docs`,
+0.05 on `/documents/:id`** — the 80.5% headline stands. It is small for a specific reason worth
recording rather than glossing: this app's only lazy stylesheet is `assets/vendor-editor-*.css`
(1.41 kB raw / 0.53 kB gzip, the editor's Tippy styles), and it hangs off `vendor-editor`, which is
reachable only through the editor's dynamic import — so it was never inside any route's *static*
closure, and the entry stylesheet was already counted via the `index.html` `<link>`. The old method
was wrong; today's answer happened to be nearly right. The fix is what stops the next CSS-bearing
lazy chunk from going unmeasured silently.

**Conditions** (all figures): Node v23.2.0, pnpm 10.27.0, gzip level 9, kB = 1000 bytes, baseline
`main` at `4d74602`. Reproduce from the repository root:

```bash
cd web && pnpm build && cd .. && node audit/bundle/measure.mjs web/dist
# deploy churn also needs a previous dist to compare against:
#   node audit/bundle/measure.mjs web/dist --baseline /path/to/previous/dist
```

**Build from `web/`, not the repo root** — Tailwind's `content` globs resolve against the CWD, so
building from the root silently under-generates the CSS. The `cd ..` matters too: the script's paths
are relative to the repository root, so running it from `web/` cannot find `web/dist`.

The baseline was rebuilt from `main` in an isolated `git archive` copy rather than by mutating this
worktree, so every before/after pair comes from the same tool and the same machine.

**TRO-197 / BUN-1 — route-level code splitting** (`web/src/main.tsx`, `web/src/pages/App.tsx`,
`web/src/components/RouteFallback.tsx`). All 23 page components were statically imported, so a
visitor on `/login` downloaded the admin dashboard, the org chart, the reviews queue and the whole
TipTap/Yjs stack before the login form could paint. Every page is now `React.lazy`; most use named
exports, hence `.then(m => ({ default: m.X }))`. **`LoginPage` deliberately stays static** — it is
the first paint for an unauthenticated visitor, and deferring it would trade one oversized download
for two round trips before the form appears.

Two Suspense boundaries, and the placement is the whole risk: the outer one (in `main.tsx`) covers
the standalone routes and `AppLayout` itself; the inner one sits **inside `<main>` in
`pages/App.tsx`**, so the Icon Rail, Contextual Sidebar and Properties Sidebar stay mounted while a
page chunk loads. A single boundary above `AppLayout` would tear the 4-panel layout down and rebuild
it on every navigation — the flash the audit warned about.

Measured on its own (2, 3, 4 and 6 reverted on the final tree): /login 601.47 → 112.40 (−489.07),
/docs 601.47 → 176.86 (−424.61), /documents/:id 601.47 → 530.49 (−70.98) kB gzip.

**TRO-198 / BUN-2 — the editor loads when an editor is shown** (`web/src/components/LazyEditor.tsx`;
consumers `UnifiedEditor.tsx`, `pages/PersonEditor.tsx`). `@tiptap/*` + `prosemirror-*` + `yjs` +
`lib0` + `y-*` + `linkifyjs` are 726.5 kB raw / 208.7 kB gzip and were pulled statically by every
route that *could* show an editor — including project, program and week documents, which render a
tab component and never mount one. `LazyEditor` is **not a second editor**: it is the same shared
`components/Editor` behind a dynamic import, with the prop type derived from it so the contract
cannot drift.

Safe because `Editor` creates its own `Y.Doc`, `WebsocketProvider` and `IndexeddbPersistence` inside
its own effects and neither consumer holds a ref to it — deferring the mount defers the whole
collaboration setup as a unit rather than interleaving it. `initialTitle` is forwarded verbatim, so
the `"Untitled"` placeholder contract is untouched. Measured on its own (static import restored on
the final tree): **/documents/:id 442.95 → 211.39 kB gzip, −231.56**, the largest single win here.

**TRO-199 / BUN-3 — 37 syntax grammars down to 12** (`web/src/components/editor/lowlight.ts`,
`Editor.tsx:12`). `createLowlight(common)` registered arduino, vbnet, objectivec, r, lua, perl,
wasm and 30 others. Kept: **bash, css, diff, javascript, json, markdown, python, shell, sql,
typescript, xml (covers html), yaml**. Verified no seeded document is affected: zero of the 523
documents in the seeded database contain a `codeBlock` node (in `content` or in `yjs_state`), and
neither `api/src/db/seed.ts` nor `welcomeDocument.ts` emits one; the only language named anywhere in
the repo is `javascript`, in `e2e/syntax-highlighting.spec.ts`.

**Correction to what this entry first claimed.** It said a dropped language "renders as plain
monospace rather than throwing". That was inferred from a grep of the extension's guard, not from
running it, and it is wrong. Reading `getDecorations` in
`node_modules/@tiptap/extension-code-block-lowlight/dist/index.js` in full, the fallback is
`lowlight.highlightAuto(text)`, not "no highlighting":

```js
const nodes = language && (languages.includes(language) || registered(language) || lowlight.registered?.(language))
  ? getHighlightNodes(lowlight.highlight(language, text))
  : getHighlightNodes(lowlight.highlightAuto(text));
```

So a code block tagged `arduino` is **still highlighted**, by auto-detection among the grammars we
kept — observed, not derived: rendering that block through the real extension produces
`<span class="hljs-keyword">void</span>`. The degradation is better than reported, and the regression
risk of BUN-3 is correspondingly lower. Two further things that grep hid: `registered()` consults
highlight.js's *own* singleton bundled inside the extension, not our instance, so
`languages.includes()` off `lowlight.listLanguages()` is the check that actually carries our curated
list; and the author's `language-arduino` class is preserved on the `<code>` element, so re-adding a
grammar later restores exact highlighting. All three facts are now pinned by tests that drive
`CodeBlockLowlight` itself rather than the raw lowlight instance (CodeRabbit finding 2).

Measured on its own: the grammar chunk drops 52.22 → 22.56 kB gzip (−29.66), and total emitted bytes
fall 29.52 kB. It does not move any route's payload (211.38 vs 211.39 on `/documents/:id`, i.e. noise),
because BUN-2 already moved the editor off every route's static closure — BUN-3's win is in the chunk
that arrives when the editor mounts.

**TRO-200 / BUN-4 — the emoji picker loads on click** (`web/src/components/EmojiPickerBody.tsx`,
`EmojiPicker.tsx`). `emoji-picker-react` shipped on every page load, `/login` included, for one
consumer: the project-icon `PropertyRow` in `ProjectSidebar`. The package import now lives in its
own module — that, not the `React.lazy` call, is what creates the boundary; naming the package at
value level in `EmojiPicker.tsx` (for its `Theme` enum, say) would pull it all back while the code
still looked correct. The fallback is sized 300×350 so the popover does not resize under the cursor.
Measured on its own (static import restored on the final tree): **/documents/:id 274.75 → 211.39 kB
gzip, −63.36**, for a component behind a click.

**TRO-202 / BUN-6 — a vendor split, judged on bytes changed per deploy** (`web/vite.config.ts`).
The config had no `build` key at all, so stable dependency code shared a content hash with volatile
app source. **This does not reduce the initial payload — it costs about 5 kB gzip per route** — and
scoring it on `initialGzipKb` would read as a no-op or a regression. The right measurement is what a
returning user with a warm cache re-downloads after a routine deploy. Editing one string in
`web/src/pages/Login.tsx` and rebuilding:

| Route | Before | BUN-1..4 only | After (with BUN-6) |
|---|---:|---:|---:|
| `/login` | 588.61 kB gzip (97.9% of route) | 99.87 kB (88.9%) | **31.70 kB (27.0%)** |
| `/docs` | 588.61 kB gzip (97.9%) | 164.09 kB (92.8%) | **67.23 kB (37.0%)** |
| `/documents/:id` | 588.61 kB gzip (97.9%) | 193.13 kB (93.6%) | **96.31 kB (45.6%)** |

BUN-6's own contribution is the last column against the middle one: **−68.17 kB on `/login`, −96.86
on `/docs`, −96.82 on `/documents/:id`** per deploy, for +4.96 to +5.09 kB on a first visit
(/login 112.40 → 117.34, /docs 176.86 → 181.92, /documents/:id 206.30 → 211.39).

Two rules are encoded in the config and both were found by measuring, not by reasoning. **Never
merge a lazily-reachable package into an eagerly-reachable chunk** — a manual chunk loads as soon as
anything in it is statically reachable, so a catch-all `vendor` would have silently undone BUN-2 and
BUN-4 while the split still existed on disk. And **Rollup's CommonJS interop helpers must be pinned**:
left unassigned they landed in `vendor-highlight`, which every chunk then imported, dragging 22.6 kB
gzip of syntax grammars back into first paint. A `vendor-ui` group for Radix/cmdk/dnd-kit was tried
and **rejected on measurement** — it cost 15.0 kB gzip on `/docs` and `/documents/:id`, because a
route needing one primitive then downloads all of them.

**Build config also now emits a manifest.** `build.manifest: true` is what lets
`audit/bundle/measure.mjs` see the CSS graph. It ships `dist/.vite/manifest.json` to S3/CloudFront
with the rest of `dist`; it exposes chunk names, which are already enumerable from the entry chunk,
and no source paths beyond the module ids already present in the bundle. Keeping it on means the
build that is measured is the build that is deployed.

**New dependency:** `highlight.js` is now an explicit dependency of `@ship/web`. It was already in
the tree via `lowlight`, but importing individual grammars from it without declaring it would be a
phantom dependency. No new package entered the lockfile's resolution set.

**Regression tests** (all in `web/src/**`, so `scripts/factory/gate.sh` actually executes them — an
`e2e/` spec satisfies the gate's "test added" check while never running):

- `web/src/test/sourceImports.ts` + `sourceImports.test.ts` — **the guard behind the guards.** Three
  tests below assert that a module is never statically imported, which is the only thing keeping a
  split boundary from silently re-merging. Each originally carried its own narrow regex, and review
  found two of them (CodeRabbit findings 3 and 4) matched only the single form that was written at
  the time. Verified by injecting a static page import into `main.tsx` in seven forms — named with
  double quotes, default, namespace, multi-line braces, side-effect, relative path, re-export: **the
  old regex missed all seven; the shared detector catches all seven.** 30 tests cover the forms it
  claims to catch and the type-only/dynamic/commented forms it must ignore.
- `web/src/main.routes.test.ts` — no page may be statically imported except `Login`; every lazy
  loader names a real export; the child-route Suspense boundary stays inside `<main>`. **Red before
  the fix** (4 assertion failures against `main`'s `main.tsx`/`App.tsx`).
- `web/src/components/editor/lowlight.test.ts` — two blocks. The registry block asserts the grammar
  list is exactly the curated 12: **red before the fix** (9 assertion failures against
  `createLowlight(common)`). The integration block drives a real `Editor` with
  `CodeBlockLowlight.configure({ lowlight })` and asserts on rendered DOM, because nothing in the
  registry block proved the extension ever reaches our registry (CodeRabbit finding 2). Its
  discriminating case: for `+added line`, the `diff` grammar emits `hljs-addition` while
  auto-detection emits `hljs-selector-tag`, so a silent fall-through to `highlightAuto` fails the
  test where a language-class check would pass. It also pins that a dropped language does not throw
  and that the code survives byte-for-byte. Regression guard, not red-before-green — `common`
  contains those grammars too.
- `web/src/components/EmojiPicker.test.tsx` — picker opens on click, closes on Escape, clears
  through `onChange`, the package import stays out of `EmojiPicker.tsx` and stays in
  `EmojiPickerBody.tsx`. The import assertions were **red before the fix**; the interaction tests are
  regression guards and passed both ways, which is their purpose.
- `web/src/components/LazyEditor.test.tsx` — the editor still mounts, `"Untitled"` is forwarded
  verbatim, `documentId`/`roomPrefix` reach the editor unchanged, and the fallback is the panel
  variant. Regression guards.
- `web/src/components/RouteFallback.test.tsx` — the surrounding 4-panel chrome stays mounted while a
  lazy child resolves. Regression guard for the layout-flash risk.

**Rollback.** Per finding, in decreasing order of risk: revert `LazyEditor.tsx` and repoint
`UnifiedEditor.tsx`/`PersonEditor.tsx` at `@/components/Editor` (BUN-2); delete
`build.rollupOptions` and the `manualChunks` function in `web/vite.config.ts` — but **keep
`build.manifest: true`**, which is measurement infrastructure rather than part of BUN-6, and without
which `audit/bundle/measure.mjs` cannot run (BUN-6); restore `createLowlight(common)` in `Editor.tsx` and delete
`components/editor/lowlight.ts` (BUN-3); restore the static `emoji-picker-react` import in
`EmojiPicker.tsx` (BUN-4); replace the `React.lazy` declarations in `main.tsx` with static imports
and drop both Suspense boundaries (BUN-1). BUN-1 must be reverted last — the others depend on the
seam it creates.

**Still open, deliberately.** Vite still prints its >500 kB warning: `vendor-editor` is 577.5 kB raw.
The warning limit was *not* raised — silencing it would remove the only signal in the build about
this class of problem. BUN-5 (245 icon chunks, 209 unreferenced), BUN-7, BUN-8 and BUN-9 are
untouched and remain open.

**Found while measuring, not fixed here.** `web/tailwind.config.js` scans `./src/**/*.{js,ts,jsx,tsx}`,
which includes test files, so utility classes that exist only in a test inflate the shipped
stylesheet — the tests added by this branch grew `index-*.css` by 0.32 kB raw / 0.04 kB gzip. The fix
is to narrow the glob (e.g. exclude `*.test.*`), but `tailwind.config.js` was just modified by
TRO-217 and this is not the branch to contend for it. Filed rather than folded in.

---

## TRO-178 — [DB-1] `pnpm db:migrate` silently skipped 32 of 42 migrations and exited 0

**What was broken.** `api/src/db/migrate.ts:103-111` wrapped *both* the `schema.sql` application
and the migration loop in one `try`, and its handler matched any error message containing the
substring `already exists`. `010_oauth_state.sql:8` created `oauth_state` without `IF NOT EXISTS`
while `schema.sql:90` had already created it, so the migration threw `relation "oauth_state"
already exists` — indistinguishable, to that handler, from a benign `schema.sql` re-run. It logged
`Database schema already exists, continuing...`, returned normally, abandoned the remaining 32
files, and the process exited **0**. A second run behaved identically; it did not self-heal.

The report's hypothesis held exactly, including its list of the other blocking files.

**What changed.**

- `api/src/db/migrationRunner.ts` (new) — the migration logic, extracted from `migrate.ts` so it
  can be exercised by tests. `migrate.ts` is now the CLI wrapper: env, pool, exit code.
- The `already exists` tolerance now lives inside `applySchema` and covers only the `schema.sql`
  call, so a failure in the migration loop can no longer be mistaken for one. It matches Postgres
  SQLSTATE duplicate-object codes (`42P04`, `42P06`, `42P07`, `42701`, `42710`, `42723`) instead of
  a substring — substring matching on `already exists` would also swallow, for example, a failed
  `ALTER ... ADD CONSTRAINT` in a data migration.
- A failing migration is rethrown with its filename in the message, and `migrate.ts` exits 1.
- `applySchema` no longer swallows the duplicate-object error it tolerates — it **re-applies**
  `schema.sql` and lets the second attempt decide. `pool.query` sends the file as one simple query,
  so Postgres runs it as a single implicit transaction: an error at statement *k* rolls back
  statements 1..*k*-1 too, meaning nothing was applied. Returning normally there was DB-1 inside
  the DB-1 fix. A clean second pass proves every object exists (verified by the file itself, not by
  a hardcoded list that could drift); a second failure propagates and exits 1.
- Migrations `010`, `025`, `033`, `035` are now idempotent against the `schema.sql` end state
  (`IF NOT EXISTS`; a `pg_constraint` lookup for the CHECK constraint; `DROP TRIGGER IF EXISTS`
  before `CREATE TRIGGER`, the pattern `schema.sql:193` already uses; a `pg_enum`-guarded loop for
  the three `ALTER TYPE ... RENAME VALUE` statements). These four files are edited rather than
  superseded by a new migration, because a new migration cannot stop `010` itself from throwing,
  and databases that already recorded these versions never re-read them.
- Migration filenames are validated against `NNN_description.sql` — exactly three digits, an
  optional single letter (`007b_`, `014b_`, `015b_`, `018b_`, `020b_` all exist), then an
  underscore. The runner sorts the validated names **lexicographically**; that equals numeric
  order only because the pattern forces a zero-padded three-digit prefix, which is the whole
  reason the pattern is enforced. Anything outside it — an unnumbered `hotfix.sql`, or a
  four-digit `1000_` that would sort before `999_` — throws and names the offender before any
  migration is applied. The runner does not infer an order for such a file; it refuses to guess.
- Regression tests: `api/src/db/__tests__/migrationRunner.test.ts`.

**New ways `pnpm db:migrate` can now fail — all deliberate.** It previously exited 0 in every one
of these cases:

| Condition | Behaviour |
|---|---|
| any migration raises | exit 1, naming the file |
| migrations directory missing or unreadable | exit 1 |
| a `.sql` file there is not `NNN_description.sql` | exit 1, naming the offender |
| `033`: `document_type` has both `sprint_*` and `weekly_*` **and** documents still use the old label | exit 1 with the row count and the remedy |
| `033`: `document_type` has neither label of a pair | exit 1 |

The one state `033` deliberately tolerates is both labels present with **no** rows using the old
one — that is the normal outcome on a fresh database, because `schema.sql:100` declares the
post-rename labels and `017_standup_sprint_review_types.sql:14` then re-adds `sprint_review` via
`ADD VALUE IF NOT EXISTS`. Raising there would fail every fresh install.

**What the 32 previously-skipped migrations mean for an existing database.** Reported, not executed
against anything but a factory database — this is the part that needs an operator's eyes before the
next production deploy. Measured over `011`–`037` (31 files; `010` is the 32nd):

| | count |
|---|---|
| `ALTER TABLE` | 19 |
| of which `DROP COLUMN` | 3 |
| `CREATE TABLE` | 7 |
| `ALTER TYPE` | 4 |
| `UPDATE` / `INSERT` / `DELETE` statements | 27 / 8 / 3 |

`schema.sql` contains **zero** `ALTER TABLE` and **zero** DML, so on a database that already exists
these 31 files are the only mechanism that would ever have changed it. Notable: `027`/`029` drop
`documents.sprint_id`, `documents.project_id`, `documents.program_id`; `033` renames three
`document_type` enum labels `sprint_* → weekly_*` and rewrites matching `properties` JSON; `014b`,
`028` and `034` are backfills. **The first deploy after this change will apply all 32 at once.**
Take a snapshot first and run `pnpm db:migrate` against a restore of production before running it
against production.

**How to run it.**

```bash
source .factory-env                      # or otherwise point DATABASE_URL at the target
pnpm db:migrate                          # now exits non-zero on any migration failure
pnpm --filter @ship/api test src/db/__tests__/migrationRunner.test.ts
```

Verify with `select count(*) from schema_migrations;` — it should equal the number of `.sql` files
in `api/src/db/migrations/` (42 today), not 10.

**Verified** against PostgreSQL 15-alpine in the `ship-audit-pg` container on `:5433`:

- fresh database → 42 rows in `schema_migrations`, exit 0
- second run on it → clean no-op, still 42, exit 0
- `ship_wt_tro_178`, stuck at 10 rows (the state DB-1 had left it in) → 32 applied, 42 rows, exit 0
- a database seeded with the *pre-*`033` enum labels → renamed to `weekly_*`, 42 rows, exit 0
- both enum labels present plus one stale document → exit 1, naming the count and the remedy
- `document_type` missing both labels of a pair → exit 1
- applying `schema.sql` three times in a row against one database → no error any time, so the
  duplicate-object tolerance in `applySchema` is unreachable **sequentially** for the current file
  (17/17 `CREATE TABLE` and 59/59 `CREATE INDEX` guarded, both `CREATE TYPE`s in guarded `DO`
  blocks, function `OR REPLACE`, trigger preceded by `DROP TRIGGER IF EXISTS`)
- applying `schema.sql` from **6 connections at once** → 5 of 6 failed, so it is emphatically
  reachable **concurrently**: `CREATE TABLE IF NOT EXISTS` is check-then-create and not atomic.
  Mostly SQLSTATE 23505 on the catalog index `pg_type_typname_nsp_index`, sometimes 42710. 23505 is
  deliberately not tolerated; the concurrency defect itself is TRO-279
- `pnpm --filter @ship/api test` against the fully-migrated database → 475 tests passed

**Not verified.** No run against production or shadow, and no run against PostgreSQL 16 (production
runs pg16; CI and this work run pg15 — see the pin comment in `.github/workflows/ci.yml`). Proving
the production path needs a restore of a production snapshot.

**Rollback.** `git revert` the commits on `fix/db-1-migration-runner`, or, to restore only the old
runner behaviour, delete `api/src/db/migrationRunner.ts` and restore `api/src/db/migrate.ts` from
`main`. Rolling back the runner alone leaves migrations `010`/`025`/`033`/`035` idempotent, which is
harmless. Note that rollback does **not** un-apply migrations already recorded in
`schema_migrations`; reversing those requires a database restore.

---

## TRO-276 (ERR-10) — one malformed WebSocket frame no longer kills the API for everyone

**The user-facing cost.** Any authenticated user could send four bytes down a collaboration socket
and the entire API process died — every open editor in every workspace disconnected, every in-flight
request dropped, until the container restarted. It did not need malice: a truncated frame from a
flaky connection does it. Measured against a real running server, 5 of 7 malformed frames produced
an uncaught exception.

**Root cause.** `handleMessage()` in `api/src/collaboration/index.ts` decodes attacker-controlled
bytes with raw lib0 readers, which throw on truncated input. It was called from `ws.on('message')`
with no try/catch anywhere in the chain, and there was no `process.on('uncaughtException')` handler
in `api/`, `web/` or `shared/`. A `ws` 'message' listener is an I/O callback: a throw there escapes
to the process, and Node's default for an unhandled `uncaughtException` is to terminate.

**What changed.**

- `runFrameHandler()` wraps the **entire** body of both `ws.on('message')` handlers — the
  collaboration socket and the events socket. On a throw it logs structured context and closes that
  one socket with code **1002** (RFC 6455 protocol error). No other connection is affected. The
  whole body is guarded, not just the `handleMessage()` call, so the rate limiter and any future
  addition are covered too. It composes with the ERR-2 `revoked` check rather than duplicating it:
  the revocation short-circuit is now the first statement *inside* the guard, so a revoked socket is
  not even decoded. It also contains a **rejected promise**: `() => void` accepts an `async` function
  in TypeScript, so an async handler added later would reject after the `try/catch` had exited and
  escape as an unhandled rejection — ERR-10 again by the back door. A thenable result is routed
  through the same log-and-close path, and a test pins it.
- On the events channel the `catch` around `JSON.parse` no longer spans the response as well. It
  previously swallowed anything raised while replying, so an error there was discarded instead of
  reaching the guard's log-and-close path — a `catch {}` covering more than its comment claims is how
  a guarded handler quietly stops being guarded.
- `attachSocketErrorHandler()` covers a second vector of the same class. `ws` reports framing and
  transport failures by emitting `'error'` on the WebSocket, and `EventEmitter` throws an `'error'`
  event that has no listener — so a peer sending a frame with a reserved bit set crashed the process
  without ever reaching `handleMessage()`. It is attached as the **first statement** of the
  connection handler, before any `await`: that handler is `async` and loads the document from
  Postgres, and a frame arriving during that window found the socket unguarded. This was found by
  the regression test, against the first version of this fix. The events handler registers it first
  too — there, honestly, as defence in depth rather than a live fix: that handler is synchronous, and
  `ws.send()` with no callback does not emit `'error'` on a closed socket (`sendAfterClose` builds the
  error only `if (cb)`), so nothing could slip in ahead of a later registration. "Error listener
  first" is simply cheaper to hold as an invariant than to re-derive.
- `api/src/process-safety.ts` — `installProcessSafetyNet()`, wired in at `api/src/index.ts` only
  (the entrypoint, so importing the app never hijacks a test runner's error handling). It takes
  ownership of `uncaughtException` / `unhandledRejection`, logs full structured context, stops
  accepting new connections, and exits **1** after a bounded 5s drain.

**Why the safety net exits rather than continuing.** By the time it fires, the exception has escaped
every guard, so nothing is known about the state left behind — Node's own guidance is that resuming
is undefined behaviour. Continuing would trade a fast restart for an indefinitely, silently wrong
server. It is also not an availability regression, which is the decisive point: with no handler
installed, Node **already** terminates on an uncaught exception, and (since v15) on an unhandled
rejection too. This cannot make the process die more often than it does today. What it changes is
everything around the death — structured context instead of a bare stack, the listening socket
closed first, a bounded window for in-flight work, and a deliberate non-zero code for the supervisor
(`Dockerfile:75` runs `node dist/index.js` as the container command, so a non-zero exit is a
restart). The availability win comes entirely from the try/catch; the safety net only makes failures
legible.

One trap worth recording, because it already cost this project a ticket: **the stack trace lies.**
lib0 builds `errorUnexpectedEndOfArray` as a module-scope singleton `Error` whose stack is captured
at module *load*, so every one of these crashes points at whatever first imported lib0 rather than
at the throw site. Both the frame log and the fatal log therefore carry an explicit caveat on the
stack field, and the frame log identifies the input by other means.

**What the frame log does and does not contain.** It records frame *identity*, never frame content:
a truncated SHA-256 digest, the byte length, and the protocol message type. The first version of
this fix logged a 32-byte hex prefix of the frame, which was wrong — a frame that failed to decode
has usually been *partially* decoded, so its leading bytes can carry fragments of document text, and
logs get shipped, aggregated and retained. A digest preserves the property that matters for triage
(the same frame sent twice yields the same identity, so a repeated or automated attack is visible)
without the log holding the payload. Stated limit: for a very short frame the digest is reversible
by brute force, which is acceptable precisely because a four-byte frame cannot contain document
content, and the frames long enough to carry any are far too large to enumerate. The cost is that a
byte-exact replay can no longer be reconstructed from a log line; error name, length and message
type localize the failing decode path well enough to rebuild the frame by construction.

**How to run it.**

```bash
source .factory-env   # api tests TRUNCATE 16 tables; never run without this
pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/malformed-frames.test.ts
pnpm --filter @ship/api exec vitest run src/__tests__/process-safety.test.ts
```

`malformed-frames.test.ts` drives the real collaboration server over real sockets with each frame
from the audit table plus a raw hand-rolled WebSocket frame with RSV1 set, and asserts that nothing
reaches the process level, that the offending socket is closed **with code 1002**, that a co-tenant
editor on the same document keeps working, and that new connections still persist edits afterwards.
It also pins the two frames that were always survivable (`[0,1]`, `[9,9,9]`) as still survivable, so
an over-broad fix that hangs up on legitimate traffic fails.

It contains **no fixed sleeps** (TEST-11 / TRO-233). Every wait is an observable: socket closures are
awaited as `'close'` events, and liveness is proved by pushing a write through a socket and reading
it back out of `documents`. The one polling helper reads the database until the row appears, because
`persistDocument()` is debounced inside the server and emits no external signal — it returns as soon
as the condition holds and the caller asserts on the value, so a timeout surfaces as a real
assertion about content rather than as "waited long enough". Each malformed frame gets its own fresh
attacker connection, so no case is ever asserting against a socket a previous case already closed.
`process-safety.test.ts` uses vitest fake timers, which is what lets it prove the *absence* of a
second exit after the drain window elapses.

Red before green, with `api/src/collaboration/index.ts` restored to the version on `main`:
**8 failed / 3 passed**, every failure a clean assertion — five naming the escaped exception
(`Unexpected end of array`, `Invalid typed array length: 5`), one naming
`Invalid WebSocket frame: RSV1 must be clear`, one `expected undefined to be 1002` for the missing
close-code constant, and one `expected false to be true` for the socket that was never closed. With
the fix: **12 passed** (the twelfth is the async-escape case, which has no unfixed counterpart —
verified red by removing only the thenable branch, giving
`unhandledRejection -> Error: async frame handler rejected`).

Note for anyone repeating that check: reverting with `git checkout HEAD -- <file>` stops working once
the fix is committed, because `HEAD` then *contains* the fix. Use `git show main:<file>`.

**How to roll it back.**

```bash
git revert <commit>   # or, per piece:
```

Reverting `api/src/process-safety.ts` plus its two lines in `api/src/index.ts` restores Node's
default crash behaviour without touching the frame guards — the guards are independent and are the
part that matters. Reverting `runFrameHandler` / `attachSocketErrorHandler` in
`api/src/collaboration/index.ts` restores the crash. No schema change, no migration, no config, no
API surface change; the only observable difference for a well-behaved client is that a client
sending undecodable bytes is now disconnected with close code 1002 instead of taking the server with
it.

---

## TRO-179 (DB-2) + TRO-177 (API-6) — authenticated reads stop rewriting the session row once per request

One statement, measured from two sides. `authMiddleware` ran
`UPDATE sessions SET last_activity = $1 WHERE id = $2` **unconditionally on every authenticated
request** (`api/src/middleware/auth.ts:205-208` on `main`), so a page that only *reads* still
produced one row-locking, WAL-generating write per request — and a single page load fires 5-13 of
them, all against the same row.

- **TRO-179 / DB-2 (SQL side):** three statements ran before any application data — a session+user
  SELECT, a workspace-membership SELECT, and the write. That was 16 of 17 queries on "List issues"
  and 34 of 51 on "Load sprint board". The write ran 121 times during capture and was the slowest
  statement in five of six flows (peak 4.764 ms) against an isolated EXPLAIN of 0.178 ms.
- **TRO-177 / API-6 (HTTP side):** `GET /api/documents/:id` returned ~2.2 KB from one indexed PK
  lookup yet cost P50 2.6 ms / P95 4.8 ms at c=10.

**What changed.** The fix was already written three lines below the bug: the sliding-cookie refresh
had always been throttled to once per 60s ("throttled to avoid overhead"); the same threshold was
simply never applied to the database write. Both halves of the sliding expiration now share one
throttle (`SESSION_ACTIVITY_UPDATE_THRESHOLD_MS`, 60s).

**Precisely what the throttle does and does not do.** Reads *within* the 60s window issue no write
at all. The first read *after* the window still refreshes `last_activity` — the sliding expiration is
intact, so a session in continuous use never expires. What is gone is the one-write-per-request
pattern, not the write.

**The throttle is enforced twice, and both placements are load-bearing.** The application-side check
uses the value the request already SELECTed, so when it says "not due" no statement is sent — that is
what removes the query from the hot path. But that value can already be stale: a page load fires 5-13
requests in parallel, and when the burst straddles the threshold they all read the same pre-write
`last_activity` and all conclude the write is due. So the predicate is repeated in SQL —
`UPDATE ... WHERE id = $2 AND last_activity < $3` — and Postgres arbitrates: under READ COMMITTED the
losers re-evaluate the qualification against the committed row version, fail it, and affect zero
rows. Measured below: without the SQL predicate a 10-request burst produced **10** row versions;
with it, **1**. Dropping either placement re-opens half the finding.

The expiry invariant survives the conditional write. A no-op leaves the row at its previous value,
and the UPDATE no-ops *only* when `last_activity >= now - threshold` failed the predicate — which is
exactly the bound the grace below assumes. In all three cases (application check skipped, write
applied, write no-opped) the stored `last_activity` is `>= requestTime - threshold`, so the lag is
still capped at one threshold. The conditional form is in fact strictly stronger: the unconditional
version could move `last_activity` *backwards* when two concurrent requests wrote timestamps captured
microseconds apart.

**Session expiry semantics — read this before changing the threshold.** Throttling the write means
the recorded `last_activity` trails real request activity by up to 60s. Comparing a lagging value
against a bare `SESSION_TIMEOUT_MS` would end sessions *early* — a user idle 14:01 could be logged
out of a 15-minute window. That is the unsafe direction, for two reasons:

1. The web client runs its own 15-minute idle timer off real user interaction
   (`web/src/hooks/useSessionTimeout.ts:295-305`) and does not heartbeat the server. A server window
   that can close before 15 minutes produces an unexplained 401 while the client still believes it
   is logged in.
2. The collaboration server reads `last_activity` on a 30s sweep and deliberately never refreshes it
   (see TRO-189 below). A tighter bound there would tear down the socket of a user whose REST
   requests are still being served — and the socket is where unsaved editor state lives.

So the enforced inactivity window is `SESSION_INACTIVITY_LIMIT_MS = SESSION_TIMEOUT_MS +
SESSION_ACTIVITY_UPDATE_THRESHOLD_MS` (16 min), applied identically by the REST middleware, the
refreshed cookie's `maxAge`, and the collaboration server's `isSessionRowValid()`. **True idle
logout now lands in [15:00, 16:00] instead of [14:00, 15:00]** — the rounding error extends a
session rather than ending one. The 12-hour absolute cap (`ABSOLUTE_SESSION_TIMEOUT_MS`) is
untouched, and 16 minutes remains well inside NIST SP 800-63B AAL2's 30-minute inactivity guidance.

**Measured** — `GET /api/documents/:id`, 12 sequential authenticated reads inside the throttle
window, `NODE_ENV=test`, vitest + supertest, concurrency 1, worktree PostgreSQL 15:

| | statements | per request | `last_activity` writes | auth share |
|---|---|---|---|---|
| before (`main`) | 60 | 5.00 | 12 | 60% |
| after | 48 | 4.00 | **0** | 50% |

20% fewer statements per read; the session-row write is gone from the hot path entirely. This is a
query-**count** measurement — the audit's c=10/c=50 latency numbers need a running server and a load
generator, and were not reproduced here.

**Measured, concurrent** — 10 parallel authenticated requests on one session parked 61s back, so the
whole burst straddles the threshold. Same conditions, plus a pre-warmed connection pool (a cold pool
serializes the burst and hides the effect entirely):

| | UPDATE statements | row versions written |
|---|---|---|
| application-side gate only | 10 | 10 |
| gate + SQL predicate | 10 | **1** |

The statement count is identical — all ten requests read the same stale row and all ten ask — but
only one row version, and therefore one row lock and one WAL record, results. Row-lock and WAL
contention on this single shared row is what the audit measured as the 0.178 ms → 4.764 ms gap.

**Files:** `api/src/middleware/auth.ts` (throttle + the two window constants),
`api/src/collaboration/index.ts` (mirrors the window).
**Tests:** `api/src/middleware/__tests__/session-activity-throttle.test.ts` (write skipped inside the
window, written after it, the SQL predicate's shape, and both expiry boundaries),
`api/src/middleware/__tests__/session-activity-race.test.ts` (one row version under a concurrent
burst), `api/src/routes/documents-query-count.test.ts` (statements per authenticated read).

**Rollback:** revert the commits on `fix/db-2-api-6-session-write`. No migration, no schema change,
no data change — sessions written under either version are interpreted correctly by the other.

---

## TRO-173 (API-2) + TRO-182 (DB-5) — the issue list stops shipping every issue's document body

Two findings, one cause, one change. API-2 measured it at the socket (`GET /api/issues` was the
slowest endpoint at every concurrency level and sent 379,907 bytes for 254 issues); DB-5 measured
the same thing in the planner (`width=1023` per row, against `width=300` for the `/api/documents`
projection that omits `content`). The list and detail views shared **one** SELECT projection
(`api/src/routes/issues.ts:126`, `content: row.content` at `:99`), so the list carried each issue's
full TipTap body, and there was no `LIMIT`/`OFFSET` anywhere in the file.

**Not a query problem.** The handler already batches associations in one `ANY($1)` query
(`api/src/utils/document-crud.ts:148-180`) — no N+1 — and the plan is a seq scan over 254 rows
costing ~142. The cost was `JSON.stringify` plus socket writes. No index was added; none was
missing.

**What changed.**

- `extractIssueFromRow` split into `extractIssueListItemFromRow` (shared fields) plus a thin
  `extractIssueFromRow` wrapper that adds `content` back. `GET /api/issues/:id`,
  `/by-ticket/:number` and `/:id/children` still return the body and are byte-identical.
- `d.content` removed from the list SELECT.
- `limit` (1-500) and `offset` (0-100,000) added to `GET /api/issues`. Both are bounded at both
  ends: unparseable, negative, fractional or over-maximum values get **400**, never silent
  truncation. `offset` is capped because an unbounded one is scanned and discarded inside Postgres —
  `OFFSET 1e9` buys a full scan that returns nothing.
- The route validates with `IssueListPaginationSchema` **imported from the OpenAPI schema module**,
  not a second copy, so the bounds Swagger advertises and the bounds the route enforces cannot
  drift.
- Both extractors take declared row types (`IssueListRow` / `IssueDetailRow`) instead of `any`. From
  PR review: an `any` *annotation* silences every field read, which on a projection extractor meant
  the exact thing this change touched — which columns the SELECT returns — was the one part not
  type-checked. Verified by introducing `row.titel` and getting
  `TS2551: Property 'titel' does not exist on type 'IssueListRow'`; under `any` that compiled.
  What it does not buy: TypeScript still cannot read the SQL string, so deleting a column from a
  query is not a compile error.

**The pagination contract, stated deliberately: there is NO default limit.** Omit both params and
you get every matching row, in the same order, exactly as before. That is not laziness — two
consumers read the response as a complete set, and a default limit would have returned *wrong*
lists rather than shorter ones:

- `web/src/hooks/useIssuesQuery.ts:137-143` filters by project **client-side** over the whole array
  (the API has no `project_id` filter — see the follow-up below).
- `web/src/components/IssuesList.tsx:310-330` groups, counts and merges the full array, including
  the "Show All Issues" path.

No web caller passes `limit` or `offset` today, so no existing caller changes behaviour. New
callers (and the generated MCP tool) can now bound a response; a caller knows it has the last page
when it receives fewer rows than it asked for.

**Contract change is registered with OpenAPI.** `GET /issues` now responds with a new
`IssueListItem` component — `Issue` minus `content` — and documents `limit`, `offset` and the 400.
`api/openapi.{json,yaml}` regenerated, so Swagger and the runtime-generated MCP tools describe the
shape the route actually returns. `Issue` (27 properties, with `content`) still backs the detail
paths.

**Evidence.** Same machine, same worktree, same deterministic dataset for every number below:
PostgreSQL 15-alpine in Docker (`ship-audit-pg`, `:5433`), API on `:3155` via `tsx watch` with
`NODE_ENV=development`, `pnpm db:seed` + `audit/seed-augment.ts` → **500 documents / 254 issues /
20 users** (the audit's volumes; the seed is fixed-seed so before and after ran against identical
bytes — `sum(pg_column_size(content))` = 158 kB / 64.5% of issue row bytes both times, matching
DB-5's figure). Before/after were measured by swapping only `api/src/routes/issues.ts`.

| | before | after | |
|---|---|---|---|
| `GET /api/issues` payload (254 issues) | 379,907 B | **241,338 B** | 1.57× smaller |
| `EXPLAIN` row width | `width=1023` | **`width=335`** | 3.05× narrower |
| p95 @ c=10 | 42.0 ms | **28.6 ms** | |
| p95 @ c=25 | 90.4 ms | **59.1 ms** | |
| p95 @ c=50 | 184.0 ms | **107.9 ms** | |
| p99 @ c=50 | 228.4 ms | **161.2 ms** | |
| throughput ceiling (Little's law) | ~311-325 rps | **~490-546 rps** | |
| `GET /api/issues?limit=50` | 379,907 B (ignored) | **47,608 B** | |
| `GET /api/issues/:id` | 1,802 B | 1,802 B | unchanged |

Latency: autocannon 8.0.0 installed into a session scratchpad (never into the repo), 600 requests
per level — a fixed request count rather than a duration, because
`api/src/middleware/rate-limit.ts:89` caps one session identity at 1000 requests / 60 s in
development. Each level logged in fresh for its own bucket; `non2xx=0, errors=0` on every level, so
no 429 is hiding in these numbers. Percentiles come from per-response latencies on autocannon's
`response` event. A second `after` run put p95 @ c=25 at 55.5 ms and @ c=50 at 110.2 ms, so read
these as ±5%. The `before` column reproduces the audit baseline (its c=25 p95 was 94.5 ms, c=50 p95
182.0 ms), which is the reason to trust the `after` column.

**Where the ticket's estimate was wrong.** TRO-173 predicted ~2.6× payload shrink and p95 @ c=25
falling to 35-40 ms. Actual: 1.57× and 59 ms. The estimate applied content's **database** share
(64.5% of row bytes) to the **JSON** payload, but in the response body `content` was only 146,015 of
379,907 bytes — **38.4%**. The other 25 fields carry per-row overhead (UUIDs, ISO timestamps,
repeated key names) that dominates at 254 rows. The mechanism held exactly; the magnitude did not.
The largest remaining component is now `belongs_to` at 80,900 bytes (**33.5%** of the response) —
association objects carrying `title` for every program/project/sprint/parent. That is the next
payload win on this endpoint and it has no ticket.

**How to run it.**

```bash
source .factory-env                                   # api tests TRUNCATE 16 tables
pnpm --filter @ship/api test -- src/routes/issues.test.ts
pnpm type-check
pnpm --filter @ship/api openapi:generate              # should be a no-op diff
```

**Roll back.** `git revert` the commits on `fix/api-2-db-5-issues-payload`. By hand: put
`d.content,` back in the list SELECT, call `extractIssueFromRow` instead of
`extractIssueListItemFromRow` in the list handler, drop `listPaginationSchema` and the
`LIMIT`/`OFFSET` block, restore `z.array(IssueResponseSchema)` on the `/issues` 200 response, and
regenerate the spec. The five new cases in `api/src/routes/issues.test.ts` fail if the body comes
back or pagination stops being honoured.

**Not verified.** Only api-tier tests and this endpoint were exercised — no browser pass confirms
the issues list still renders correctly against the narrower payload (it should: the web `Issue`
interface at `web/src/hooks/useIssuesQuery.ts:25-48` never declared `content`, and no `.tsx` reads
it off an issue). `/api/issues/:id/children` still returns `content` for sub-issues; it has the
same shape of waste, bounded by children per issue, and was left alone deliberately rather than
widening this change.

**Found, not fixed.** `web/src/components/sidebars/ProjectContextSidebar.tsx:148` requests
`/api/issues?project_id=<id>`, but the list route never reads `project_id` — the parameter is
silently ignored and that sidebar receives every issue in the workspace. Pre-existing, unrelated to
these two findings, and worth its own ticket.

---

## TRO-174 — [API-3] No response compression anywhere; the largest list payload shipped 15× larger than needed

**What was broken.** `api/src/app.ts` never registered any compression middleware, and
`compression` was not a dependency of `api/package.json`. Every JSON response went out
uncompressed even when the client explicitly advertised `Accept-Encoding: gzip`. `GET /api/issues`
was the worst case at **379,907 bytes**. On a 10 Mbps agency link that body alone is ~304 ms of
transfer time, paid by every user on every list load. The gap is invisible in local development
and in the api-perf benchmark because loopback transfer is effectively free — it only costs users
on a real WAN link.

**What changed.** `compression` is registered as the first middleware in `createApp()`, ahead of
every route, so all response bodies pass through it: API JSON, the Swagger UI, and the static SPA
on single-origin deployments.

Settings, and why:

- **`threshold: 1024`** — the library default, written out explicitly to document it. Below roughly
  one MTU there is nothing to win; gzip framing plus the CPU makes a small body marginally larger
  and slower. `/health` (15 bytes) is correctly left alone.
- **Compression level: zlib's default (6), not 9.** Measured on the real 379,907-byte body, level 9
  yields 24,091 bytes against level 6's 25,050 — **3.8% smaller for materially more CPU per
  response**, on a path that runs on every list request. Note this means the honest ratio is
  **15.17×**, not the 15.4× the audit projected from `gzip -9`.
- **Filter delegates to `compression.filter`**, which consults `mime-db` and so already declines
  already-compressed types — the images, PDFs and archives served by `/api/files/:id` keep their own
  encoding rather than being wastefully re-compressed. Three additions on top:
  - the conventional `x-no-compression` request opt-out;
  - a `text/event-stream` guard. There is no SSE endpoint in this codebase today (verified by grep
    for `text/event-stream` and `flushHeaders`, 2026-07-29); the guard is there because compression
    buffers, which would silently stall the first SSE endpoint someone adds. Note mime-db would
    happily compress `text/*`, so this guard is doing real work rather than restating the default.
  - an `application/octet-stream` guard. mime-db reports octet-stream as **compressible**, but it is
    the "unknown binary" fallback, and the one route that emits it is `GET /api/files/:id`, which
    echoes a client-declared `mime_type` verbatim (`files.ts:309`) for an upload validated only
    against a filename extension blocklist (`files.ts:80-84` — any mime string is accepted).
    Speculatively gzipping an arbitrary, likely already-compressed user binary on every download
    costs CPU for no benefit.

  Both guards compare against a **lower-cased** media type. RFC 9110 §8.3.1 makes media types
  case-insensitive, so `Text/Event-Stream` and `Application/Octet-Stream` are legitimate headers.
  A case-sensitive comparison would defeat both guards silently, and for octet-stream the bypass
  would be **client-controlled** — the same client-declared `mime_type` that reaches
  `files.ts:309` would decide whether the guard applied to its own download. Caught in PR review;
  see the exclusion tests below.

  **`compression.filter`'s own mime-db lookup is already case-insensitive** — verified against a
  real server: `Application/JSON` and `APPLICATION/JSON` compress exactly as `application/json`
  does, `Image/PNG` and `Application/PDF` pass through exactly as their lower-case forms do, and
  a `; Charset=UTF-8` parameter changes nothing. **So normalisation belongs only in the two
  additions above — do not add it to the library path.** Recorded here because the natural
  "fix" for a case bug is to normalise everywhere, and here that would be wasted work.

  The Yjs collaboration WebSocket is unaffected — `ws` handles the upgrade off the HTTP response
  path, so this middleware never sees it.

  Filter behaviour was verified against a real HTTP server using the exact filter from `app.ts`,
  across 22 content types. Compressed: `application/json`, `text/html`, `application/javascript`,
  `text/css`, `text/csv`, `text/plain`, `application/xml`, `image/svg+xml`. Passed through:
  `image/png`, `image/jpeg`, `image/webp`, `application/pdf`, `application/zip`, `application/gzip`,
  `application/x-7z-compressed`, `video/mp4`, the four Office formats (docx/xlsx/doc/xls), plus the
  two guarded types above. **That 22-type matrix was run lower-case only, and is manual
  verification, not automated coverage** — mime-db's own behaviour is the library's business. The
  two guards this change adds are a different matter: they are safety guards with a client-reachable
  input, so they now have assertions (11 cases, mixed-case included) rather than a hand-run matrix.

**⚠️ DO NOT "DISPROVE" THIS FIX WITH A LOCALHOST BENCHMARK.** Enabling gzip does **not** reduce P95
over loopback and may raise it slightly. Localhost transfer time is ~0, so the only thing a local
benchmark can measure is the compression CPU that was added. A compare-mode `/api-perf-audit` run
against `audit-baseline` will therefore show this fix as **flat or marginally worse**, and that
result is not evidence against it. This is a bytes-on-the-wire fix: validate it by **payload size**,
or over a **bandwidth-shaped link**. This is standing rule 13 in the factory lessons, and it exists
because of this exact finding.

**Evidence — payload bytes, not loopback timing.** Local Express server (`tsx api/src/index.ts`,
port 3154, `NODE_ENV` unset i.e. development) against PostgreSQL 15 in Docker `ship-audit-pg` on
`:5433`, database `ship_wt_tro_174`, seeded with `pnpm db:seed` followed by `audit/seed-augment.ts`
to the volumes in `audit/shipshape.config.yaml` — 500 documents (254 of them issues) / 20 users.
Bytes counted by `curl -w '%{size_download}'`, which does not decompress when `Accept-Encoding` is
set by hand. The "before" column is the same server answering `Accept-Encoding: identity`; that is
byte-for-byte what the pre-fix code returned regardless of request headers, and it is independently
confirmed by the `x-no-compression` opt-out returning the identical 379,907.

| endpoint | before (identity) | after (gzip, level 6) | reduction |
|---|---|---|---|
| `GET /api/issues` | 379,907 B | **25,050 B** | **15.17× / −93.4%** |
| `GET /api/documents` | 293,822 B | **28,227 B** | 10.41× / −90.4% |
| `GET /api/openapi.json` | — | 18,039 B | compressed |
| `GET /health` (15 B) | 15 B | 15 B | under threshold, untouched |

The 379,907-byte "before" figure reproduces `audit/AUDIT_REPORT.md`'s number **exactly**, which
confirms the dataset here is byte-identical to the one the finding was measured against.

Transfer time at 10 Mbps is **derived arithmetic from those measured byte counts, not an observed
WAN measurement**: 379,907 B → ~304 ms, 25,050 B → ~20 ms, a saving of ~284 ms per issue-list load.

**Interaction with TRO-173/TRO-182 — do not double-count.** That branch removes `content` from the
`/api/issues` list projection, shrinking the same payload. Measured on the identity body from this
branch, the `content` field is **36.5%** of those 379,907 bytes. The two fixes compose, and the
honest attribution is:

| | identity | gzip level 6 | compression's own factor |
|---|---|---|---|
| this branch (`content` present) | 379,907 B | 25,050 B | **15.17×** |
| after TRO-173 (`content` stripped) | 241,338 B | 19,894 B | **12.13×** |

So compression alone is worth 15.17× today and still 12.13× once TRO-173 lands; the *combined*
379,907 → 19,894 is **19.10×** and belongs to both tickets, not to either one. Neither ticket
should claim it alone.

**CloudFront in the deployed stack — does it already do this?** Partly answered from config, and
the answer is "no, and the win is not double-counted" — but the deployed-stack half is **derived
from Terraform, not observed against the live distribution**.

*Observed in the repo:* the `/api/*` cache behaviour does set `compress = true`
(`terraform/s3-cloudfront.tf:154`, `terraform/modules/cloudfront-s3/main.tf:172`), and all three
environments (dev/prod/shadow) use `modules/cloudfront-s3`. But that behaviour attaches
`aws_cloudfront_cache_policy.api_no_cache`, whose
`parameters_in_cache_key_and_forwarded_to_origin` block sets `header_behavior = "none"` and sets
**neither `enable_accept_encoding_gzip` nor `enable_accept_encoding_brotli`** — a repo-wide grep for
`enable_accept_encoding` returns no matches at all.

*Derived from AWS's documented behaviour:* CloudFront automatic compression requires the attached
cache policy to enable Accept-Encoding gzip/Brotli support; with both unset (Terraform default
`false`), `compress = true` is inert. So `/api/*` was very likely **not** being compressed at the
edge, and the 15.17× measured here is a real production win rather than a re-count of something
CloudFront was already doing. The fix is also robust either way: the origin request policy uses
`header_behavior = "allViewerAndWhitelistCloudFront"`, so the viewer's `Accept-Encoding` does reach
Express, and CloudFront relays an origin response that already carries `Content-Encoding: gzip`
without re-compressing it.

*Unverified:* no `curl` was run against `https://ship.awsdev.treasury.gov` to observe an actual
`Content-Encoding` header on a deployed response. The deployed-stack claim above rests on config
plus documented behaviour only.

**Regression test.** `api/src/routes/compression.test.ts` — 17 cases, in a vitest file the gate
actually executes (an `e2e/*.spec.ts` would satisfy the gate's added-test grep while never running).

Three integration cases over the real app via supertest: `Content-Encoding: gzip` appears on
`/api/issues` when the client advertises gzip, does **not** appear when the client sends
`Accept-Encoding: identity`, and does not appear on a sub-threshold response. Each also asserts the
decoded body is intact, because a `Content-Encoding` header over a corrupted body would otherwise
read as a pass.

Fourteen unit cases over `isCompressionExcluded`, exported from `app.ts` as a test seam: both
guarded types in four case variants each, the `x-no-compression` opt-out, ordinary compressible
types (which must fall *through* to mime-db, so over-excluding would lose the whole fix), absent /
numeric / array `Content-Type` values, and three decoy-parameter cases (below).

**Review fix — media type must be matched by equality, not substring.** CodeRabbit's review of PR
#20 caught that the exclusion check compared the excluded media types against the **whole**
`Content-Type` header via `.includes()`, parameters and all. A value like
`text/plain; note="application/octet-stream"` is genuinely `text/plain` and should compress, but the
old check saw `application/octet-stream` inside the parameter text and wrongly excluded it —
matching the parameter, not the media type. Fixed by splitting on the first `;`, trimming, and
comparing the resulting media type by exact equality (mirrored per-element for array `Content-Type`
values, since Express can in principle return one). Three new cases cover it: a `text/plain` decoy
mentioning `application/octet-stream`, an `application/json` decoy mentioning `text/event-stream`,
and — the mirror case, so the fix isn't just "never exclude anything" — a genuine
`application/octet-stream` that also carries parameters, which must still be excluded. Confirmed red
first: against the substring-matching code, the two decoy cases failed with
`AssertionError: expected true to be false` (the decoy in the parameters was wrongly triggering
exclusion), while the genuine-octet-stream-with-parameters case already passed — proof the two new
assertions were exercising the actual bug and not some unrelated setup problem.

One deliberate design choice: the negative case additionally asserts the uncompressed
`Content-Length` **exceeds** the 1024-byte threshold, with an actionable failure message. If a
future payload reduction takes `/api/issues` under the threshold, the gzip assertion would start
passing for the wrong reason — nothing to compress rather than compression working. The test fails
loudly instead. The seeded payload is padded via long **titles**, not `content`, precisely so
TRO-173 removing `content` cannot make it vacuous.

Confirmed red first, twice. With the middleware absent the gzip case failed with
`AssertionError: expected undefined to be 'gzip'` at the `content-encoding` assertion — the right
reason, not an import or setup error — while the other two cases passed. Then the case-insensitivity
fix was driven the same way: against the case-sensitive comparison, exactly the six mixed-case
assertions failed with `AssertionError: expected false to be true` while all four lower-case cases
passed, which is what proves the refactor that introduced the seam changed no behaviour on its own.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database
pnpm --filter @ship/api exec vitest run src/routes/compression.test.ts

# Reproduce the payload measurement (NOT a latency benchmark — see the warning above).
pnpm --filter @ship/api db:seed && api/node_modules/.bin/tsx audit/seed-augment.ts
PORT=3154 api/node_modules/.bin/tsx api/src/index.ts &
# then, with a valid session cookie for a seeded user:
curl -s -o /dev/null -H "Cookie: session_id=$SID" -H 'Accept-Encoding: identity' \
  http://localhost:3154/api/issues -w 'identity=%{size_download}\n'
curl -s -o /dev/null -H "Cookie: session_id=$SID" -H 'Accept-Encoding: gzip' \
  http://localhost:3154/api/issues -w 'gzip=%{size_download}\n'
```

Setting `Accept-Encoding` by hand matters: `curl --compressed` would decompress transparently and
report the identity size for both, hiding the entire effect.

**Rollback.** Delete the `app.use(compression({...}))` block and the `import compression` line from
`api/src/app.ts`; optionally drop `compression` and `@types/compression` from `api/package.json`.
Deleting `api/src/routes/compression.test.ts` reverts the test. No schema, route, or API-contract
change; nothing to migrate.

**Found, not fixed.** The inert `compress = true` on the `/api/*` CloudFront behaviour is a latent
config inconsistency worth its own ticket: enabling `enable_accept_encoding_gzip` on the
`api_no_cache` cache policy would make the edge setting mean what it appears to mean. It is a
Terraform change, out of scope here, and origin-side compression is the more robust fix anyway
because it also covers single-origin deployments and direct-to-Elastic-Beanstalk access, which do
not pass through CloudFront at all.

---

## TRO-224 — [TEST-2] 68 e2e tests could pass without executing a single assertion

**What was broken.** A brace-scan of 866 static test blocks found **3 tests with no `expect()` at
all** and **65 whose every `expect()` sat inside a conditional** — 7.9% of the suite reporting
success while observing nothing (`audit/test-quality/runs/e2e-vacuous-tests.txt`). Two of them were
the only automated coverage of a security control:

- `security.spec.ts:217` *XSS via data: URI in links* typed `[Click](data:text/html,…)` into a new
  document, then looped over `editor.locator('a')` asserting only inside
  `if (href?.startsWith('data:'))`. **TipTap ships no markdown-link input rule**, so the typed text
  stayed literal, zero `<a>` elements existed, and the loop body never ran. Its sibling *XSS via
  markdown link injection* (`:197`) had the same hole without the `if`. Neither could tell "the app
  sanitised the URI" from "the app rendered nothing" — and the truth was the latter, for the whole
  life of both tests.
- `authorization.spec.ts:299` *workspace member cannot view workspace audit logs* buried
  `expect(response.status()).toBe(403)` inside `if (wsResponse.status() === 200)` inside
  `if (workspaceId)`. Any hiccup fetching `/api/workspaces/current` skipped the entire authorization
  check silently.

The guards had been added to stop tests failing on missing seed data — the same failure mode
`.claude/CLAUDE.md` already forbids for `test.skip()`. The rule was written for `test.skip()` and
never extended to `if`, so the practice migrated instead of stopping.

**What changed.** Nine vacuous tests rewritten, three new tests added, and — because
`gate.sh` runs neither vitest project over `e2e/` — the two security properties were **also** pinned
in tiers the gate executes.

*Security, non-negotiable (both proven red-first — see Evidence):*

- `web/src/components/editor/linkOptions.ts` **(new)** — the app's link-href policy, named and
  exported: `protocols: []` plus an explicit `isAllowedUri` that denies
  `javascript`/`data`/`vbscript`/`file`/`blob` after `defaultValidate`. Behaviourally a **no-op
  today**: `@tiptap/extension-link` 2.27.2 already rejects all five in its default `isAllowedUri`
  and strips the `href` during `renderHTML`. The point is that the protection was *inherited
  silently* — adding a scheme to `protocols`, or overriding `isAllowedUri`, would have removed it
  with no test failing anywhere. Wired into `web/src/components/Editor.tsx:588` and all three
  `Link.configure` calls in `web/src/components/StandupFeed.tsx`.
- `web/src/components/editor/linkOptions.test.ts` **(new, 27 cases, runs in the gate)** — content
  loaded as TipTap **JSON**, which is the stored-XSS path (`Mark.fromJSON` does not run
  `parseHTML`'s href guard). Asserts a benign `https` href survives *and* that
  `javascript:` / `data:text/html` / `data:image/svg+xml` do not, plus scheme-obfuscation cases
  (`jav\tascript:`, `java\nscript:`, `j a v a s c r i p t:`).
- `api/src/routes/workspaces.test.ts` — three cases added beside the existing member→403 check: the
  403 body must not carry `"logs"`, an unauthenticated request is refused, and a member is refused
  the audit log of a workspace they are not a member of.
- `e2e/security.spec.ts` — the two link tests are replaced by *stored dangerous link hrefs are not
  rendered live*, which opens a seeded document whose `content` already holds link marks with
  dangerous hrefs and asserts unconditionally; plus *markdown link syntax does not create a link at
  all*, which pins the fact the old tests were unknowingly relying on, so that adding a
  markdown-link input rule later fails loudly instead of silently re-opening the vector.
- `e2e/authorization.spec.ts` — every precondition is its own assertion with an actionable message,
  so a setup failure now fails *as a setup failure*; plus a companion test for a foreign workspace's
  audit log.

*The rest, working outward from security:*

| file | test | was |
|---|---|---|
| `e2e/file-attachments.spec.ts:161` | should validate file type | **0 `expect()`** — uploaded a `.exe`, slept 1 s, listed three acceptable outcomes in a comment. Now asserts the blocked-file dialog fired, that **no request reached `/api/files`** (the bytes never leave the browser), and that no attachment node was inserted. |
| `e2e/file-attachments.spec.ts:422` | should block dangerous executable files (.exe) | assertions lived *inside* `page.on('dialog')`, so they never ran if the dialog never fired. Messages are collected and asserted outside the handler. |
| `e2e/check-aria.spec.ts` | check aria-expanded elements | **0 `expect()`** — a diagnostic script with 19 `console.log`s and `return`-on-missing-data. Now asserts the A11Y-1 contract: `aria-expanded` sits on a real `<button>`, is named, and (new second test) tracks the children and survives navigating into one. |
| `e2e/accessibility-remediation.spec.ts:1398` | code blocks have language indication | **0 `expect()`** — ran on `/docs`, which renders no code block, and discarded the computed result. Now opens a seeded document with one code block and asserts count **and** language. |
| `e2e/admin-workspace-members.spec.ts:87` | can change member role | whole body inside `if (await roleSelect.isVisible())`. Now asserts the seeded member row exists, and reloads to prove the PATCH reached the server rather than only moving a local `<select>`. |

**Fixture work, never a conditional skip.** `e2e/fixtures/isolated-env.ts` gains
`seedRenderingFixtures()`: a *Link Sanitization Fixture* document (one benign control href + three
dangerous ones stored as link marks) and a *Code Block Fixture* document (one code block with
`language: 'javascript'`). Both are seeded at `position` 90/91 so they sort last and never become
the document `/docs` auto-opens. Titles and hrefs are exported as constants so a rename cannot
orphan a spec. `e2e/fixtures/test-helpers.ts` gains `openFixtureDocument(page, title)`, which
resolves the id through `GET /api/documents` and asserts the fixture exists with an actionable
message.

**The positive control is the mechanism.** Every rewritten test that inspects rendered elements now
asserts *first* that the thing it will inspect is present. Without that, "the page rendered nothing"
is indistinguishable from "the check passed", which is exactly what 68 tests were doing.

**Evidence.** Red-before-green, both security properties, under `pnpm --filter @ship/{web,api} exec
vitest run <file>` against the branch's own worktree database
(`postgresql://…@localhost:5433/ship_wt_tro_224`):

| deliberate break | result |
|---|---|
| `linkOptions.ts` → `isAllowedUri: () => true` + `protocols: ['javascript','data']` | **4 failed / 23 passed.** `AssertionError: javascript: must not survive into a rendered href`, same for `data:text/html` and `data:image/svg+xml`, plus `"javascript" must never be an allowed link protocol`. The benign-control case stayed **green**, which is what shows the failure is the vulnerability and not a broken test. |
| `workspaces.ts:1021` → `workspaceAdminMiddleware` removed from `GET /:id/audit-logs` | **3 failed / 25 passed**, each `expected 200 to be 403`. Includes the foreign-workspace case, i.e. without the middleware the handler itself does no scoping. |
| both reverted | 27/27 and 28/28 pass. |

**Gate result, and how it got there.** Before this branch merged `main`, `scripts/factory/gate.sh`
reported `tests:not-weakened FAIL — 6 removed test/assertion line(s)`. That check counted removed
`expect(` lines with no comparison to added ones, so it could not distinguish deleting an assertion
from *replacing a vacuous one*. All six removed lines were the vacuous assertions this ticket exists
to delete:

```
e2e/authorization.spec.ts    expect(response.status()).toBe(403)        # was inside two nested ifs
e2e/file-attachments.spec.ts expect(dialog.message()).toContain('.exe')      # was inside page.on('dialog')
e2e/file-attachments.spec.ts expect(dialog.message()).toContain('blocked')   # was inside page.on('dialog')
e2e/security.spec.ts         expect(href).not.toContain('javascript:')       # was inside a loop over 0 elements
e2e/security.spec.ts         expect(href).not.toContain('text/html')         # was inside `if (href?.startsWith('data:'))`
e2e/security.spec.ts         expect(href).not.toContain('<script')           # was inside `if (href?.startsWith('data:'))`
```

Each is replaced by a stronger unconditional assertion in the same test; `regression-test` reports 13
added cases. After merging `main` (`86b5231`), `gate.sh`'s G5 had independently been changed to a net
comparison of removed vs. added test lines — motivated by this exact false-positive class on other
tickets (TRO-223, TRO-179) — and now reports `tests:not-weakened PASS — -6 / +51 test line(s) — net
gain, reviewer should confirm the removals are corrections`. No edit to `gate.sh` was made on this
branch; the fix landed on `main` independently and this entry is corrected to match the gate this PR
actually merges against. Every other gate is green, including `review-patterns` (G7b, also new from
`main`) and both vitest projects.

Three separate gate runs have each failed `tests:api` on a *different* untouched test
(`backlinks.test.ts`, `rate-limit.test.ts`, then `weeks.test.ts`'s "should reject review approval
without rating"); all three pass standalone and the full api suite is 472/472 each time — that is
TRO-277's load-sensitive flake (documented to appear under CPU load, right after `type-check` +
`build`), not this branch.

**Attempted, then reverted — and it found two bugs.** `e2e/ai-analysis-api.spec.ts:209`
*"POST /api/ai/analyze-plan returns 429 after 10 rapid requests"* guards its assertions with
`if (!allSucceeded)`, so the single outcome it exists to catch — the limiter doing nothing — is the
one outcome it excuses. Making the assertion unconditional produced, **observed**,
`Got: 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200` — eleven admissions, no `429`. Two
findings fall out, neither of them a test bug:

1. **The test's premise is false.** `api/src/services/ai-analysis.ts:39` sets `RATE_LIMIT = 120`
   per hour, not 10. Eleven requests cannot trip it, and never could.
2. **The user is told the wrong number.** `api/src/routes/ai.ts:34` returns *"Rate limit exceeded.
   Max 10 analysis requests per hour."* while 120 is enforced. Whoever hits the ceiling is given a
   figure off by 12×.

The file is reverted to its original state. Asserting truthfully would need 121 requests — 120 of
which each attempt a Bedrock call and would likely blow the 60 s test timeout — or making the limit
injectable, which is a production change to enable a test. Neither belongs in a test-integrity
ticket. The 10-vs-120 inconsistency needs its own ticket; the vacuous guard stays on the TEST-2 list
until it does.

**Not done, deliberately.** 60 of the 68 remain. `program-mode-week-ux.spec.ts` alone holds 33
(sprint-filter and quick-menu UX, no security content); `accessibility-remediation.spec.ts` has 6
more, `context-menus.spec.ts` 6, `features-real.spec.ts` 5, `performance.spec.ts` 2, and
`ai-analysis-api.spec.ts` keeps 1 (see above), and
`admin-workspace-members.spec.ts` keeps 2 (`selecting user from search…`, `can add existing user…`)
which are guarded on a **"test space" workspace and a "carol" user that the isolated fixture does
not create** — converting those guards needs a second seeded workspace and more users, which risks
the workspace-switcher and admin-dashboard specs and belongs in its own ticket. See TRO-225's entry
for the retries decision.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database

# The tiers the factory gate actually executes
pnpm --filter @ship/web exec vitest run src/components/editor/linkOptions.test.ts   # 27 pass
pnpm --filter @ship/api exec vitest run src/routes/workspaces.test.ts               # 28 pass

# The e2e specs, targeted. Never the whole suite: 600+ tests, per-worker containers.
pnpm exec playwright test e2e/security.spec.ts       --workers=1 --retries=0        # 18 pass
pnpm exec playwright test e2e/authorization.spec.ts  --workers=2 --retries=0        # 18 pass
pnpm exec playwright test e2e/file-attachments.spec.ts --workers=2 --retries=0      # 13 pass
pnpm exec playwright test e2e/check-aria.spec.ts e2e/admin-workspace-members.spec.ts --workers=2 --retries=0
pnpm exec playwright test e2e/accessibility-remediation.spec.ts --workers=2 --retries=0 \
  -g "code blocks have language indication"                                          # 1 pass
```

To see the security tests fail, reintroduce the vulnerability: set
`isAllowedUri: () => true` in `web/src/components/editor/linkOptions.ts`, or drop
`workspaceAdminMiddleware` from `api/src/routes/workspaces.ts:1021`.

**Rollback.** `git revert` the branch. The only production code touched is the new
`linkOptions.ts` and the four `Link.configure` call sites that spread it; reverting restores
reliance on `@tiptap/extension-link`'s default `isAllowedUri`, which blocks the same five schemes
today.

---

## TRO-225 — [TEST-3] Retries hid a test that failed first-attempt in 100% of runs

**What was broken.** `playwright.config.ts:60` sets `retries: process.env.CI ? 2 : 1`. Across three
identical 869-test runs, counting **first attempts only**, 8 / 5 / 3 tests failed; after retries the
runner reported 1 / 0 / 1. Retries erased 7 / 5 / 2 failures
(`audit/test-quality/runs/e2e-flake-union.txt`). The worst case,
`my-week-stale-data.spec.ts › retro edits are visible on /my-week after navigating back`, **failed or
timed out on the first attempt in all three runs and was reported as passing all three times.**

**The recorded diagnosis was wrong.** That spec's header blamed Yjs persistence timing — "the retro
document IS created … but its Yjs content isn't persisted … even with a 10s wait … Needs
investigation on a separate branch." Two runs settle it (observed, `--workers=1 --retries=0`, this
worktree):

| invocation | result |
|---|---|
| `playwright test e2e/my-week-stale-data.spec.ts` | plan **passes**, retro **fails** — `getByText('Completed the API refactoring')` never appears |
| `playwright test e2e/my-week-stale-data.spec.ts -g "retro edits"` | retro **passes** (22.5 s) |

The retro test does not fail on its own merits. It fails **because the plan test ran first in the
same worker's database** — the "shared state inside a worker's database" root cause the finding
names, demonstrated rather than inferred.

**Mechanism** (read from the code, consistent with the above). When a weekly plan already exists for
the same person+week, `POST /api/weekly-retros` (`api/src/routes/weekly-plans.ts:641-656`) swaps
`WEEKLY_RETRO_TEMPLATE` for `buildRetroTemplateWithPlanItems(...)`: heading, then a `planReference`
node plus an empty `paragraph` per plan item, then an "Unplanned work" heading and a 3-item bullet
list. The old test clicked the editor's **centre**, so in that taller document the caret landed in a
top-level paragraph rather than inside a list item — and `extractPlanItems`
(`api/src/routes/dashboard.ts:279-309`) collects only `listItem`/`taskItem` text. The typed line
never reached the `/my-week` card. The failure screenshot confirms it: the retro card renders as a
**link** to a real document (so the document exists) whose body still reads "+ Create retro for this
week" (so `items` is empty).

**What changed** in `e2e/my-week-stale-data.spec.ts`:

1. **The cross-test dependency is gone.** `typeIntoFirstListItem()` places the caret in the first
   empty list item explicitly, so the typed text lands in the node type `/my-week` reads whichever
   template the API produced. Both tests use it.
2. **The fixed sleep is gone.** `await page.waitForTimeout(3000)` — a guess at how long persistence
   takes, and the second root-cause smell the finding lists — is replaced by
   `waitForMyWeekToContain()`, which polls `GET /api/dashboard/my-week` until the item is actually
   readable. This also *localises* the failure: a genuine persistence problem now fails at the poll
   with the API's own payload in the message, not 15 s later at a DOM assertion.
3. **Assertions are scoped to their card.** `myWeekSection(page, 'Weekly Retro')` prevents the retro
   assertion from being satisfied by the plan card.
4. The misleading "KNOWN FLAKY / needs investigation" header is replaced by the two-run evidence
   above.

**Decision on `retries`: left at `CI ? 2 : 1`, and here is why.** This branch fixed **1 of the 11**
tests on the flake list. Lowering retries — or setting `failOnFlakyTests: true`, which is the better
end state because it keeps the retry's trace artifact while refusing to score a retry-rescued test
as a pass — would immediately turn a misleadingly-green suite into a permanently-red one with ten
root causes still outstanding, and a permanently-red suite gets ignored exactly as fast as a
falsely-green one. It is a one-line change that costs nothing to defer and belongs with the *last*
flake fix, not the first. What has changed is that the choice is no longer invisible:
`playwright.config.ts` now carries the 8/5/3-vs-1/0/1 measurement, the pointer to
`e2e-flake-union.txt`, and the exact switch to flip. **No claim is made that the other ten flakes
are fixed.** They are:

`inline-comments.spec.ts › canceling a comment removes the highlight` (failed final in 2 of 3 runs —
the strongest remaining candidate), `mentions.spec.ts › should sync mentions between collaborators`,
`weekly-accountability.spec.ts › Allocation grid shows person with assigned issues…`,
`bulk-selection.spec.ts › shift+down then shift+up contracts selection`,
`my-week-stale-data.spec.ts › plan edits…` (flaky once; its fixed sleep is removed here too),
`performance.spec.ts › many images do not crash the editor`,
`programs.spec.ts › program cards show emoji or initial badges`,
`project-weeks.spec.ts › project link in Properties sidebar navigates back to project`,
`status-overview-heatmap.spec.ts › displays split cells for plan/retro status`,
`team-mode.spec.ts › clicking collapsed header expands the group`.

**Second finding, and the more serious one: the editor sometimes never receives a new document's
content.** Once the test asserted that the template had *arrived* — rather than typing into whatever
happened to be on screen — it began failing for an entirely different reason. **Observed**, three
repeat runs at `--workers=1 --retries=0`: run 1 clean, run 2 the *plan* document opened blank, run 3
the *retro* document opened blank. To a user that is a brand-new weekly plan opening as an empty
editor instead of the template.

**Derived** from code reading, not instrumented: `getOrCreateDoc`
(`api/src/collaboration/index.ts:220-226`) publishes the new `Y.Doc` into the shared `docs` map
*before* awaiting the database read and the `jsonToYjs` conversion at `:231-266`, and registers the
broadcasting `doc.on('update')` handler only afterwards. A second connection for the same document
arriving inside that window is handed the empty doc, is sent `writeSyncStep1` from it, and never
receives the conversion update — and `freshFromJsonDocs.delete(docName)` after the first client means
it does not get the cache-clear signal either. The shape of the fix is to store the load *promise* in
the map so concurrent callers await the same load. Needs its own ticket.

This also explains the **other** my-week entry on the flake list (`plan edits are visible on /my-week
…`, flaky in 1 of 3 audit runs), which the plan/retro template coupling does not — and it is very
probably what the original file header was reaching for when it blamed "Yjs persistence".

Until it is fixed, `typeIntoTemplateList` tolerates it with **one bounded reload** (`toPass`, the
construct `e2e/AGENTS.md` sanctions) and a failure message that names the finding and the file:line.
That is a workaround in the *setup* phase of a test whose subject is something else; it is not a
guard, because the assertion still has to pass, and it is not silent.

**Third finding, reported not fixed.** `extractPlanItems` exists in three copies with **divergent**
behaviour: `api/src/routes/dashboard.ts:279-309` collects only `listItem`/`taskItem`, while
`api/src/routes/weekly-plans.ts:63-95` and `api/src/services/ai-analysis.ts:69` also collect
top-level paragraphs longer than 10 characters. Consequence for a real user: an auto-populated retro
puts an empty `paragraph` under each `planReference` block *specifically so you write your update
there* — and `/my-week` then shows an **empty retro card**, because the dashboard reader ignores
paragraphs. That is a product bug, not a test bug; fixing it changes what `/my-week` displays, which
is out of scope for a test-integrity ticket. Needs its own ticket.

**Evidence.** Targeted specs only — the full suite was not run (600+ tests, per-worker containers,
not in the gate). Commands and results are in the PR body / final report; the decisive pair is the
two-run table above.

**How to run it.**

```bash
source .factory-env

# The configuration that reproduced the deterministic failure. 4 consecutive clean runs
# after the fix; before it, the retro test failed every time this way.
pnpm exec playwright test e2e/my-week-stale-data.spec.ts --workers=1 --retries=0

# The two-run experiment that identified the cross-test dependency (run against `main`):
pnpm exec playwright test e2e/my-week-stale-data.spec.ts --workers=1 --retries=0
pnpm exec playwright test e2e/my-week-stale-data.spec.ts --workers=1 --retries=0 -g "retro edits"
```

**Rollback.** `git revert` the branch. `playwright.config.ts` changes are comment-only, so reverting
restores the previous behaviour exactly.

---

## TRO-217 — [A11Y-3] `/my-week` failed colour contrast, the landing page of the app

**What was broken.** `/` redirects to `/my-week`, and it was the only key page Lighthouse failed on
accessibility: **95**, one failing audit, `color-contrast`. axe reported it **Serious** on 18 nodes
(24 in the audit baseline; the count tracks how many future standup rows the current week still
has, so it moves with the weekday).

The finding named two causes. There were **three**, and one of the two named was misattributed:

| Cause | Nodes | Resolved colour | Ratio |
|---|---|---|---|
| `opacity-40` on future standup rows (`MyWeekPage.tsx:339`) | 12 | `#3f3f3f` on `#0d0d0d` | **1.84:1** |
| `text-muted/50` on the 11px plan/retro ordinals | 4 | `#4c4c4c` on `#0d0d0d` | **2.26:1** |
| `text-accent` used as a *foreground* colour | 2 | `#005ea2` on `#0a1d2b` / `#0c1114` | **2.55:1** / 2.82:1 |

The dominant cause — two thirds of the nodes — was `opacity-40`, which the finding never mentioned.
And `bg-accent/20`, which the finding did blame, is not the defect: `accent` (`#005ea2`) is
**2.89:1 as text on the page background before any badge is involved**; the translucent fill only
takes it from 2.89 to 2.55. The fill was fine. Using a fill colour as text was not.

A **fourth** pair, in neither the finding nor either axe run: the "Unsubmitted" badge puts
`text-muted` on a `bg-border` fill at **4.38:1**. It renders only when a plan or retro has content,
is unsubmitted, and is not yet due — a state neither scan happened to hit. It is not a guess: axe
recorded that identical pair on the command palette's `esc` key
(`audit/a11y/axe/command_palette_open.json`).

**What changed.**

- `web/tailwind.config.js` — added `accent-text: #2491ff` (USWDS blue-40v, verified against
  `@uswds/uswds/.../tokens/color/_blue.scss`): **6.08:1** on `background`, 5.37:1 on a
  `bg-accent/20` badge, 5.94:1 on `bg-accent/5`. `accent` itself is **unchanged**, so every
  `bg-accent` fill in the app looks exactly as it did. blue-50v (`#0076d6`) was tried and rejected —
  4.22:1, still failing. Also corrected the `muted` comment, which claimed 5.1:1 where the
  arithmetic gives 5.63:1, and recorded the `bg-border` caveat next to it.
- `web/src/pages/MyWeekPage.tsx` — `opacity-40` removed from future rows in favour of a dimmer
  border; `text-muted/50` → `text-muted` on the two ordinals; `text-accent` → `text-accent-text` on
  the "Current" badge and today's day label; `text-muted` → `text-foreground` on the two
  "Unsubmitted" badges.

**Why the levels differ, since a global token change was the obvious move.**

- `opacity-40` was **page-level** because `MyWeekPage.tsx:339` was its *only* occurrence in
  `web/src`. Nothing else could be affected.
- `text-muted/50` was **page-level** because 10 of its 12 occurrences are on other pages
  (`PlanQualityBanner`, `DashboardVariantC` at `/dashboard`, `WorkspaceSettings`,
  `AdminWorkspaceDetail`, `Programs`, `MergeProgramDialog`, `HypothesisBlockComponent`). They fail
  too — 2.26:1 is a property of the token pair, not of this page — but they are outside A11Y-3 and
  are filed as a follow-up rather than swept in silently.
- `accent-text` was added at **token level** but applied only here. Adding a token cannot regress a
  page that currently passes; mutating `accent` could, because `accent` is a fill under white text
  in 80 places across 45 files. That mutation is a visual-identity decision, not a contrast fix.

**The tradeoff, stated because it is visible.** Future standup rows are no longer ghosted. They now
read as ordinary muted rows, distinguished by a dimmer border, the italic "Upcoming" label and the
absent status dot. This was not avoidable by tuning the opacity value: `text-muted` only clears
4.5:1 above roughly **86%** opacity, at which point nothing looks dimmed at all. Likewise the
ordinals lost their extra-quiet tier — on `#0d0d0d`, AA bottoms out around `#7a7a7a`, a 16-step
band below `muted`, so a perceptibly quieter *compliant* grey does not exist on this background.
Contrast won, as the ticket directed.

**Evidence.** Both ends measured on this branch, same conditions, not inherited from the audit:
`http://localhost:5683`, Chrome for Testing headless, 1440×900, `--preset=desktop`,
`--only-categories=accessibility`, authenticated as `dev@ship.local`, 523 seeded documents,
`ship_wt_tro_217`. Flags identical to `audit/a11y/run-lighthouse.sh` and `audit/a11y/axe-scan.mjs`.

| Measurement on `/my-week` | Before | After |
|---|---|---|
| Lighthouse accessibility | **95** | **100** |
| Lighthouse failing audits | 1 (`color-contrast`, 18 items) | **0** |
| axe `color-contrast` nodes | **18 Serious** | **0** |
| axe all severities | C0 **S1** M0 m0 | C0 S0 M0 m0 |

The audit baseline recorded 24 nodes and the ticket said 25; **18** is what the same page produced
here. The gap is the weekday (four remaining future days instead of six), not a different defect —
the per-node causes and ratios match the baseline artifact exactly.

**Regression test.** `web/src/pages/MyWeekPage.contrast.test.tsx` resolves the effective foreground
and background *colours* out of the rendered DOM and asserts the WCAG ratio, rather than asserting
a class string — so it survives a markup refactor and fails if a palette hex drifts back under
4.5:1. It renders four data states, because three of the page's pairs only exist under specific
data; a single-state check would have declared the page fixed while the 4.38:1 badge sat behind a
common plan state. `web/src/lib/contrast.test.ts` pins the resolver against numbers this project
did not compute — the exact `fgColor`/`bgColor`/`contrastRatio` values axe recorded in
`audit/a11y/axe/`.

Confirmed red first on the unfixed page: 6 failures, every one an `AssertionError` on the ratio
(21 of 39 pairs below 4.5:1 in the first state; named failures at 2.26:1, 1.85:1, 2.82:1, 4.38:1).
No import or locator errors.

**How to run it.**

```bash
pnpm --filter @ship/web test        # 24 new tests; 13 known failures are TEST-1/TRO-223, unchanged
pnpm --filter @ship/web type-check
```

To re-measure against a browser, start the worktree's API and Vite, log in for a fresh
`session_id` (sessions expire in 15 minutes), then run Lighthouse and axe with the flags above.

**Roll back.** `git revert` the commits on `fix/a11y-3-contrast`, or by hand: restore `opacity-40`
on the future-row branch of `rowClass`, put back `text-muted/50` on the two ordinals,
`text-accent` on the "Current" badge and today's day label, `text-muted` on the two "Unsubmitted"
badges, and drop `accent-text` from the palette. The two new spec files fail if any of it comes
back, which is the point.

**Not established.** That a low-vision user can now read the page. Contrast ratios and axe output
are measured; the user-facing benefit is *derived* from them, and no human with low vision has
looked at this build. Also not established: that the repo's three Playwright a11y specs still pass
— they are not run by the factory gate and were not run here. One of them,
`e2e/accessibility-remediation.spec.ts:738` ("no color contrast violations on main pages"), runs
axe right after login, which lands on `/my-week`; it was almost certainly failing before this
change and should now pass, but that is a prediction, not a result.

**Found and not fixed** (filed as follow-ups, all measured):

1. `text-muted` on a `bg-border` fill is **4.38:1** and co-occurs in ~109 places in `web/src`.
   Raising `muted` from `#8a8a8a` to `#929292` (4.86:1 on `#262626`, 6.25:1 on `#0d0d0d`) fixes the
   whole class in one line and cannot lower contrast on any dark surface. Out of scope here because
   it is an app-wide tone change driven by pairs outside this page.
2. `text-accent` is **2.89:1** as small text on the page background wherever it renders — 80
   occurrences in 45 files. Only the two on `/my-week` were observed failing by axe; the rest is
   computed from the token, so treat the count as derived. `accent-text` now exists for them.
3. `bg-surface` is used in three files including `MyWeekPage.tsx`, but `surface` is **not a palette
   token**, so the class generates no CSS and those "cards" are painted with the page background.
   Harmless today; it silently changes the contrast maths for anything inside them if `surface` is
   ever defined.
4. `getContrastTextColor` in `web/src/lib/cn.ts` carries a second copy of the WCAG luminance
   formula now also in `web/src/lib/contrast.ts`. Collapsing them changes a shipped helper's
   behaviour on malformed input, so it was left alone.
5. `pnpm db:migrate` stopped after `010_oauth_state.sql` on a partially-migrated database and still
   reported success, leaving 10 of 42 migrations applied — the swallowed `already exists` catch at
   `api/src/db/migrate.ts:103-110`. This is **DB-1** reproducing; worked around by cloning a
   fully-migrated database rather than by touching the runner.

---

## TRO-215 — [A11Y-1] Navigation sidebars claimed `role="tree"` without a tree keyboard model

**What was broken.** `web/src/pages/App.tsx:637` declared
`<ul role="tree" aria-label="Workspace documents">`, which tells assistive technology "this is a
composite widget, enter interaction mode and navigate with arrow keys." Nothing implemented that
contract: no roving `tabIndex`, no `onKeyDown`, no `aria-level`/`aria-setsize`/`aria-posinset`
anywhere in `DocumentTreeItem.tsx` or `App.tsx`. The same pattern appeared in four more places.
Because `role="tree"` also overrides the `<ul>`'s list role, the two bare `<li>` children of that
list — the empty state and the "N more..." overflow link — became roleless orphans, producing axe
**Critical `aria-required-children`** plus **Serious `listitem`**.

**What changed.** Subtraction. `role="tree"`, `role="treeitem"` and `role="group"` are gone from
the document/context/project navigation sidebars, along with `aria-expanded`/`aria-selected` on
the `<li>` elements. The native `<ul>`/`<li>`/`<a>` structure is unchanged and needs no ARIA.

- `web/src/pages/App.tsx` — workspace + private document lists, the local `DocumentTreeItem`, and
  the projects list. `DocumentsTree` is now exported as a unit-test seam.
- `web/src/components/DocumentTreeItem.tsx` — the shared item used by the /docs tree view.
- `web/src/pages/Documents.tsx` — the container for the above; it had to move with the items,
  because a `role="tree"` whose children stop being treeitems is a *new* Critical.
- `web/src/components/ContextTreeNav.tsx`, `web/src/components/sidebars/ProjectContextSidebar.tsx`.

State that used to live on the `<li>` moved to where it is valid ARIA: `aria-expanded` is now on
the expand/collapse `<button>`s, and the active document was already marked with
`aria-current="page"` on its `<a>`.

**One behaviour change, from PR review.** Moving `aria-expanded` onto the buttons exposed that the
person row in `ProjectContextSidebar` was a `<button aria-expanded="false">` even for a person with
**no weeks** — controlling nothing, and with a provably no-op click (`togglePerson` writes
`expandedPeople`, read only by `isExpanded && hasWeeks`). That row is now a plain `<div>`: still
readable, no longer a phantom tab stop. People *with* weeks are unchanged — chevron, week count,
working `aria-expanded`. Reverting restores the focusable no-op button.

**Deliberately kept.** `aria-live="polite"` on the two document lists. It is the WCAG 4.1.3
mechanism for announcing create/delete and is asserted by
`e2e/accessibility-remediation.spec.ts` ("document tree updates are announced"). Whether it is
too verbose on expand/collapse is a screen-reader question, and removing it on a prediction is
the exact error A11Y-1 itself was — see the follow-up note below.

**Out of scope, deliberately.** `web/src/pages/OrgChartPage.tsx` keeps `role="tree"`: it is the
one real tree widget in the codebase (roving `tabIndex` at `:664`, `onKeyDown` at `:462`).

**Evidence.** axe-core 4.11 via `@axe-core/playwright`, Chromium 1223 headless, 1440×900, tags
`wcag2a,wcag2aa,wcag21a,wcag21aa,best-practice`, logged in as `dev@ship.local` against a locally
seeded database. Counts are Critical/Serious/Moderate/minor.

| page | before | after |
|---|---|---|
| `/docs` | **C1 S1** M0 m0 — `aria-required-children`, `listitem` | **C0 S0** M0 m0 |
| `/documents/:id` | **C2 S1** M1 m0 | **C1 S0** M1 m0 |
| `/issues` | C0 S0 M0 m1 | C0 S0 M0 m1 |

The Critical remaining on the document view is `aria-allowed-attr` on the editor `<div>` — that is
**A11Y-2**, a separate finding, untouched here.

**Reproduction precondition (worth knowing).** The violation is data-dependent: it only fires when
a sidebar section has **more than `SIDEBAR_ITEM_LIMIT` (10)** root documents, which renders the
bare `<li>` "N more..." overflow link, or **zero**, which renders the bare `<li>` empty state. A
freshly seeded database has 5 and shows **no** violation. The audit environment had more than 10.

**How to run it.**

```bash
pnpm --filter @ship/web test        # 5 new specs, 26 assertions, all green
pnpm type-check
```

**Rollback.** `git revert` the commits on `fix/a11y-1-sidebar-aria`, or by hand: restore the five
`role="tree"`/`role="treeitem"` sites listed above, and restore the person row in
`ProjectContextSidebar.tsx` to a single `<button>` for both the has-weeks and no-weeks cases. The
five new `*.test.tsx` files fail if either comes back, which is the point.

**Still owed — do not mark this fully verified.** Nobody has listened to it. A human found on
2026-07-28 that VoiceOver did not announce the document titles *at all* under the old markup;
this change makes the DOM use native list semantics and axe agrees, but **no screen-reader pass
has been run on the fixed build.** That verification, plus a judgement on the retained
`aria-live`, is outstanding.

---

## TRO-188 (ERR-1) + TRO-189 (ERR-2) — the editor stops lying about "Saved", and a revoked session stops writing

Both findings live in the collaboration path and ship as one change: TRO-189 makes the server hang
up on sockets whose session is gone, and TRO-188 makes the editor say so instead of showing
"Saved" over work that is not saved. Fixing one without the other would have produced a *silently*
disconnected editor — a worse version of ERR-1.

**What changed — TRO-189 / ERR-2 (security: logged-out user kept write access).**

The collaboration socket was authenticated exactly once, during the HTTP upgrade
(`api/src/collaboration/index.ts`, `server.on('upgrade')`), and never re-checked. Deleting or
expiring the session left the socket writing to `documents` indefinitely while REST correctly 401'd
(audit `probe7c`, `probe6.4`).

- Each connection now records the `sessionId` that authorized it (`DocConnection` / `EventConnection`).
- `revalidateLiveSessions()` re-checks every session backing a live socket on an interval
  (`DEFAULT_SESSION_REVALIDATION_INTERVAL_MS = 30_000`), in **one batched query** for all distinct
  sessions, applying the same two windows as the REST middleware (`SESSION_TIMEOUT_MS`,
  `ABSOLUTE_SESSION_TIMEOUT_MS`). Invalid → the socket is closed with code **4401**.
- It **fails open** on a database error: a transient outage must not disconnect every open editor.
- `closeSocketsForSession()` is called directly from `POST /api/auth/logout` and from the
  session-fixation rotation on login, so logout takes effect at once rather than up to 30s later.
- Connections are marked `revoked` *before* `ws.close()`, and inbound frames from a revoked
  connection are dropped — `close()` only starts the closing handshake, so without this an edit
  already in flight could still be persisted.

Behaviour change to be aware of: a session that has passed the 15-minute inactivity window now
loses its collaboration socket, where before only REST rejected it. Collaboration traffic
deliberately does **not** refresh `last_activity` — doing so would let an open tab keep a session
alive forever, which is a larger hole than the one being closed.

**What changed — TRO-188 / ERR-1 (data loss under a "Saved" label).**

`Editor.tsx` treated the WebSocket `status: connected` event as proof of persistence. It is not:
audit `probe2d-ws-unavailable.json` records **three** `connected` events and **zero** `sync` events,
with the indicator reading "Saved" for 60 s while `inDb=false`, ending in a document whose content
was `""`. `probe2-ws-drop` and `probe2e` show the same lie under the "Cached" label.

- The header indicator moved out of `Editor.tsx` into `web/src/components/editor/SyncStatusIndicator.tsx`
  with the derivation as a pure function (`deriveSyncIndicator`).
- "Saved" now requires `isSynced` — the y-websocket `sync` event, the only evidence the document
  reached the server. `status: connected` no longer sets it, and `sync(false)`/`disconnected`
  clears it.
- The unsynced state renders as **"Not saved"**, red, with a title that names the consequence
  ("changes … will be lost if you reload"). The reassuring "Cached" label is gone.
- A neutral "Connecting" state covers the first connection attempt only, so a normal page load does
  not flash a warning.
- Close code 4401 (TRO-189) stops the reconnect loop and drives the indicator to "Not saved",
  which is how a revoked session becomes visible to the user.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database
pnpm --filter @ship/api  exec vitest run src/collaboration/__tests__/session-revocation.test.ts
pnpm --filter @ship/web  exec vitest run src/components/editor/SyncStatusIndicator.test.tsx
scripts/factory/gate.sh
```

The api test drives the real collaboration server over a real WebSocket and asserts on the
`documents` table, not on a mock. It runs with a 200 ms revalidation interval via
`setupCollaboration(server, { sessionRevalidationIntervalMs })`.

**Rollback.** Revert the commits on `fix/err-1-err-2-collab-socket`. Independently:
for TRO-189 alone, delete the `revalidateLiveSessions`/`closeSocketsForSession` block in
`api/src/collaboration/index.ts` and its two call sites in `api/src/routes/auth.ts` — nothing else
depends on them, and `setupCollaboration`'s second argument is optional. For TRO-188 alone, pass a
permanently-true `isSynced` to `SyncStatusIndicator`, which restores the old "connected means
Saved" behaviour.

---

## TRO-172 — [API-1] Rate limiter no longer caps production at 100 req/min per IP

**What changed.** Two halves, server and client.

*Server* — `api/src/middleware/rate-limit.ts` (new) replaces the single `apiLimiter` that lived in
`api/src/app.ts`. `/api/` is now guarded by two chained limiters over the same 60 s window:

| Limiter | Key | Production limit | Purpose |
|---|---|---|---|
| `perSourceIpLimiter` | source IP | 6,000 / min (100 req/s) | anti-flood floor; makes the identity key unspoofable in aggregate |
| `perIdentityLimiter` | `session_id` cookie → `Bearer` token → source IP | 600 / min (10 req/s) | the budget users actually feel |

The old configuration was **100 / min keyed on IP**. Both numbers in it were wrong:

- *Unit.* The ceiling was sized as if one page view were one request. The audit's browser trace
  measured 63 `/api` requests across 8 flows (login 16, dashboard 12, document view 10, sprint
  board 10), so a user exhausted the window after ~6–10 navigations per minute.
- *Key.* With CloudFront → Elastic Beanstalk and `trust proxy 1`, every user behind one agency NAT
  egress resolved to the same IP, so a whole team shared one 100 req/min budget.

600 is justified against the measurement: the worst single-user burst is 16 XHRs × 20 navigations
per minute = 320 req/min, so 600 leaves ~1.9× headroom and still caps one session at 10 req/s.
6,000 accommodates ~187 simultaneously-active users behind one NAT egress at the measured average
of ~32 req/min per active user, while staying far below the 299–4,049 req/s this API was measured
to serve — a single-source flood is still capped. Test (10,000) and dev (1,000) budgets are
unchanged. Session ids and tokens are SHA-256 fingerprinted before use as bucket keys.

*Client* — `web/src/lib/queryClient.ts` now retries HTTP 429 for **queries and mutations** with a
2 s / 8 s / 20 s / 45 s backoff plus additive jitter. The schedule sums to ≥75 s so at least one
attempt lands after the server's 60 s window rolls over; React Query's default 1/2/4 s backoff
would exhaust itself inside the same window. Every other 4xx is still treated as permanent. If the
retries are exhausted the write is genuinely lost, so `MutationErrorToast` now raises a **sticky**
toast (`web/src/components/ui/Toast.tsx` gained `duration: 0` = no auto-dismiss) naming rate
limiting as the cause instead of a generic three-second message.

**Measured, NODE_ENV=production, concurrency 10, `GET /api/documents?type=wiki`, in-process listener:**

| Scenario | Before | After |
|---|---|---|
| 1,000 requests, no session cookie | 100 served / 900 throttled (90%) | 600 served / 400 throttled (40%) |
| 2,000 requests, 20 distinct sessions behind one IP | 100 served / 1,900 throttled (95%) | **2,000 served / 0 throttled** |

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api test src/middleware/__tests__/rate-limit.test.ts
pnpm --filter @ship/web test src/lib/queryClient.test.ts src/components/MutationErrorToast.test.tsx
```

**Rollback.** Revert the commits, or by hand: delete `api/src/middleware/rate-limit.ts` and restore
the single `apiLimiter` (`windowMs: 60_000`, `max: isTestEnv ? 10000 : isDevEnv ? 1000 : 100`) plus
`app.use('/api/', apiLimiter)` in `api/src/app.ts`; restore the two inline `retry` predicates in
`web/src/lib/queryClient.ts` and drop `retryDelay`. The `Toast` `duration: 0` support and the
sticky-toast branch in `MutationErrorToast` are additive and safe to leave.

---

## Factory visibility — status command, published board, cost analysis (no ticket: tooling)

**What changed.** Three additions, all reading from sources of truth rather than a status file:

- `scripts/factory/lib/state.mjs` — reconstructs factory state from git worktrees, `.factory-env`,
  `.factory/gate-result.json`, `gh pr list`, `scorecard.jsonl`, and Claude Code session
  transcripts. No state file is written, because one that drifts reads as authoritative while
  being wrong.
- `scripts/factory/status.mjs` — one-screen terminal view. `--json` feeds the board.
- `scripts/factory/board.mjs` — renders a self-contained HTML control panel (cream ground,
  British racing green, severity carried by stripe + wash + text colour, all contrast-measured
  against WCAG AA rather than estimated). Single-theme by choice: both `data-theme` values are
  pinned to the cream tokens so the viewer's toggle cannot flip it.
- `scripts/factory/serve.mjs` — local server that rebuilds the board from live state on every
  request. This is the surface for *operating* the factory: free to refresh, no agent needed.
  The published Artifact can only be updated by an agent calling a tool, so it is for *sharing*
  a milestone, not for watching a run.
- `scripts/factory/cost-report.mjs` — the graded "AI cost analysis" deliverable
  (`projectbrief.md:63`), derived retroactively from transcripts that already record per-message
  token usage.

**Decision: not LangGraph.** The workers are Claude Code sub-agents with their own tool loops in
git worktrees, so a graph framework would orchestrate opaque subprocesses — the interesting
internals are exactly what it cannot see. The durable state (branch, gate result, PR, Linear
ticket) already exists; a checkpointer would duplicate it and then disagree with it.

**How to run it.**

```bash
node scripts/factory/status.mjs
node scripts/factory/board.mjs > audit/factory/board.html   # then republish to the same URL
node scripts/factory/cost-report.mjs > audit/factory/COST_ANALYSIS.md
```

**Rollback.** Remove `scripts/factory/{status,board,cost-report}.mjs`, `scripts/factory/lib/state.mjs`,
and `audit/factory/{board.html,COST_ANALYSIS.md}`. Nothing else depends on them.

---

## TRO-244 — CI pipeline with source-code inventory

**What changed.** Added `.github/workflows/ci.yml`: typecheck, build, and unit tests for both
packages on every PR and every push to `main`, plus a source-code inventory job that emits a
per-SHA manifest (files and lines per package, dependency tree, licenses) as a retained artifact.

Web unit tests run with `continue-on-error` because 13 are known-failing (TEST-1 / TRO-223). The
real gate is the step after them, which compares failure *identities* against
`audit/factory/quarantine.json` and fails only on **new** breakage.

`pnpm lint` is deliberately **not** wired in: finding TS-6 (TRO-211) established there is no
ESLint config anywhere, so the script exits 0 having checked nothing. Adding it would make CI
advertise a quality gate that does not exist.

**How to run it.** Automatic on PR and push to `main`; `workflow_dispatch` for a manual run.
Locally, the same checks are `scripts/factory/gate.sh`.

**Rollback.** Delete `.github/workflows/ci.yml`. Nothing else depends on it.

---

## Factory harness — ticket remediation infrastructure (no ticket: tooling)

> Exempt from this file's ticket-ID join-key rule. This is sprint tooling, not a fix for an audit
> finding, so it has no entry in `AUDIT_REPORT.md` and no Linear ticket to join to. Every *code*
> change below this line does carry its ID.


**What changed.** Added the machinery that drives audit findings to merged fixes:

- `scripts/factory/worktree.sh` — provisions an isolated worktree, a dedicated database, and
  per-ticket ports. Necessary because `api/src/test/setup.ts` TRUNCATEs 16 tables in the
  `beforeAll` of every api test file; agents sharing a database corrupt each other's runs.
- `scripts/factory/gate.sh` — the per-ticket eval: typecheck, build, unit tests vs the quarantine
  baseline, tests-not-weakened, regression-test-present, `CHANGES.md` entry, scope, CodeRabbit
  capture. Writes `.factory/gate-result.json`.
- `scripts/factory/lib/testdiff.mjs` — compares failure identities, not counts. Verified against a
  forged run where one test broke and one was fixed: totals unchanged at 13, gate correctly failed.
- `audit/factory/quarantine.json` — the 13 known-failing web tests, so agent regressions are
  distinguishable from pre-existing red.
- `.coderabbit.yaml` — review configuration with path instructions tied to Ship's conventions.
- `.claude/skills/ship-factory/` — orchestration, agent contract, eval tiers, escalation gates.

**How to run it.**

```bash
scripts/factory/worktree.sh TRO-178 fix/db-1-migration-runner
cd ../Ship-wt-tro_178 && source .factory-env
scripts/factory/gate.sh          # --fast for the inner loop
```

**Rollback.** Remove `scripts/factory/`, `audit/factory/`, `.coderabbit.yaml`, and
`.claude/skills/ship-factory/`. Clean up worktrees with `git worktree remove`, and drop the
per-ticket databases (`ship_wt_*`) from the `ship-audit-pg` container.

---

## TRO-243 — Secrets loading hard-failed on any host that is not AWS

**What changed.** `loadProductionSecrets()` fetched from AWS SSM with no error handling under
`NODE_ENV=production` and overwrote `DATABASE_URL`. Off AWS it threw and killed the process before
the database was ever contacted. It now falls back to environment secrets when they are present
and rethrows when they are not. AWS behaviour is unchanged.

**How to run it.** Set `DATABASE_URL`, `SESSION_SECRET`, and `CORS_ORIGIN` in the environment and
start with `NODE_ENV=production`.

**Rollback.** Revert the merge of `fix/ssm-fallback` (`5b72a79`).

---

## TRO-242 — Build the image from source and serve the SPA from the API

**What changed.** Multi-stage `Dockerfile` so the image builds from a clean checkout — the
previous one copied `shared/dist/` and `api/dist/`, both gitignored and untracked, so it only
worked in the build-locally-then-ship AWS flow. Express now serves `web/dist` after all `/api`
routes. Same-origin is required by `sameSite: 'strict'` session cookies and by the collaboration
WebSocket URL being derived from `window.location.host`.

**How to run it.** `docker build -t ship . && docker run -p 3000:3000 ship`, or deploy to Render,
which builds from the repository.

**Rollback.** Revert the merge of `feat/render-deploy` (`bace770`).

