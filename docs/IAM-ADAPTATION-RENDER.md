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
  managed-policy floor every EB instance role starts with.
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

1. **API-key scoping — user-scoped, not resource- or action-scoped.** `render_api_key`
   (`variables.tf:13-25`) authenticates the Terraform provider (and any direct REST caller) as
   `render_owner_id` (`tea-d9kevetg1s2s73807n5g`, an owner/team ID, `:41-50`). **Derived from
   provider docs, not verified against this account's key/member settings** (only one key, under
   one owner, has ever been used here, per `README.md`'s verification log): a Render API key is
   issued to a *user*, and its effective reach is that user's workspace role, not a role or policy
   attached to the key itself — there is no per-service or per-action grant on the key.
2. **Service isolation — separation by not-sharing-config, not by a credential boundary.**
   `render_web_service.ship`, `render_web_service.agent`, and `render_postgres.ship` are three
   independent resources, each with its own `env_vars` block (verified: their maps share only
   `AGENT_INTERNAL_SECRET`, by design). Postgres's `internal_connection_string` is wired only into
   `ship`'s env vars (`web_service.tf:49-51`), never `agent`'s — that isolates *what each service is
   configured to know*, not *what the key's holder can reach*: the same key reaches all three
   equally, since none of them is placed behind a narrower workspace role.
3. **Env-var secret handling — same "never a literal" discipline, different storage.**
   `DATABASE_URL` derives from the Postgres resource's own computed attribute, never hardcoded
   (`:49-51`), matching AWS's SSM-not-literal practice. Terraform's `sensitive = true` on the
   *variables* only redacts `plan`/`output`, and only for values Terraform itself handles — it does
   not protect `terraform.tfstate`, which stores resolved values in plaintext. **Observed:** this
   repo's `terraform/.gitignore` excludes `*.tfstate`, `*.tfstate.*`, and `*.tfvars` for this
   directory (`terraform/.gitignore:3-5`; confirmed via `git ls-files terraform/render/` — none of
   the three are tracked), so the plaintext-state exposure is mitigated by keeping state untracked
   and local, the same posture the AWS root's S3 remote-state backend achieves a different way.
   Render's own at-rest encryption and runtime injection of env vars into the running container is
   standard product behavior (**derived from provider docs**, not independently verified against
   this account).

**Caveat carried into §§3–4:** Render's product does offer workspace member roles (Owner/Admin/
Collaborator-shaped) and, on team plans, protected environments that can gate who may deploy to a
given environment (**derived from provider docs — not verified against this account**, since
`render_owner_id` here is a single team ID with, per the verification log, exactly one API key ever
exercised against it; no member-role or protected-environment resource is declared anywhere in this
config). The absence below is therefore an absence *in this deployment's configuration*, not a
categorical claim that Render's platform has no permission concept whatsoever.

## 3. What this deployment's permission model cannot express (stated plainly)

1. **No resource- or action-level policy, even using Render's fuller feature set (§2 caveat).**
   There is no way to declare "this key may read parameter X but not write it," or scope a key to
   one service or one action — workspace roles and protected environments are the coarsest units
   Render offers, and neither is a per-resource, per-action grant the way an IAM policy statement is.
2. **No resource-level ARN-style scoping.** AWS's SSM/Secrets Manager policies above scope by path
   (`parameter/ship/prod/*`) and by condition key (`kms:ViaService`). The API key this config and
   its operator actually use is scoped only by workspace membership — it can act on every resource
   in `tea-d9kevetg1s2s73807n5g`, this config's Postgres and both web services included, because no
   narrower role or protected environment has been configured for them.
3. **No control-plane/data-plane split on the credential actually in use.** AWS's `eb_service`
   (control plane, EB-management) is architecturally distinct from `eb_instance` (data plane,
   running app code) — one compromising the other is not possible by construction. This deployment's
   single API key is both: it is the same credential `terraform apply` uses to create/destroy
   services and the *only* mechanism actually exercised to patch a live env var, per
   `terraform/render/README.md`'s documented workaround for the free-tier `render_web_service.agent`
   provider bug (`PUT /v1/services/{id}/env-vars/{key}`) — already exercised operationally in this
   repo (TRO-341, TRO-347), not hypothetical.
