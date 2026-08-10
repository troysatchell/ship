# IAM Adaptation Memo — AWS Least-Privilege ⇄ Render's Permission Model

**PF-902 (TRO-420).** Defense material for the Architecture Defense: graders present a modified
`terraform plan`; this memo is the resource-by-resource blast-radius answer for the half of the
deployment (Render) that has no IAM system to walk through. Every claim below is either **observed**
(read directly from this repo's own `terraform/` and `terraform/render/`) or **derived** (inferred
from Render's general product behavior, not verified against this account's live API) — marked
inline, per `.claude/CLAUDE.md`'s provenance rule.

## 1. AWS side: task/execution role + the least-privilege exercise (observed)

This repo's live AWS compute is **Elastic Beanstalk on EC2**, not ECS Fargate — so there is no
literal "task role / execution role" pair (that split is ECS-specific). The closest AWS analog,
read directly from `terraform/elastic-beanstalk.tf` and `terraform/ssm.tf`:

- **`aws_iam_role.eb_instance`** (`elastic-beanstalk.tf:12-31`) — assumed by `ec2.amazonaws.com`,
  attached via `aws_iam_instance_profile.eb` (`:50-57`). This is the **single** role the running
  application code holds — and, correcting an earlier draft of this memo, it is not cleanly split
  into a "task role" (app permissions) and "execution role" (platform permissions) the way ECS
  separates them: **one role carries both.** Three AWS-managed policies attached to this same role
  give it EB platform permissions (WebTier/WorkerTier/MulticontainerDocker, `:34-47`) — broad,
  AWS-authored grants (S3 access to EB-managed buckets, CloudWatch Logs/metrics, and — for
  MulticontainerDocker — ECS/ECR describe-list permissions; **derived from AWS's published policy
  documents, not independently verified**, since this environment has held no AWS credentials all
  sprint per the landmine table in `PLUGFORGE.MD` §0.2). The application process therefore has
  *whatever those managed policies grant*, not only the narrower custom additions below — the
  least-privilege exercise narrows the app's own custom permissions, it does not narrow the
  managed-policy floor this instance role has.
- **The least-privilege exercise** is three custom, resource-scoped policies added on top of that
  same role (`ssm.tf:164-262`):
  - `eb_ssm_access` — `ssm:GetParameter*` scoped to `parameter/${project}/${environment}/*` (a path
    prefix, never `*`), plus `kms:Decrypt` gated by `Condition: kms:ViaService = ssm.<region>.amazonaws.com`
    — decrypt only fires when invoked through SSM.
  - `eb_bedrock_access` — `bedrock:InvokeModel` scoped to specific Anthropic model/inference-profile
    ARN patterns.
  - `eb_secrets_manager_access` — scoped to `secret:${project}/*`, KMS decrypt/`GenerateDataKey`
    gated the same `kms:ViaService` way.
- **`aws_iam_role.eb_service`** (`:60-84`) — a genuinely *separate* role, assumed only by
  `elasticbeanstalk.amazonaws.com` with an `ExternalId` condition. A credential leaked from the
  running instance (`eb_instance`) cannot use this role — that split (control plane vs. running
  app) is real, it is just not the same split as "custom least-privilege policy vs. managed
  platform policy," which both live on `eb_instance` together.
- `audit/terraform/baseline.md` classifies **all IAM resources as Tier 4 — safe, no-op, cheap to
  replace** (observed). The risk the custom policies manage is a compromised *running container*
  escalating beyond its own SSM parameters/secrets/Bedrock access; the managed-policy grants on the
  same role are a separate, wider surface this exercise does not narrow.

## 2. Render's equivalent (observed from `terraform/render/*.tf`, `README.md`)

**This Terraform configuration declares no IAM-shaped resource** — confirmed by reading all five
`.tf` files in `terraform/render/`: only `render_web_service` (×2) and `render_postgres` appear;
nothing role- or policy-shaped. That is a fact about what this config uses, not necessarily the
ceiling of what Render's product can express — see the caveat at the end of this section. Render's
actual access-control primitives, as this config uses them:

1. **API-key scoping — scoped to the owning user, not to a workspace, resource, or action.**
   `render_api_key` (`variables.tf:13-25`) authenticates the Terraform provider (and any direct
   REST caller) as the key's owning user; `render_owner_id` (`tea-d9kevetg1s2s73807n5g`, `:41-50`)
   names *which* workspace this config's resources live in, not the boundary of what the key can
   reach. **Derived — Render's own API docs, not verified against this account's live key/member
   settings:** a Render API key grants access to every workspace its owning user belongs to, not
   only the one this config targets — correcting an earlier draft of this memo, which described the
   key as scoped to `render_owner_id`. **Assumption, not verified:** per `README.md`'s verification
   log, only one key under one owner has ever been exercised here, and that owner is treated
   throughout this memo as belonging to a single workspace in practice; if the owner belongs to
   others, this key reaches those too.
