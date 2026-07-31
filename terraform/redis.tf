# ElastiCache Redis — rate-limiter shared store (TRO-280 / API-7).
#
# WHY THIS EXISTS: `api/src/middleware/rate-limit.ts`'s limiters (and
# `loginLimiter` in `api/src/app.ts`) default to `express-rate-limit`'s
# in-memory `MemoryStore`, which lives in one Node process's heap. This EB
# environment's ASG runs 1-4 instances (`elastic-beanstalk.tf`'s
# `aws:autoscaling:asg` `MinSize`/`MaxSize`) behind a load balancer with no
# session affinity, so a configured "600 req/min per identity" ceiling was
# actually "600 x N instances", where N moves under the same autoscaling
# trigger (`aws:autoscaling:trigger`, also in `elastic-beanstalk.tf`) that
# fires when traffic is high enough for the limit to matter. A single shared
# Redis instance gives every EB instance the same counters, so the configured
# ceiling is the real one regardless of N.
#
# SCOPE, matching this ticket's brief: a single small node is enough here —
# this is a rate-limiter counter store, not a cache whose loss would lose
# data (worst case on a Redis restart/failover: rate-limit counters reset to
# zero, which is never a correctness problem, only a brief window of
# looser-than-configured limits). Production hardening NOT done here, flagged
# as follow-up work for whoever picks this up with AWS access:
#
#   - Multi-AZ / automatic failover: would require `aws_elasticache_replication_group`
#     (with `automatic_failover_enabled = true`, >= 2 cache clusters) instead
#     of the single `aws_elasticache_cluster` below.
#   - `auth_token` (Redis AUTH) and `transit_encryption_enabled`: both are
#     only available via `aws_elasticache_replication_group`, not
#     `aws_elasticache_cluster` — switching to a (single-node) replication
#     group would be the smallest change that unlocks both.
#   - `at_rest_encryption_enabled`: also replication-group-only.
#
# Matches TF-7 (TRO-278)'s convention for adding a new AWS resource: its own
# dedicated security group, scoped to ingress from the API's own security
# group only — never 0.0.0.0/0, never the ALB's or CloudFront's ranges (this
# resource is never internet-facing, unlike TF-7's ALB).

# Redis security group — ingress only from the EB instance security group
# (the only thing that will ever call `apiRateLimitKey`'s store). Modeled on
# `aws_security_group.aurora` in database.tf, which does the same thing for
# Postgres: a dedicated SG, one ingress rule sourced from
# `aws_security_group.eb_instance.id`, no outbound rules (this SG only ever
# receives connections).
resource "aws_security_group" "redis" {
  name        = "${var.project_name}-redis"
  description = "ElastiCache Redis security group - ingress only from EB (rate-limiter store)"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.project_name}-redis"
  }
}

resource "aws_security_group_rule" "redis_ingress_from_eb" {
  type                     = "ingress"
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  security_group_id        = aws_security_group.redis.id
  source_security_group_id = aws_security_group.eb_instance.id
  description              = "Allow Redis from EB instances only"
}

# No outbound rules — same reasoning as aws_security_group.aurora: nothing
# behind this SG (the ElastiCache node) ever needs to initiate a connection.

# Same private subnets Aurora uses (`aws_db_subnet_group.aurora` in
# database.tf) — this environment already treats "private subnets" as where
# stateful, non-internet-facing AWS resources for this app live.
resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.project_name}-redis"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "${var.project_name}-redis-subnet-group"
  }
}

# Single small node — see the file-level comment above for why this is
# enough for a rate-limiter store, and what a production-hardened version
# would need instead.
resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "${var.project_name}-redis"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  num_cache_nodes      = 1
  port                 = 6379
  parameter_group_name = "default.redis7"

  subnet_group_name  = aws_elasticache_subnet_group.redis.name
  security_group_ids = [aws_security_group.redis.id]

  # Rate-limit counters are disposable (see file-level comment) — a snapshot
  # window buys nothing here and only costs storage, unlike Aurora's real
  # backup_retention_period.
  snapshot_retention_limit = 0

  tags = {
    Name = "${var.project_name}-redis"
  }
}

output "redis_endpoint" {
  description = "ElastiCache Redis primary endpoint (host)"
  value       = aws_elasticache_cluster.redis.cache_nodes[0].address
}

output "redis_port" {
  description = "ElastiCache Redis port"
  value       = aws_elasticache_cluster.redis.cache_nodes[0].port
}

output "redis_url_ssm_parameter" {
  description = "SSM parameter name for REDIS_URL"
  value       = aws_ssm_parameter.redis_url.name
}
