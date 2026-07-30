# Ship - Terraform Infrastructure

This directory contains all infrastructure as code for deploying Ship to AWS.

## Authoritative config for prod (TRO-235 / TF-2)

**The flat `terraform/*.tf` root is the single, authoritative Terraform config for prod.**

Until TRO-235, prod was managed by *two* independent root configs with separate
state: this flat root, and `terraform/environments/prod` (composed from
`terraform/modules/*`). They had already drifted — the flat root had a WAF
(`waf.tf`) and CloudFront realtime logging (`cloudfront-logging.tf`) that the
modular `environments/prod` did not — and applying either one against the
wrong assumption about which was "real" risked colliding on hard-coded
resource names or reverting a security control the other had added. See
`audit/AUDIT_REPORT.md` (finding TF-2) and `audit/terraform/baseline.md` for
the full analysis.

**Resolution:** `terraform/environments/prod` (and its `.terraform.lock.hcl`)
has been deleted. `terraform/*.tf` is now the only config that may manage prod.
Before deleting it, `environments/prod`'s module composition was diffed
resource-by-resource against the flat root (see the reconciliation table in
the TRO-235 PR). Three genuinely missing security-hardening arguments were
found and ported into the flat root rather than dropped:

- Aurora `aws_rds_cluster_parameter_group` DDoS-protection/forensics params
  (`max_connections`, `idle_in_transaction_session_timeout`,
  `statement_timeout`, `log_connections`, `log_disconnections`) — `database.tf`.
- Elastic Beanstalk CPU-based autoscaling triggers + cooldown — `elastic-beanstalk.tf`.
- `secretsmanager:PutSecretValue` on the EB instance role — `ssm.tf`. Without
  it, `saveCAIACredentials()` in `api/src/services/secrets-manager.ts` gets
  `AccessDenied` the first time it updates an existing CAIA secret.

A CI check (`scripts/check-single-tf-root.sh`, wired into
`.github/workflows/ci.yml`) fails the build if a second AWS Terraform root
(e.g. a re-added `environments/prod`) reappears.