2. **Service isolation — separation by not-sharing-config, not by a credential boundary.**
   `render_web_service.ship`, `render_web_service.agent`, and `render_postgres.ship` are three
   independent resources, each with its own `env_vars` block (verified: their maps share only
   `AGENT_INTERNAL_SECRET`, by design — see §4's scoped exception on that sharing). Postgres's
   `internal_connection_string` is wired only into `ship`'s env vars (`web_service.tf:49-51`), never
   `agent`'s — that isolates *what each service is configured to know*, not *what the key's holder
   can reach*: the same key reaches all three equally, since none of them is placed behind a
   narrower role (§2 caveat below).
3. **Env-var secret handling — same "never a literal" discipline, weaker storage protection.**
   `DATABASE_URL` derives from the Postgres resource's own computed attribute, never hardcoded
   (`:49-51`), matching AWS's SSM-not-literal practice. Terraform's `sensitive = true` on the
   *variables* only redacts `plan`/`output`, and only for values Terraform itself handles — it does
   not protect `terraform.tfstate`, which stores resolved values in plaintext. **Observed:** this
   repo's `terraform/.gitignore` excludes `*.tfstate`, `*.tfstate.*`, and `*.tfvars` for this
   directory (`terraform/.gitignore:3-5`; confirmed via `git ls-files terraform/render/` — none of
   the three are tracked). That reduces *accidental exposure via git* (a stray commit or push) — it
   does not mitigate the plaintext-state exposure itself: the local `.tfstate` file still holds
   resolved secrets in cleartext, unencrypted and ungoverned by any access control, on whatever
   machine runs `terraform apply`. That is a materially weaker posture than the AWS root's
   access-controlled S3 remote-state backend (§1), not an equivalent one reached a different way.
   Render's own at-rest encryption and runtime injection of env vars into the running container is
   standard product behavior (**derived from provider docs**, not independently verified against
   this account).

**Caveat carried into §§3–4:** Render's product does offer named workspace member roles — Admin,
Developer, Contributor, Viewer, and Billing — each restricting which actions a member can take, and,
on team plans, protected environments that can further gate who may deploy to a given environment
(**derived from Render's own documentation — not verified against this account's member list**,
since `render_owner_id` here is a single team ID with, per the verification log, exactly one API key
ever exercised against it; no member-role or protected-environment resource is declared anywhere in
this config). The absence below is therefore an absence *in this deployment's configuration*, not a
categorical claim that Render's platform has no permission or action-restriction concept whatsoever.

## 3. What this deployment's permission model cannot express (stated plainly)

1. **No user-defined per-resource or per-action policy, even using Render's fuller feature set (§2
   caveat).** There is no way to declare "this key may read parameter X but not write it," or scope
   a key to one specific service or resource. Render's named roles (Admin/Developer/Contributor/
   Viewer/Billing) and protected environments do impose coarse, role-level action restrictions on a
   *member* (**derived — Render docs**, §2 caveat) — but this config declares none of them, so the
   API key in use here carries full member access, unrestricted by any role; even a configured role
   would restrict actions at the workspace-membership level, not per resource, the way an IAM policy
   statement does (**derived**).
2. **No resource-level ARN-style scoping.** AWS's SSM/Secrets Manager policies above scope by path
   (`parameter/ship/prod/*`) and by condition key (`kms:ViaService`) — **observed**, §1. The API key
   this config and its operator actually use is scoped by the owning user's account, and per §2.1's
   correction (**derived — Render API docs**) that reach extends to every workspace the user belongs
   to, not only `tea-d9kevetg1s2s73807n5g`. Within this config's own workspace, the key can act on
   every resource in it — this config's Postgres and both web services included — because no
   narrower role or protected environment has been configured for them (**observed**: none declared
   in `terraform/render/*.tf`).
3. **No control-plane/data-plane split on the credential actually in use (observed).** AWS's
   `eb_service` (control plane, EB-management) is architecturally distinct from `eb_instance` (data
   plane, running app code) — one compromising the other is not possible by construction (§1). This
   deployment's single API key is both: it is the same credential `terraform apply` uses to
   create/destroy services and the *only* mechanism actually exercised to patch a live env var, per
   `terraform/render/README.md`'s documented workaround for the free-tier `render_web_service.agent`
   provider bug (`PUT /v1/services/{id}/env-vars/{key}`) — already exercised operationally in this
   repo (TRO-341, TRO-347), not hypothetical.
4. **No condition-key mechanism (derived — Render API/product docs, not verified against this
   account)** — no analog to `kms:ViaService`, source-IP conditions, or session-tag conditions that
   could narrow a broad grant short of a first-class policy resource, even for someone using
   Render's full workspace-role feature set.

## 4. Why the trade is acceptable for this deployment (specific, not generic)

