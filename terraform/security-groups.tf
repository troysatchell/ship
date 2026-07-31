# CloudFront's origin-facing managed prefix list — the IP ranges CloudFront edge
# locations use when connecting to a custom origin. Looked up by AWS's well-known
# name rather than hardcoded, so it tracks CloudFront's ranges as AWS updates them.
# Used below to restrict the ALB security group instead of 0.0.0.0/0 (finding TF-7 /
# TRO-278): the ALB is a `custom_origin_config` behind the `EB-API` CloudFront
# behavior (terraform/s3-cloudfront.tf), so CloudFront is the only legitimate way
# to reach it — direct internet access to the ALB bypasses CloudFront's WAF
# (waf.tf) and lets a client's own X-Forwarded-For reach the ALB unmediated.
data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

# CAUTION (CodeRabbit finding on this PR — TRO-278/TF-7 — partially mitigated
# by TRO-295/TF-7 follow-up below): AWS counts a security-group rule that
# references a prefix list against the "rules per security group" quota as
# though it were expanded to
# `data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.max_entries`
# separate rules, not as one rule. The two CloudFront-only ALB ingress rules
# (ports 80 and 443) are therefore split across two security groups below —
# `aws_security_group.alb` (443) and `aws_security_group.alb_http` (80),
# both attached to the ALB via `aws:elbv2:loadbalancer`/`SecurityGroups` in
# elastic-beanstalk.tf — so each group's prefix-list expansion counts against
# its own quota bucket instead of both landing on one group's. This narrows
# the risk (mitigation 2 from TRO-295) but does NOT eliminate it: each split
# group still individually consumes up to `max_entries` quota units, and
# CloudFront's IP-range growth over time is not addressed by the split.
# Mitigation 1 is STILL NOT verified here (no AWS credentials): before
# `apply`, check the account's actual "Rules per security group" quota in the
# VPC section of the Service Quotas console (or
# `aws service-quotas list-service-quotas --service-code vpc` and find it by
# name — do not trust a hardcoded quota code without confirming it against
# that account) against the prefix list's live `max_entries`, and request an
# increase if either group would still exceed it.

# Aurora Security Group
resource "aws_security_group" "aurora" {
  name        = "${var.project_name}-aurora"
  description = "Aurora database security group - ingress only from EB"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.project_name}-aurora"
  }
}

# Aurora ingress rule (added separately so EB can reference it)
resource "aws_security_group_rule" "aurora_ingress_from_eb" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.aurora.id
  source_security_group_id = aws_security_group.eb_instance.id
  description              = "Allow PostgreSQL from EB instances"
}

# No outbound rules for Aurora (database doesn't need outbound)

# Elastic Beanstalk Instance Security Group
resource "aws_security_group" "eb_instance" {
  name        = "${var.project_name}-eb-instance"
  description = "Elastic Beanstalk instance security group"
  vpc_id      = aws_vpc.main.id

  # Allow inbound from ALB. References only `aws_security_group.alb` (not
  # `aws_security_group.alb_http` too, post-TRO-295 split below) — AWS's
  # security-group-reference matching is based on the source ENI's group
  # membership, not on which group the rule names, so this still matches
  # traffic from the ALB once the ALB's ENI carries both `alb` and
  # `alb_http`. Listing one is sufficient and doesn't consume extra quota.
  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
    description     = "Allow HTTP from ALB"
  }

  # Allow all outbound (for package downloads, AWS API calls)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound"
  }

  tags = {
    Name = "${var.project_name}-eb-instance"
  }
}

# Application Load Balancer Security Group — HTTPS (443)
# Split from the HTTP/80 group below (TRO-295/TF-7 follow-up) purely for the
# security-group "rules per group" quota reason documented in the CAUTION
# comment above — both groups are attached to the same ALB (see
# `aws:elbv2:loadbalancer`/`SecurityGroups` in elastic-beanstalk.tf), so this
# split changes nothing about which traffic reaches the ALB: CloudFront's
# origin-facing ranges are still the only source allowed on either port.
resource "aws_security_group" "alb" {
  name        = "${var.project_name}-alb"
  description = "ALB security group - HTTPS (443) from CloudFront only"
  vpc_id      = aws_vpc.main.id

  # Allow HTTPS from CloudFront only (origin-facing managed prefix list, not
  # 0.0.0.0/0 — TF-7/TRO-278). Kept even though the custom origin config only
  # uses http_port/origin_protocol_policy=http-only today (see
  # `aws_security_group.alb_http` below for the port that actually carries
  # CloudFront's origin traffic right now), so a future switch to
  # origin_protocol_policy=https-only doesn't also require reopening this
  # security group.
  ingress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id]
    description     = "Allow HTTPS from CloudFront origin-facing ranges only"
  }

  # Allow all outbound
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound"
  }

  tags = {
    Name = "${var.project_name}-alb"
  }
}

# Application Load Balancer Security Group — HTTP (80)
# Holds the port-80 CloudFront-only ingress rule that TF-7/TRO-278 originally
# added alongside the 443 rule in `aws_security_group.alb` above; split into
# its own group here (TRO-295/TF-7 follow-up) for the same quota reason.
# Despite the "_http" name suggesting a secondary/redirect listener, this is
# the port that actually carries CloudFront's origin traffic today — the
# EB-API custom origin's `origin_protocol_policy` is `http-only`
# (s3-cloudfront.tf) — so this group is not lower-priority than `alb` above;
# both must stay attached to the ALB.
resource "aws_security_group" "alb_http" {
  name        = "${var.project_name}-alb-http"
  description = "ALB security group - HTTP (80) from CloudFront only"
  vpc_id      = aws_vpc.main.id

  # Allow HTTP from CloudFront only (origin-facing managed prefix list, not
  # 0.0.0.0/0 — TF-7/TRO-278). CloudFront redirects viewer HTTP to HTTPS
  # (`viewer_protocol_policy = "redirect-to-https"` in s3-cloudfront.tf), and the
  # CloudFront->origin leg itself uses `origin_protocol_policy = "http-only"`, so
  # port 80 here carries CloudFront's own origin traffic, not viewer HTTP.
  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id]
    description     = "Allow HTTP from CloudFront origin-facing ranges only"
  }

  # Allow all outbound. Duplicated here rather than relied on via the union
  # of both groups' rules on the ALB's shared ENI, so this group is complete
  # and correct on its own if it's ever detached or reused independently.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound"
  }

  tags = {
    Name = "${var.project_name}-alb-http"
  }
}
