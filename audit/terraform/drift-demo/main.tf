# Drift-detection demonstration for the ShipShape audit (Category 8).
# Cloud-free: uses only the hashicorp/local provider. Manages two local resources,
# then a manual out-of-band edit is re-detected by `terraform plan`.
# Provider version pinned (audit requirement).

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "2.5.2"
    }
  }
}

# Resource 1: an app config file managed by Terraform.
resource "local_file" "app_config" {
  filename        = "${path.module}/generated/app.config.json"
  file_permission = "0644"
  content = jsonencode({
    service   = "shipshape-audit-demo"
    log_level = "info"
    replicas  = 2
  })
}

# Resource 2: an env file managed by Terraform.
resource "local_file" "env_file" {
  filename        = "${path.module}/generated/app.env"
  file_permission = "0600"
  content         = <<-EOT
    NODE_ENV=production
    FEATURE_FLAG_BETA=false
  EOT
}