4. **No condition-key mechanism** — no analog to `kms:ViaService`, source-IP conditions, or
   session-tag conditions that could narrow a broad grant short of a first-class policy resource,
   even for someone using Render's full workspace-role feature set.

## 4. Why the trade is acceptable for this deployment (specific, not generic)

- **Threat model fit.** This is a single-operator, two-service, free-tier deployment for a graded
  project, not a multi-tenant system with a security team split across roles. "One key touches
  everything" is the blast radius of "the operator's own credential is compromised" — which is also
  true on the AWS side: whoever can run `terraform apply` against `terraform/` already holds
  account-level AWS credentials capable of *provisioning* the IAM roles themselves. AWS's
  least-privilege exercise scopes the **custom permissions layered onto** `eb_instance`
  (§1) — SSM/Secrets Manager/Bedrock — beyond the managed-policy floor every EB instance role
  starts with; it does not and cannot scope what the deployer with `apply` access can do, nor does
  it narrow the managed-policy grants themselves.
- **The specific escalation path AWS's roles defend against is contained differently here, not
  left open.** AWS's scoped SSM/Secrets Manager/Bedrock policies exist so that a compromised running
  container (SSRF/RCE/dependency compromise) can't read more secrets than it needs. On Render, the
  running app processes never hold the account-wide credential at all: `RENDER_API_KEY` appears
  nowhere in `api/src` or `agent/src`'s server runtime (`server.ts`, `app.ts`, and everything they
  import — verified by grep). It appears only in `terraform/render/` (deploy tooling) and in one
  standalone CLI, `agent/src/scripts/check-readiness-and-rollback.ts`, run exclusively as a separate
  GitHub Actions job (`.github/workflows/agent-rollback-check.yml`,
  `.github/workflows/ci-failure-rollback.yml`) authenticated via repo secrets — a different
  credential boundary from the deployed service's own env vars, not the app process holding it.
  So the containment mechanism is *omission* (the key never reaches the container) rather than a
  scoped grant, but the specific risk — "app code reads more than it needs" — is closed either way.
- **The one gap this doesn't close:** the CI rollback automation and `terraform apply` both need the
  *same* key, unnarrowed by any workspace role or protected environment (§2 caveat — available on
  Render, not configured here). A compromise of that credential has no narrower blast radius, as
  actually configured, than full workspace access — AWS's IAM system would let that be scoped down
  further (e.g., a deploy-only role with no read access to secrets). Accepted because the deployment
  is free-tier, single-operator, low-value-target, and not carrying a compliance obligation — the
  mitigation is operational (rotate the key, restrict who holds it), not architectural.
- **Service separation still does real work.** `ship` (public-facing) and `ship-agent` (reached only
  through the shared-secret-gated proxy in `api/src/routes/agent.ts`) hold disjoint secrets — a
  compromise of `ship`'s environment does not hand over `ANTHROPIC_API_KEY`/`LANGSMITH_API_KEY`,
  which live only in `agent`'s env var set. That boundary is weaker than IAM (no credential enforces
  it, only config discipline) but it is not nothing.

**Bottom line:** as configured, this deployment's Render side expresses *service-level* secret
isolation and *never-a-literal* secret sourcing, matching AWS's discipline in spirit — and even
AWS's own least-privilege exercise here only narrows a custom slice on top of a broader managed-
policy floor, so the two sides are closer than a first pass suggests. What it does not express is
*sub-workspace* least privilege — no key here is narrower than "the whole workspace." That gap is
real, named here rather than implied away, and accepted because the actor it would matter most
against (a compromised running container) is already excluded from holding the powerful credential
by how this repo's services are built, not by a permission grant.