- **Threat model fit (assessment: based on this repo's own project scope, not derived from Render's
  docs).** This is a single-operator, two-service, free-tier deployment for a graded project, not a
  multi-tenant system with a security team split across roles. "One key touches everything" — and,
  per §2.1's correction, potentially every workspace the key's owning user belongs to, not just this
  config's one (**derived — Render API docs**; **assumption**: per the verification log this account
  is operated as a single workspace in practice, so that broader reach is theoretical here, not
  exercised) — is the blast radius of "the operator's own credential is compromised." That is also
  true on the AWS side (**observed**): whoever can run `terraform apply` against `terraform/`
  already holds account-level AWS credentials capable of *provisioning* the IAM roles themselves.
  AWS's least-privilege exercise scopes the **custom permissions layered onto** `eb_instance`
  (§1) — SSM/Secrets Manager/Bedrock — beyond the managed-policy floor this instance role has; it
  does not and cannot scope what the deployer with `apply` access can do, nor does it narrow the
  managed-policy grants themselves.
- **The specific escalation path AWS's roles defend against is contained differently here, not left
  open — for the Render control-plane credential specifically.** AWS's scoped SSM/Secrets
  Manager/Bedrock policies exist so that a compromised running container (SSRF/RCE/dependency
  compromise) can't read more secrets than it needs. On Render, the running app processes never hold
  `RENDER_API_KEY` at all: it appears nowhere in `api/src` or `agent/src`'s server runtime
  (`server.ts`, `app.ts`, and everything they import — **observed**, verified by grep). It appears
  only in `terraform/render/` (deploy tooling) and in one standalone CLI,
  `agent/src/scripts/check-readiness-and-rollback.ts`, run exclusively as a separate GitHub Actions
  job (`.github/workflows/agent-rollback-check.yml`, `.github/workflows/ci-failure-rollback.yml`)
  authenticated via repo secrets — a different credential boundary from the deployed service's own
  env vars, not the app process holding it. So the containment mechanism is *omission* (the key
  never reaches the container) rather than a scoped grant, and for `RENDER_API_KEY` specifically the
  risk "app code reads more than it needs" is closed either way (**derived from the grep result
  above**). That containment is specific to the Render control-plane credential — it does not extend
  to `AGENT_INTERNAL_SECRET`, which the app processes do hold; see the scoped exception below.
- **The one gap this doesn't close:** the CI rollback automation and `terraform apply` both need the
  *same* key, unnarrowed by any workspace role or protected environment (§2 caveat — available on
  Render, not configured here). A compromise of that credential has, as actually configured, no
  narrower blast radius than every workspace its owning user belongs to (§2.1; assumed in practice
  to be just this one workspace) — AWS's IAM system would let that be scoped down further (e.g., a
  deploy-only role with no read access to secrets) (**derived/assessment**). Accepted because the
  deployment is free-tier, single-operator, low-value-target, and not carrying a compliance
  obligation — the mitigation is operational (rotate the key, restrict who holds it), not
  architectural.
- **Service separation does real work for provider-secret isolation — with a scoped exception.**
  `ship` (public-facing) and `ship-agent` (reached only through the shared-secret-gated proxy in
  `api/src/routes/agent.ts`) hold disjoint secrets for the values that matter most: a compromise of
  `ship`'s environment does not hand over `ANTHROPIC_API_KEY`/`LANGSMITH_API_KEY`, which live only
  in `agent`'s env var set (**observed**, §2.2). But `ship` and `ship-agent` also share
  `AGENT_INTERNAL_SECRET` by design (**observed**, §2.2, sent as the `X-Internal-Secret` header and
  checked by the agent before touching the graph or item store — `agent/src/server.ts`) — so a
  compromised `ship` process already holds the credential that gates the agent's internal endpoints,
  and can use it to pass that gate and reach `/chat`, `/inbox`, and `/accept-draft` (subject to each
  endpoint's own input validation). The env-var isolation claim above holds only for the provider
  keys (`ANTHROPIC_API_KEY`/`LANGSMITH_API_KEY`); it does not extend to reachability of the agent's
  internal API surface, which the shared secret already bridges. That boundary — real for provider
  keys, absent for internal-endpoint reachability — is weaker than IAM (no credential enforces even
  the part that holds; it's config discipline) but it is not nothing.

**Bottom line:** as configured, this deployment's Render side expresses *service-level* secret
isolation for provider keys and *never-a-literal* secret sourcing, matching AWS's discipline in
spirit — and even AWS's own least-privilege exercise here only narrows a custom slice on top of a
broader managed-policy floor, so the two sides are closer than a first pass suggests. What it does
not express is *sub-workspace* least privilege — no key here is narrower than every workspace its
owning user belongs to (**derived — Render API docs**; assumed in practice to be just this one
workspace, per the verification log). That gap is real, named here rather than implied away, and
accepted because the actor it would matter most against — a compromised running container — is
already excluded from holding the powerful Render control-plane credential (`RENDER_API_KEY`) by how
this repo's services are built, not by a permission grant. That exclusion is specific to
`RENDER_API_KEY`: the running containers do hold `AGENT_INTERNAL_SECRET`, enough for a compromised
`ship` process to pass the agent's internal gate (above) — a narrower, already-acknowledged
exception, not a contradiction of this bottom line.
