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

  # Allow inbound from ALB
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

# Application Load Balancer Security Group
resource "aws_security_group" "alb" {
  name        = "${var.project_name}-alb"
  description = "ALB security group - public access"
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

  # Allow HTTPS from CloudFront only (same prefix list). Kept even though the
  # custom origin config only uses http_port/origin_protocol_policy=http-only
  # today, so a future switch to origin_protocol_policy=https-only doesn't also
  # require reopening this security group.
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
