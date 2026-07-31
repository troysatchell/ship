# Generate the Aurora master password.
#
# No `keepers`: `random_password` only regenerates on state loss or an
# explicit `terraform taint`/`-replace` — this is not active churn today. But
# with no `keepers` argument at all, there's nothing on the resource itself
# recording that the empty trigger set is deliberate rather than an
# oversight. Either of those events (an accidental `terraform state rm` +
# botched reimport, a careless `-replace`) silently rotates the *live* Aurora
# master password (flows into `master_password` on `aws_rds_cluster.aurora`
# below, and into the mirrored `DATABASE_URL`/`DB_PASSWORD` SSM parameters in
# ssm.tf) as a side effect of an ordinary-looking apply (TF-6 / TRO-239).
#
# `keepers = {}` makes that decision explicit: nothing currently triggers
# rotation. If a deliberate rotation policy is ever wanted, put the trigger
# value here (e.g. `keepers = { rotated_on = "2026-Q3" }`, bumped by hand)
# rather than relying on state loss or `-replace` to do it as a side effect.
resource "random_password" "db_password" {
  length  = 32
  special = false # Avoid special chars that might cause issues

  keepers = {}
}

resource "aws_db_subnet_group" "aurora" {
  name       = "${var.project_name}-aurora"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "${var.project_name}-aurora-subnet-group"
  }
}

resource "aws_rds_cluster_parameter_group" "aurora" {
  name   = "${var.project_name}-aurora-pg16"
  family = "aurora-postgresql16"

  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000" # Log queries taking > 1s
  }

  # DDoS protection: Connection and query limits
  # Ported from modules/aurora/main.tf (TRO-235 / TF-2) — present in the modular
  # path's parameter group but missing here before this change.
  parameter {
    name  = "max_connections"
    value = "200"
  }

  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "30000" # 30 seconds - terminate idle transactions
  }

  parameter {
    name  = "statement_timeout"
    value = "30000" # 30 seconds - terminate long-running queries
  }

  # DDoS forensics: Log connection events for attack analysis
  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  tags = {
    Name = "${var.project_name}-aurora-pg16"
  }
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier              = "${var.project_name}-aurora"
  engine                          = "aurora-postgresql"
  engine_mode                     = "provisioned"
  engine_version                  = "16.8"
  database_name                   = var.db_name
  master_username                 = "postgres"
  master_password                 = random_password.db_password.result
  storage_encrypted               = true
  deletion_protection             = true
  skip_final_snapshot             = var.environment != "prod"
  final_snapshot_identifier       = var.environment == "prod" ? "${var.project_name}-final-snapshot-${formatdate("YYYY-MM-DD-hhmm", timestamp())}" : null
  backup_retention_period         = var.environment == "prod" ? 7 : 1
  preferred_backup_window         = "03:00-04:00"
  preferred_maintenance_window    = "sun:04:00-sun:05:00"
  enabled_cloudwatch_logs_exports = ["postgresql"]

  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.aurora.name
  vpc_security_group_ids          = [aws_security_group.aurora.id]
  db_subnet_group_name            = aws_db_subnet_group.aurora.name

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_capacity
    max_capacity = var.aurora_max_capacity
  }

  tags = {
    Name = "${var.project_name}-aurora-cluster"
  }

  lifecycle {
    ignore_changes  = [final_snapshot_identifier]
    prevent_destroy = true
  }
}

resource "aws_rds_cluster_instance" "aurora" {
  cluster_identifier   = aws_rds_cluster.aurora.id
  identifier           = "${var.project_name}-aurora-instance-1"
  instance_class       = "db.serverless"
  engine               = aws_rds_cluster.aurora.engine
  engine_version       = aws_rds_cluster.aurora.engine_version
  publicly_accessible  = false
  db_subnet_group_name = aws_db_subnet_group.aurora.name

  tags = {
    Name = "${var.project_name}-aurora-instance-1"
  }
}

# CloudWatch Log Group for Aurora logs
resource "aws_cloudwatch_log_group" "aurora" {
  name              = "/aws/rds/cluster/${aws_rds_cluster.aurora.cluster_identifier}/postgresql"
  retention_in_days = 30

  tags = {
    Name = "${var.project_name}-aurora-logs"
  }
}
