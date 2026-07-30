# Elastic Beanstalk Application
resource "aws_elastic_beanstalk_application" "api" {
  name        = "${var.project_name}-api"
  description = "Ship API - Express + WebSocket collaboration server"

  tags = {
    Name = "${var.project_name}-api"
  }
}

# EB Instance IAM Role
resource "aws_iam_role" "eb_instance" {
  name = "${var.project_name}-eb-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Name = "${var.project_name}-eb-instance-role"
  }
}

# Attach AWS managed policies
resource "aws_iam_role_policy_attachment" "eb_web_tier" {
  role       = aws_iam_role.eb_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier"
}

resource "aws_iam_role_policy_attachment" "eb_worker_tier" {
  role       = aws_iam_role.eb_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AWSElasticBeanstalkWorkerTier"
}

resource "aws_iam_role_policy_attachment" "eb_multicontainer_docker" {
  role       = aws_iam_role.eb_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AWSElasticBeanstalkMulticontainerDocker"
}

# Instance Profile
resource "aws_iam_instance_profile" "eb" {
  name = "${var.project_name}-eb-instance-profile"
  role = aws_iam_role.eb_instance.name

  tags = {
    Name = "${var.project_name}-eb-instance-profile"
  }
}

# EB Service Role
resource "aws_iam_role" "eb_service" {
  name = "${var.project_name}-eb-service-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "elasticbeanstalk.amazonaws.com"
        }
        Action = "sts:AssumeRole"
        Condition = {
          StringEquals = {
            "sts:ExternalId" = "elasticbeanstalk"
          }
        }
      }
    ]
  })

  tags = {
    Name = "${var.project_name}-eb-service-role"
  }
}

resource "aws_iam_role_policy_attachment" "eb_service_policy" {
  role       = aws_iam_role.eb_service.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSElasticBeanstalkEnhancedHealth"
}

resource "aws_iam_role_policy_attachment" "eb_service_managed" {
  role       = aws_iam_role.eb_service.name
  policy_arn = "arn:aws:iam::aws:policy/AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy"
}

