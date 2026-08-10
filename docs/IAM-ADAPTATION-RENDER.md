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
  attached via `aws_iam_instance_profile.eb` (`:50-57`). This is the role the *running application
  code* holds — the ECS "task role" analog. Three AWS-managed policies give it EB platform
  permissions (WebTier/WorkerTier/MulticontainerDocker, `:34-47`) — the ECS "execution role" analog
  (managing the running environment, not app logic).
- **The least-privilege exercise** is three custom, resource-scoped policies on that same role
  (`ssm.tf:164-262`):
  - `eb_ssm_access` — `ssm:GetParameter*` scoped to `parameter/${project}/${environment}/*` (a path
    prefix, never `*`), plus `kms:Decrypt` gated by `Condition: kms:ViaService = ssm.<region>.amazonaws.com`
    — decrypt only fires when invoked through SSM.
  - `eb_bedrock_access` — `bedrock:InvokeModel` scoped to specific Anthropic model/inference-profile
    ARN patterns.
  - `eb_secrets_manager_access` — scoped to `secret:${project}/*`, KMS decrypt/`GenerateDataKey`
    gated the same `kms:ViaService` way.
- **`aws_iam_role.eb_service`** (`:60-84`) — a *separate* role, assumed only by
  `elasticbeanstalk.amazonaws.com` with an `ExternalId` condition. A credential leaked from the
  running instance (`eb_instance`) cannot use this role — it is architecturally a different
  principal, holding only AWS-managed EB-management policies.
- `audit/terraform/baseline.md` classifies **all IAM resources as Tier 4 — safe, no-op, cheap to
  replace** (observed). The risk this design manages is a compromised *running container*
  escalating beyond its own SSM parameters/secrets, not deploy-time risk.

## 2. Render's equivalent (observed from `terraform/render/*.tf`, `README.md`)

Render has **no IAM-shaped resource type at all** — confirmed by reading all five `.tf` files in
`terraform/render/`: only `render_web_service` (×2) and `render_postgres` appear; nothing role- or
policy-shaped. Render's actual access-control primitives, as this config uses them:

1. **API-key scoping — account-wide, not resource- or action-scoped.** `render_api_key`
   (`variables.tf:13-25`) authenticates the Terraform provider (and any direct REST caller) as
   `render_owner_id` (`tea-d9kevetg1s2s73807n5g`, an owner/team ID, `:41-50`) — one key, full
   account. **Derived from provider docs, not verified against this account's key settings** (only
   one key has ever been used here, per `README.md`'s verification log): Render's key model is
   account/workspace-level, with no per-service or per-action grant.
2. **Service isolation — separation by not-sharing-config, not by a credential boundary.**
   `render_web_service.ship`, `render_web_service.agent`, and `render_postgres.ship` are three
   independent resources, each with its own `env_vars` block (verified: their maps share only
   `AGENT_INTERNAL_SECRET`, by design). Postgres's `internal_connection_string` is wired only into
   `ship`'s env vars (`web_service.tf:49-51`), never `agent`'s — that isolates *what each service is
   configured to know*, not *what the one API key can reach*: the same key manages all three
   equally.
3. **Env-var secret handling — same "never a literal" discipline, different storage.**
   `DATABASE_URL` derives from the Postgres resource's own computed attribute, never hardcoded
   (`:49-51`), matching AWS's SSM-not-literal practice. Terraform's `sensitive = true` on the
   *variables* only redacts `plan`/`output`; Render's own at-rest encryption and runtime injection
   of env vars is standard product behavior (**derived from provider docs**, not independently
   verified against this account).

## 3. What Render cannot express (stated plainly)

1. **No role/policy resource, at all.** There is no way to declare "this service may read
   parameter X but not write it," or scope a key to one service, one action, or read-only access.
2. **No resource-level ARN-style scoping.** AWS's SSM/Secrets Manager policies above scope by path
   (`parameter/ship/prod/*`) and by condition key (`kms:ViaService`). A Render API key is
   all-or-nothing at the owner level — it can act on every resource that owner has, this config's
   Postgres and both web services included.
3. **No control-plane/data-plane role split.** AWS's `eb_service` (control plane, EB-management) is
   architecturally distinct from `eb_instance` (data plane, running app code) — one compromising the
   other is not possible by construction. Render has one identity for both: the same account-wide
   key that `terraform apply` uses to create/destroy services is the *only* mechanism to patch a
   live env var, per `terraform/render/README.md`'s documented workaround for the free-tier
   `render_web_service.agent` provider bug (`PUT /v1/services/{id}/env-vars/{key}`) — already
   exercised operationally in this repo (TRO-341, TRO-347), not hypothetical.
4. **No condition-key mechanism** — no analog to `kms:ViaService`, source-IP conditions, or
   session-tag conditions that could narrow a broad grant short of a first-class policy resource.

## 4. Why the trade is acceptable for this deployment (specific, not generic)

- **Threat model fit.** This is a single-operator, two-service, free-tier deployment for a graded
  project, not a multi-tenant system with a security team split across roles. "One key touches
  everything" is the blast radius of "the operator's own credential is compromised" — which is also
  true on the AWS side: whoever can run `terraform apply` against `terraform/` already holds
  account-level AWS credentials capable of *provisioning* the IAM roles themselves. AWS's
  least-privilege exercise scopes what the **running application** can do post-deploy; it does not
  and cannot scope what the deployer with `apply` access can do.
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
  *same* account-wide key. A compromise of that credential (operator machine or CI secret) has no
  narrower blast radius on Render than full account access — AWS's IAM system would let that be
  scoped down further (e.g., a deploy-only role with no read access to secrets); Render's does not.
  Accepted here because the deployment is free-tier, low-value-target, and not carrying a compliance
  obligation — the mitigation is operational (rotate the key, restrict who holds it), not
  architectural.
- **Service separation still does real work.** `ship` (public-facing) and `ship-agent` (reached only
  through the shared-secret-gated proxy in `api/src/routes/agent.ts`) hold disjoint secrets — a
  compromise of `ship`'s environment does not hand over `ANTHROPIC_API_KEY`/`LANGSMITH_API_KEY`,
  which live only in `agent`'s env var set. That boundary is weaker than IAM (no credential enforces
  it, only config discipline) but it is not nothing.

**Bottom line:** Render's model can express *service-level* secret isolation and *never-a-literal*
secret sourcing, matching AWS's discipline in spirit. It cannot express *sub-service* least
privilege — no role can be narrower than "the whole account." That gap is real, named here rather
than implied away, and accepted because the actor it would matter most against (a compromised
running container) is already excluded from holding the powerful credential by how this repo's
services are built, not by a permission grant.