**`terraform/environments/dev` and `terraform/environments/shadow` are kept —
they are not part of this convergence.** TF-2 is specifically about prod being
managed by two configs; dev and shadow are different, non-overlapping AWS
environments that the flat root cannot deploy at all (every flat-root resource
name is hard-coded for prod, e.g. `elastic-beanstalk.tf`'s
`"${var.project_name}-api-prod"`). They remain the only Terraform-backed
deploy path for those two environments: `scripts/deploy.sh`,
`scripts/deploy-web.sh`, and `scripts/terraform.sh` all hard-code "prod uses
`terraform/`, dev/shadow use `terraform/environments/$ENV`". Deleting them
would have silently broken those scripts for no TF-2 benefit, so
`terraform/modules/*` (which dev and shadow are composed from) is also kept.
One pre-existing, out-of-scope gap worth flagging: `modules/aurora` and
`modules/elastic-beanstalk` still lack the three arguments ported above, and
`modules/cloudfront-s3` still lacks the flat root's WAF/realtime-logging
association — so dev and shadow do not yet have the same security posture as
prod. That is a real follow-up, not something TF-2 covers (TF-2 is about prod's
duplicate root, not about bringing dev/shadow to prod's posture).

## Directory Structure

```
terraform/
├── *.tf                    # Root config — THE authoritative config, prod only
├── environments/
│   ├── dev/                # Dev environment - uses shared VPC + modules/*
│   └── shadow/             # Shadow/UAT environment - uses shared VPC + modules/*
├── modules/                # Reusable Terraform modules (used by dev/shadow only)
│   ├── vpc/
│   ├── aurora/
│   ├── elastic-beanstalk/
│   ├── cloudfront-s3/
│   ├── security-groups/
│   └── ssm/
└── bootstrap/              # One-time setup (S3 state bucket)
```

## Multi-Environment Architecture (dev / shadow)

`environments/dev` and `environments/shadow` share the pattern described
below. Prod is no longer part of this scheme — see "Authoritative config for
prod" above.

### Why Separate Directories Instead of .tfvars?

Dev and shadow use `environments/<env>/` directories composed from
`modules/*` instead of a single configuration with different `.tfvars` files
because **the infrastructure code paths differ**, not just the values — both
read their VPC from SSM parameters set by `treasury-shared-infra` rather than
creating their own (that pattern is what prod used to do too, back when it
also lived under `environments/`; see the git history of
`environments/prod/main.tf` prior to TRO-235 if you need it).

**Dev/shadow** read VPC configuration from SSM parameters set by
`treasury-shared-infra`:
```hcl
# environments/dev/main.tf
data "aws_ssm_parameter" "vpc_id" {
  name = "/infra/dev/vpc_id"
}
```

This isn't a "same code, different values" situation—it's fundamentally
different infrastructure patterns from prod's dedicated VPC. Using `.tfvars`
alone would require complex conditional logic that's harder to understand and
maintain.

### When to Use Each Approach

| Scenario | Use .tfvars | Use Separate Directories |
|----------|-------------|--------------------------|
| Same code, different instance sizes | ✓ | |
| Same code, different domains | ✓ | |
| Different VPC strategies | | ✓ |
| Different provider configurations | | ✓ |
| Shared vs dedicated infrastructure | | ✓ |

### Trade-offs

**Separate directories (our choice):**
- ✓ Clear separation of concerns
- ✓ Each env can evolve independently
- ✓ Easier to understand what each env does
- ✓ Separate state files (no accidental cross-env changes)
- ✗ Some code duplication in variables.tf, versions.tf, outputs.tf

**Single config with .tfvars:**
- ✓ DRY - no code duplication
- ✓ Guaranteed consistency
- ✗ Complex conditionals for structural differences
- ✗ Shared state risk (unless using workspaces)
- ✗ Changes affect all environments at once

### Shared VPC Rationale (Dev / Shadow)

Dev and shadow use a shared VPC from `treasury-shared-infra` because:
1. **Cost savings** - Single NAT Gateway (~$33/mo) shared across dev services
2. **Network consistency** - All dev services can communicate within same VPC
3. **Simpler peering** - One VPC to connect to on-prem resources

Prod creates its own VPC (in the flat root, `vpc.tf`) because:
1. **Isolation** - Production shouldn't share network with dev services
2. **Independent scaling** - Prod VPC can be sized for production traffic
3. **Blast radius** - Issues in shared infrastructure don't affect prod

## Quick Start

### Prod: Root Directory (Authoritative)

```bash
# 0. Run from the terraform/ directory (repo root/terraform)
cd terraform

# 1. Verify AWS credentials (must have access to the team's AWS account)
aws sts get-caller-identity

# 2. Configure variables
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

# 3. Initialize Terraform (bucket name is fetched from SSM)
terraform init -backend-config="bucket=$(aws ssm get-parameter --name /ship/terraform-state-bucket --query Parameter.Value --output text)"

# 4. Plan changes
terraform plan -out=tfplan

# 5. Apply changes
terraform apply tfplan
```

### Dev / Shadow: Environment Directories

```bash
# 1. Verify AWS credentials
aws sts get-caller-identity

# 2. Navigate to environment
cd terraform/environments/dev   # or shadow

# 3. Sync config from SSM (creates terraform.tfvars)
../../scripts/sync-terraform-config.sh dev

# 4. Initialize Terraform
terraform init

# 5. Plan and apply
terraform plan -out=tfplan
terraform apply tfplan
```

> **Note:** The root-level `*.tf` files are the only config that may manage
> prod (see "Authoritative config for prod" above). `environments/dev` and
> `environments/shadow` remain for those two environments only — do not add a
> new `environments/prod` or any other second root that manages prod
> resources; `scripts/check-single-tf-root.sh` (run in CI) will fail the build
> if one appears.

## Infrastructure Components

| File | Purpose |
|------|---------|
| `versions.tf` | Provider configuration and versions |
| `variables.tf` | Input variables and defaults |
| `vpc.tf` | VPC, subnets, NAT, Internet Gateway, Flow Logs |
| `security-groups.tf` | Network security for ALB, EB, Aurora |
| `database.tf` | Aurora Serverless v2 PostgreSQL cluster |
| `ssm.tf` | SSM Parameter Store for secrets |
| `elastic-beanstalk.tf` | EB application, IAM roles |
| `s3-cloudfront.tf` | Frontend hosting (S3 + CloudFront) |
| `outputs.tf` | Output values for EB CLI and scripts |

## Resource Architecture

```
VPC (10.0.0.0/16)
├── Public Subnets (10.0.0.0/24, 10.0.1.0/24)
│   ├── Internet Gateway
│   ├── NAT Gateway
│   └── Application Load Balancer
│
└── Private Subnets (10.0.10.0/24, 10.0.11.0/24)
    ├── Elastic Beanstalk Instances
    └── Aurora Serverless v2 Cluster
```

## Configuration

### Required Variables

```hcl
aws_region   = "us-east-1"
project_name = "ship"
environment  = "dev"
```

### Optional Variables

```hcl
# Custom domains (requires Route53 zone)
route53_zone_id  = "Z1234567890ABC"
api_domain_name  = "api.example.gov"
app_domain_name  = "app.example.gov"

# Database scaling
aurora_min_capacity = 0.5  # ACUs
aurora_max_capacity = 4    # ACUs

# VPC configuration
vpc_cidr           = "10.0.0.0/16"
enable_nat_gateway = true  # Required for EB Docker pulls
```

## Important Outputs

After `terraform apply`, note these outputs:

| Output | Used For |
|--------|----------|
| `eb_application_name` | EB CLI initialization |
| `eb_instance_profile` | EB environment creation |
| `eb_service_role` | EB environment creation |
| `eb_vpc_id` | EB environment creation |
| `eb_private_subnets` | EB environment creation |
| `eb_public_subnets` | EB environment creation |
| `database_url_ssm_parameter` | Application configuration |
| `s3_bucket_name` | Frontend deployment |
| `cloudfront_distribution_id` | Frontend deployment |

## State Management

**IMPORTANT:** Terraform state is stored in S3 to prevent data loss. The state file tracks what resources Terraform manages - without it, Terraform cannot destroy or update resources.

### S3 Backend (Current Setup)

State is stored in a private S3 bucket with:
- Versioning enabled (can recover from mistakes)
- Encryption at rest (AES256)
- Public access blocked

The bucket name is **not committed to git** (compliance requirement - avoids exposing AWS account ID). Instead, it's stored in SSM Parameter Store at `/ship/terraform-state-bucket`.

This means:
- State survives git worktree deletion
- State is shared across all machines/worktrees
- No secrets or account identifiers in git
- Team members discover the bucket via SSM

### Initializing Terraform

```bash
# Fetch bucket name from SSM and initialize
terraform init -backend-config="bucket=$(aws ssm get-parameter --name /ship/terraform-state-bucket --query Parameter.Value --output text)"
```

Or create a local `.tfbackend` file (gitignored):

```bash
# Query once and save locally
echo "bucket = \"$(aws ssm get-parameter --name /ship/terraform-state-bucket --query Parameter.Value --output text)\"" > .tfbackend

# Then init is simpler
terraform init -backend-config=.tfbackend
```

### Bootstrap Directory

The `bootstrap/` directory contains Terraform that creates:
1. The S3 bucket for state storage
2. An SSM parameter with the bucket name (for team discovery)

This solves the chicken-and-egg problem (need bucket before you can use it as backend).

**If setting up from scratch (new AWS account):**

```bash
# 1. Create the S3 bucket and SSM parameter (one-time, by team lead)
cd terraform/bootstrap
terraform init
terraform apply

# 2. Initialize main terraform (uses SSM to find bucket)
cd ..
terraform init -backend-config="bucket=$(aws ssm get-parameter --name /ship/terraform-state-bucket --query Parameter.Value --output text)"
```

### Why This Matters

If you deploy from a git worktree and then delete that worktree, you lose the local state file. Without state, Terraform doesn't know what resources it created, and you cannot:
- Run `terraform destroy`
- Update existing resources
- See what's deployed

With S3 backend, state persists regardless of which machine or worktree you use.

### Recovering from Lost State

If state is lost and resources exist in AWS, you have two options:

1. **Import then destroy** - Import each resource into Terraform state, then destroy
2. **Manual cleanup via AWS CLI** - Delete resources directly

For manual cleanup, delete in this order (dependencies matter):
1. Elastic Beanstalk environment
2. RDS cluster and instances
3. CloudFront distribution
4. S3 buckets (empty first)
5. NAT Gateway
6. Security groups
7. Subnets
8. Internet Gateway
9. VPC
10. IAM roles/policies

## Cost Estimation

Use `terraform plan` with cost estimation tools:

```bash
# Using Infracost (https://www.infracost.io/)
infracost breakdown --path .

# Estimated monthly costs (dev environment):
# - Aurora Serverless v2 (0.5 ACU min): $43
# - Elastic Beanstalk (t3.small): $15
# - Application Load Balancer: $20
# - NAT Gateway: $33
# - S3 + CloudFront: $2
# Total: ~$113/month
```

## Maintenance

### Update Terraform

```bash
# Update providers
terraform init -upgrade

# Review changes
terraform plan

# Apply updates
terraform apply
```

### Update Aurora Version

1. Check available versions:
   ```bash
   aws rds describe-db-engine-versions \
     --engine aurora-postgresql \
     --query "DBEngineVersions[].EngineVersion"
   ```

2. Update `database.tf`:
   ```hcl
   engine_version = "16.2"  # New version
   ```

3. Apply changes:
   ```bash
   terraform apply
   ```

Aurora will perform a rolling upgrade during the maintenance window.

## Troubleshooting

### Terraform Init Fails

- Check AWS credentials: `aws sts get-caller-identity`
- Ensure Terraform version >= 1.6.0: `terraform version`

### Terraform Plan Shows Drift

Resources modified outside Terraform will show as changes. Common causes:
- EB auto-scaling changes
- RDS automated backups
- Security group rules added manually

To import resources:
```bash
terraform import aws_security_group_rule.example sg-12345678:ingress:tcp:22:22:0.0.0.0/0
```

### Aurora Creation Timeout

Aurora can take 10-15 minutes to create. If timeout occurs:
- Check RDS console for cluster status
- If cluster is "creating", wait and run `terraform apply` again
- Terraform will pick up the existing cluster

### NAT Gateway Expensive

NAT Gateway costs ~$33/month. For dev environments, you can:
1. Set `enable_nat_gateway = false`
2. Use VPC endpoints for AWS services (ECR, S3, SSM)

However, EB instances need internet access to pull Docker images from ECR Public.

## Security

### Compliance Features

- **Encryption:** Aurora (storage), S3 (AES256), TLS 1.2+ in transit
- **Audit:** VPC Flow Logs, CloudWatch Logs, CloudTrail integration
- **Network:** Private subnets for compute/database, no public IPs
- **IAM:** Least privilege roles, no hardcoded credentials
- **Secrets:** SSM Parameter Store (SecureString with KMS)

### Security Group Rules

All security groups follow least privilege:
- Aurora: Ingress only from EB instances on port 5432, no egress
- EB instances: Ingress from ALB on port 80, egress to internet (for updates)
- ALB: Ingress from internet on 80/443, egress to EB instances

### Secrets Management

Never commit secrets to git. Use SSM Parameter Store:

```bash
# Store secret
aws ssm put-parameter \
  --name "/ship/dev/API_KEY" \
  --type "SecureString" \
  --value "secret-value"

# Retrieve in application
import { SSM } from '@aws-sdk/client-ssm';
const ssm = new SSM();
const param = await ssm.getParameter({ Name: '/ship/dev/API_KEY', WithDecryption: true });
```

### SSM Parameter Inventory

All environment configuration lives in SSM. A new developer only needs AWS credentials - everything else is pulled from SSM automatically by `scripts/deploy.sh`.

**Terraform Config** (pulled by `sync-terraform-config.sh`):
```
/ship/terraform-config/{env}/environment          # "dev" or "prod"
/ship/terraform-config/{env}/app_domain_name      # Custom domain (optional)
/ship/terraform-config/{env}/route53_zone_id      # Route53 zone (optional)
/ship/terraform-config/{env}/eb_environment_cname # EB CNAME (optional)
```

**App Runtime** (loaded by `api/src/config/ssm.ts` in production):
```
/ship/{env}/DATABASE_URL     # PostgreSQL connection string (SecureString)
/ship/{env}/SESSION_SECRET   # Express session secret (SecureString)
/ship/{env}/CORS_ORIGIN      # Allowed CORS origin
/ship/{env}/CDN_DOMAIN       # CloudFront domain for assets
/ship/{env}/APP_BASE_URL     # Frontend app URL
```

**OAuth Credentials** (Secrets Manager, configured via `scripts/configure-caia.sh`):
```
/ship/{env}/caia-credentials  # JSON: issuer_url, client_id, client_secret
```

### Bootstrapping dev or shadow from scratch

This walks through (re)provisioning **`dev` or `shadow` only** — the two
`environments/<env>/` directories composed from `modules/*` that
`scripts/check-single-tf-root.sh` allows in CI. Prod is bootstrapped from the
flat `terraform/*.tf` root instead — see "Prod: Root Directory (Authoritative)"
above.

**This is not a template for adding a third environment.** Introducing a new
`environments/<env>/` directory (anything other than `dev` or `shadow`) needs
its `provider "aws"` root added to the allowlist in
`scripts/check-single-tf-root.sh` first, or CI will fail it — and, more
importantly, a decision that it genuinely doesn't overlap with what
`terraform/*.tf` manages for prod (that overlap is exactly what TF-2 removed).
`environments/prod` specifically must never come back; the guard enforces
that unconditionally, regardless of the allowlist.

To set up dev or shadow from scratch:

```bash
# 1. Create terraform config parameters
ENV=dev   # or shadow
aws ssm put-parameter --name /ship/terraform-config/$ENV/environment --value $ENV --type String

# 2. Create app runtime parameters
aws ssm put-parameter --name /ship/$ENV/SESSION_SECRET --value "$(openssl rand -hex 32)" --type SecureString
aws ssm put-parameter --name /ship/$ENV/CORS_ORIGIN --value "https://app.$ENV.example.gov" --type String
aws ssm put-parameter --name /ship/$ENV/CDN_DOMAIN --value "cdn.$ENV.example.gov" --type String
aws ssm put-parameter --name /ship/$ENV/APP_BASE_URL --value "https://app.$ENV.example.gov" --type String
# DATABASE_URL is created by Terraform and populated after Aurora is deployed

# 3. Deploy infrastructure
cd terraform/environments/$ENV
terraform init
terraform apply

# 4. Configure CAIA OAuth (get credentials from CAIA Shield first)
./scripts/configure-caia.sh $ENV

# 5. Deploy application
./scripts/deploy.sh $ENV
```

## Disaster Recovery

### Backup Strategy

- **Aurora:** Automated daily backups (7-day retention)
- **Terraform state:** Version controlled in S3 (if using S3 backend)

### Recovery Procedure

1. **Restore Aurora:**
   ```bash
   aws rds restore-db-cluster-to-point-in-time \
     --source-db-cluster-identifier ship-aurora \
     --target-db-cluster-identifier ship-aurora-restored \
     --restore-to-time 2024-01-01T00:00:00Z
   ```

2. **Update Terraform to use new cluster:**
   ```hcl
   # Import restored cluster
   terraform import aws_rds_cluster.aurora ship-aurora-restored
   ```

3. **Update SSM parameters with new endpoint:**
   ```bash
   aws ssm put-parameter \
     --name "/ship/dev/DATABASE_URL" \
     --type "SecureString" \
     --value "postgresql://user:pass@new-endpoint:5432/ship_main" \
     --overwrite
   ```

## Cleanup

To destroy all resources:

```bash
# 1. Delete EB environment first (not managed by Terraform)
cd ../api
eb terminate ship-api-dev

# 2. Destroy Terraform resources
cd ../terraform
terraform destroy
```

**Warning:** This is irreversible. Ensure you have backups.

For production, consider:
- Taking a final Aurora snapshot
- Backing up S3 bucket contents
- Exporting CloudWatch logs