# Elastic Beanstalk Environment
resource "aws_elastic_beanstalk_environment" "api" {
  name                = "${var.project_name}-api-prod"
  application         = aws_elastic_beanstalk_application.api.name
  solution_stack_name = "64bit Amazon Linux 2023 v4.9.0 running Docker"

  # VPC Configuration
  setting {
    namespace = "aws:ec2:vpc"
    name      = "VPCId"
    value     = aws_vpc.main.id
  }

  setting {
    namespace = "aws:ec2:vpc"
    name      = "Subnets"
    value     = join(",", aws_subnet.private[*].id)
  }

  setting {
    namespace = "aws:ec2:vpc"
    name      = "ELBSubnets"
    value     = join(",", aws_subnet.public[*].id)
  }

  setting {
    namespace = "aws:ec2:vpc"
    name      = "ELBScheme"
    value     = "public"
  }

  setting {
    namespace = "aws:ec2:vpc"
    name      = "AssociatePublicIpAddress"
    value     = "false"
  }

  # Instance Configuration
  setting {
    namespace = "aws:autoscaling:launchconfiguration"
    name      = "IamInstanceProfile"
    value     = aws_iam_instance_profile.eb.name
  }

  setting {
    namespace = "aws:autoscaling:launchconfiguration"
    name      = "InstanceType"
    value     = "t3.small"
  }

  setting {
    namespace = "aws:autoscaling:launchconfiguration"
    name      = "SecurityGroups"
    value     = aws_security_group.eb_instance.id
  }

  setting {
    namespace = "aws:autoscaling:launchconfiguration"
    name      = "DisableIMDSv1"
    value     = "true"
  }

  # Auto Scaling
  setting {
    namespace = "aws:autoscaling:asg"
    name      = "MinSize"
    value     = "1"
  }

  setting {
    namespace = "aws:autoscaling:asg"
    name      = "MaxSize"
    value     = "4"
  }

  # DDoS protection: Auto-scaling triggers based on CPU utilization
  # Scale up at 70% CPU to absorb DDoS traffic with additional capacity
  # Ported from modules/elastic-beanstalk/main.tf (TRO-235 / TF-2) — present in
  # the modular path's environment but missing here before this change.
  setting {
    namespace = "aws:autoscaling:trigger"
    name      = "MeasureName"
    value     = "CPUUtilization"
  }

  setting {
    namespace = "aws:autoscaling:trigger"
    name      = "Statistic"
    value     = "Average"
  }

  setting {
    namespace = "aws:autoscaling:trigger"
    name      = "Unit"
    value     = "Percent"
  }

  setting {
    namespace = "aws:autoscaling:trigger"
    name      = "UpperThreshold"
    value     = "70"
  }

  setting {
    namespace = "aws:autoscaling:trigger"
    name      = "UpperBreachScaleIncrement"
    value     = "1"
  }

  setting {
    namespace = "aws:autoscaling:trigger"
    name      = "LowerThreshold"
    value     = "20"
  }

  setting {
    namespace = "aws:autoscaling:trigger"
    name      = "LowerBreachScaleIncrement"
    value     = "-1"
  }

  # Cooldown period to prevent scaling thrashing (6 minutes)
  setting {
    namespace = "aws:autoscaling:asg"
    name      = "Cooldown"
    value     = "360"
  }

  # Load Balancer
  setting {
    namespace = "aws:elasticbeanstalk:environment"
    name      = "EnvironmentType"
    value     = "LoadBalanced"
  }

  setting {
    namespace = "aws:elasticbeanstalk:environment"
    name      = "LoadBalancerType"
    value     = "application"
  }

  setting {
    namespace = "aws:elasticbeanstalk:environment"
    name      = "ServiceRole"
    value     = aws_iam_role.eb_service.arn
  }

  setting {
    namespace = "aws:elbv2:loadbalancer"
    name      = "SecurityGroups"
    value     = aws_security_group.alb.id
  }

  # Rolling Deployment with Additional Batch (zero-downtime)
  setting {
    namespace = "aws:elasticbeanstalk:command"
    name      = "DeploymentPolicy"
    value     = "RollingWithAdditionalBatch"
  }

  setting {
    namespace = "aws:elasticbeanstalk:command"
    name      = "BatchSizeType"
    value     = "Fixed"
  }

  setting {
    namespace = "aws:elasticbeanstalk:command"
    name      = "BatchSize"
    value     = "1"
  }

  setting {
    namespace = "aws:elasticbeanstalk:command"
    name      = "Timeout"
    value     = "600"
  }

  # Environment Variables
  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "NODE_ENV"
    value     = "production"
  }

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "ENVIRONMENT"
    value     = "prod"
  }

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "PORT"
    value     = "80"
  }

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "AWS_REGION"
    value     = var.aws_region
  }

  # Trust-proxy hop count for `req.ip` (finding TF-7 / TRO-278). This
  # environment's real chain is `client -> CloudFront (terraform/s3-cloudfront.tf's
  # EB-API custom origin) -> this ALB -> Express` — TWO reverse-proxy hops — paired
  # with `terraform/security-groups.tf` restricting the ALB security group to
  # CloudFront's origin-facing prefix list (same PR). Only correct together: `2`
  # with the SG still open to 0.0.0.0/0 would let a client that bypasses
  # CloudFront plant a decoy X-Forwarded-For entry that gets trusted as though it
  # were CloudFront's. See `api/src/app.ts`'s `resolveTrustProxyHops` for the
  # fallback behavior on an invalid value, and CHANGES.md (TRO-278) for why the
  # default (unset, used by Render and local dev) is 1, not 2. This blueprint is
  # repo hygiene only — the live deployment is Render, and this environment is not
  # planned to be applied.
  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "TRUST_PROXY_HOPS"
    value     = "2"
  }

  # Health Check Path
  setting {
    namespace = "aws:elasticbeanstalk:environment:process:default"
    name      = "HealthCheckPath"
    value     = "/health"
  }

  # Health Reporting
  setting {
    namespace = "aws:elasticbeanstalk:healthreporting:system"
    name      = "SystemType"
    value     = "enhanced"
  }

  # Ignore version_label changes (managed by deploy script)
  lifecycle {
    ignore_changes = [
      version_label,
    ]
  }

  tags = {
    Name = "${var.project_name}-api-prod"
  }
}

output "eb_application_name" {
  description = "Elastic Beanstalk application name"
  value       = aws_elastic_beanstalk_application.api.name
}

output "eb_environment_name" {
  description = "Elastic Beanstalk environment name"
  value       = aws_elastic_beanstalk_environment.api.name
}

output "eb_environment_url" {
  description = "Elastic Beanstalk environment URL"
  value       = aws_elastic_beanstalk_environment.api.endpoint_url
}

output "eb_instance_profile" {
  description = "Instance profile for EB instances"
  value       = aws_iam_instance_profile.eb.name
}

output "eb_service_role" {
  description = "Service role ARN for EB"
  value       = aws_iam_role.eb_service.arn
}

output "eb_vpc_id" {
  description = "VPC ID for EB environment"
  value       = aws_vpc.main.id
}

output "eb_private_subnets" {
  description = "Private subnet IDs for EB instances"
  value       = join(",", aws_subnet.private[*].id)
}

output "eb_public_subnets" {
  description = "Public subnet IDs for ALB"
  value       = join(",", aws_subnet.public[*].id)
}

output "eb_instance_security_group" {
  description = "Security group for EB instances"
  value       = aws_security_group.eb_instance.id
}

output "eb_alb_security_group" {
  description = "Security group for ALB"
  value       = aws_security_group.alb.id
}
