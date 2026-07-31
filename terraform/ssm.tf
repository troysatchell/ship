# SSM Parameter Store - Database Connection String
resource "aws_ssm_parameter" "database_url" {
  name        = "/${var.project_name}/${var.environment}/DATABASE_URL"
  description = "PostgreSQL connection string for Ship application"
  type        = "SecureString"
  value = format(
    "postgresql://%s:%s@%s:%s/%s",
    aws_rds_cluster.aurora.master_username,
    random_password.db_password.result,
    aws_rds_cluster.aurora.endpoint,
    aws_rds_cluster.aurora.port,
    aws_rds_cluster.aurora.database_name
  )

  tags = {
    Name = "${var.project_name}-database-url"
  }
}

# SSM Parameter - Database Host (separate for easier access)
resource "aws_ssm_parameter" "db_host" {
  name        = "/${var.project_name}/${var.environment}/DB_HOST"
  description = "Aurora cluster endpoint"
  type        = "String"
  value       = aws_rds_cluster.aurora.endpoint

  tags = {
    Name = "${var.project_name}-db-host"
  }
}

# SSM Parameter - Database Name
resource "aws_ssm_parameter" "db_name" {
  name        = "/${var.project_name}/${var.environment}/DB_NAME"
  description = "Database name"
  type        = "String"
  value       = aws_rds_cluster.aurora.database_name

  tags = {
    Name = "${var.project_name}-db-name"
  }
}

# SSM Parameter - Database Username
resource "aws_ssm_parameter" "db_username" {
  name        = "/${var.project_name}/${var.environment}/DB_USERNAME"
  description = "Database username"
  type        = "String"
  value       = aws_rds_cluster.aurora.master_username

  tags = {
    Name = "${var.project_name}-db-username"
  }
}

# SSM Parameter - Database Password
resource "aws_ssm_parameter" "db_password" {
  name        = "/${var.project_name}/${var.environment}/DB_PASSWORD"
  description = "Database password"
  type        = "SecureString"
  value       = random_password.db_password.result

  tags = {
    Name = "${var.project_name}-db-password"
  }
}

# SSM Parameter - Redis connection string for the rate limiter (TRO-280 / API-7).
# Same plumbing as `aws_ssm_parameter.database_url` above: the app's
# `api/src/config/ssm.ts` (`loadProductionSecrets`) fetches this at boot and
# sets `process.env.REDIS_URL`, which `api/src/middleware/rate-limit.ts` and
# `api/src/app.ts` read to switch their limiters onto the Redis-shared store.
# Unlike DATABASE_URL, this fetch is best-effort in the app (see ssm.ts) —
# Redis is opt-in, so a deploy of this Terraform without the app being ready
# for it (or vice versa) fails soft to the pre-TRO-280 in-memory store rather
# than crash-looping the container.
resource "aws_ssm_parameter" "redis_url" {
  name        = "/${var.project_name}/${var.environment}/REDIS_URL"
  description = "Redis connection string for the rate limiter's shared store"
  type        = "SecureString"
  value = format(
    "redis://%s:%s",
    aws_elasticache_cluster.redis.cache_nodes[0].address,
    aws_elasticache_cluster.redis.cache_nodes[0].port
  )

  tags = {
    Name = "${var.project_name}-redis-url"
  }
}

# SSM Parameter - CORS Origin (for frontend URL)
resource "aws_ssm_parameter" "cors_origin" {
  name        = "/${var.project_name}/${var.environment}/CORS_ORIGIN"
  description = "CORS origin for API (frontend URL)"
  type        = "String"
  value       = var.app_domain_name != "" ? "https://${var.app_domain_name}" : "https://${aws_cloudfront_distribution.frontend.domain_name}"

  tags = {
    Name = "${var.project_name}-cors-origin"
  }
}

# SSM Parameter - CDN Domain (for file upload URLs)
resource "aws_ssm_parameter" "cdn_domain" {
  name        = "/${var.project_name}/${var.environment}/CDN_DOMAIN"
  description = "CDN domain for serving uploaded files"
  type        = "String"
  value       = var.app_domain_name != "" ? var.app_domain_name : aws_cloudfront_distribution.frontend.domain_name

  tags = {
    Name = "${var.project_name}-cdn-domain"
  }
}

# SSM Parameter - App Base URL (for OAuth redirect URIs)
resource "aws_ssm_parameter" "app_base_url" {
  name        = "/${var.project_name}/${var.environment}/APP_BASE_URL"
  description = "Base URL for the application (used in OAuth callbacks)"
  type        = "String"
  value       = var.app_domain_name != "" ? "https://${var.app_domain_name}" : "https://${aws_cloudfront_distribution.frontend.domain_name}"

  tags = {
    Name = "${var.project_name}-app-base-url"
  }
}

# Generate random session secret
#
# No `keepers`: same blast-radius hazard as `random_password.db_password` in
# database.tf (TF-6 / TRO-239), but the cost lands differently — this value
# signs every `express-session` cookie (the app's `SESSION_SECRET`, read at
# boot by `api/src/config/ssm.ts`). A silent regeneration (state loss, an
# accidental `-replace`) invalidates the signature on every existing session
# cookie on the next request: every active user is logged out simultaneously,
# with no maintenance window and no warning.
#
# `keepers = {}` records that nothing currently triggers rotation
# intentionally. Deliberately rotating this secret should be an announced
# operation (a maintenance window, not a Friday deploy that silently logs
# everyone out) — if a real rotation workflow is ever needed, it belongs in a
# runbook/documented procedure, not a keeper value that fires on an ordinary
# apply.
resource "random_password" "session_secret" {
  length  = 64
  special = false

  keepers = {}
}

# SSM Parameter - Session Secret (for express-session)
resource "aws_ssm_parameter" "session_secret" {
  name        = "/${var.project_name}/${var.environment}/SESSION_SECRET"
  description = "Session secret for express-session cookie signing"
  type        = "SecureString"
  value       = random_password.session_secret.result

  tags = {
    Name = "${var.project_name}-session-secret"
  }
}

# IAM Role for EB instances to read SSM parameters
resource "aws_iam_role_policy" "eb_ssm_access" {
  name = "${var.project_name}-eb-ssm-access"
  role = aws_iam_role.eb_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath"
        ]
        Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com"
          }
        }
      }
    ]
  })
}

data "aws_caller_identity" "current" {}

# IAM Role for EB instances to invoke Bedrock models (AI quality analysis)
resource "aws_iam_role_policy" "eb_bedrock_access" {
  name = "${var.project_name}-eb-bedrock-access"
  role = aws_iam_role.eb_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel"
        ]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/anthropic.*",
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/anthropic.*",
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/global.anthropic.*"
        ]
      }
    ]
  })
}

# IAM Role for EB instances to access Secrets Manager (FPKI OAuth credentials)
resource "aws_iam_role_policy" "eb_secrets_manager_access" {
  name = "${var.project_name}-eb-secrets-manager-access"
  role = aws_iam_role.eb_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          # Ported from modules/ssm/main.tf (TRO-235 / TF-2): saveCAIACredentials()
          # in api/src/services/secrets-manager.ts:136 calls PutSecretValueCommand
          # to update an existing secret. Without this action that call fails with
          # AccessDenied under this role — CreateSecret/UpdateSecret do not cover it.
          "secretsmanager:PutSecretValue",
          "secretsmanager:CreateSecret",
          "secretsmanager:UpdateSecret",
          "secretsmanager:TagResource"
        ]
        Resource = [
          "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${var.project_name}/*",
          "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:/${var.project_name}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com"
          }
        }
      }
    ]
  })
}
