data "aws_caller_identity" "current" {}

# SSM Parameter Store - Database Connection String
resource "aws_ssm_parameter" "database_url" {
  name        = "/${var.project_name}/${var.environment}/DATABASE_URL"
  description = "PostgreSQL connection string for ${var.project_name} application"
  type        = "SecureString"
  value = format(
    "postgresql://%s:%s@%s:%s/%s",
    var.db_username,
    var.db_password,
    var.db_endpoint,
    var.db_port,
    var.db_name
  )

  tags = {
    Name = "${var.project_name}-${var.environment}-database-url"
  }
}

# SSM Parameter - Database Host (separate for easier access)
resource "aws_ssm_parameter" "db_host" {
  name        = "/${var.project_name}/${var.environment}/DB_HOST"
  description = "Aurora cluster endpoint"
  type        = "String"
  value       = var.db_endpoint

  tags = {
    Name = "${var.project_name}-${var.environment}-db-host"
  }
}

# SSM Parameter - Database Name
resource "aws_ssm_parameter" "db_name" {
  name        = "/${var.project_name}/${var.environment}/DB_NAME"
  description = "Database name"
  type        = "String"
  value       = var.db_name

  tags = {
    Name = "${var.project_name}-${var.environment}-db-name"
  }
}

# SSM Parameter - Database Username
resource "aws_ssm_parameter" "db_username" {
  name        = "/${var.project_name}/${var.environment}/DB_USERNAME"
  description = "Database username"
  type        = "String"
  value       = var.db_username

  tags = {
    Name = "${var.project_name}-${var.environment}-db-username"
  }
}

# SSM Parameter - Database Password
resource "aws_ssm_parameter" "db_password" {
  name        = "/${var.project_name}/${var.environment}/DB_PASSWORD"
  description = "Database password"
  type        = "SecureString"
  value       = var.db_password

  tags = {
    Name = "${var.project_name}-${var.environment}-db-password"
  }
}

locals {
  frontend_url = var.app_domain_name != "" ? "https://${var.app_domain_name}" : "https://${var.cloudfront_domain_name}"
  cdn_domain   = var.app_domain_name != "" ? var.app_domain_name : var.cloudfront_domain_name
}

# SSM Parameter - CORS Origin (for frontend URL)
resource "aws_ssm_parameter" "cors_origin" {
  name        = "/${var.project_name}/${var.environment}/CORS_ORIGIN"
  description = "CORS origin for API (frontend URL)"
  type        = "String"
  value       = local.frontend_url

  tags = {
    Name = "${var.project_name}-${var.environment}-cors-origin"
  }
}

# SSM Parameter - CDN Domain (for file upload URLs)
resource "aws_ssm_parameter" "cdn_domain" {
  name        = "/${var.project_name}/${var.environment}/CDN_DOMAIN"
  description = "CDN domain for serving uploaded files"
  type        = "String"
  value       = local.cdn_domain

  tags = {
    Name = "${var.project_name}-${var.environment}-cdn-domain"
  }
}

# SSM Parameter - App Base URL (for OAuth redirect URIs)
resource "aws_ssm_parameter" "app_base_url" {
  name        = "/${var.project_name}/${var.environment}/APP_BASE_URL"
  description = "Base URL for the application (used in OAuth callbacks)"
  type        = "String"
  value       = local.frontend_url

  tags = {
    Name = "${var.project_name}-${var.environment}-app-base-url"
  }
}

# Generate random session secret
#
# Module counterpart of `random_password.session_secret` in the flat root's
# `terraform/ssm.tf` — same TF-6 / TRO-239 finding, second location. This
# module backs `terraform/environments/dev` and `terraform/environments/shadow`
# (shadow is the UAT stack per `.claude/CLAUDE.md`). Same blast-radius hazard
# as the module's `random_password.db_password` in `../aurora/main.tf`, but
# this value signs every `express-session` cookie (`SESSION_SECRET`) for that
# environment — a silent regeneration (state loss, an accidental `-replace`)
# logs out every active user of that environment on the next request, with no
# warning.
#
# `keepers = {}` records that nothing currently triggers rotation
# intentionally. A deliberate rotation should be an announced operation, not
# a Terraform side effect — if a real rotation workflow is ever needed, it
# belongs in a runbook, not a keeper value that fires on an ordinary apply.
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
    Name = "${var.project_name}-${var.environment}-session-secret"
  }
}

# IAM Role policy for EB instances to read SSM parameters
resource "aws_iam_role_policy" "eb_ssm_access" {
  name = "${var.project_name}-${var.environment}-eb-ssm-access"
  role = var.eb_instance_role_name

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

# IAM Role policy for EB instances to access Secrets Manager (CAIA OAuth credentials)
resource "aws_iam_role_policy" "eb_secrets_manager_access" {
  name = "${var.project_name}-${var.environment}-eb-secrets-manager-access"
  role = var.eb_instance_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
          "secretsmanager:CreateSecret",
          "secretsmanager:UpdateSecret",
          "secretsmanager:TagResource"
        ]
        # Secret path: /{project_name}/{environment}/caia-credentials
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:/${var.project_name}/${var.environment}/*"
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
