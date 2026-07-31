output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "Private subnet IDs"
  value       = aws_subnet.private[*].id
}

output "public_subnet_ids" {
  description = "Public subnet IDs"
  value       = aws_subnet.public[*].id
}

output "aurora_cluster_endpoint" {
  description = "Aurora cluster endpoint"
  value       = aws_rds_cluster.aurora.endpoint
}

output "aurora_cluster_reader_endpoint" {
  description = "Aurora cluster reader endpoint"
  value       = aws_rds_cluster.aurora.reader_endpoint
}

output "database_name" {
  description = "Database name"
  value       = aws_rds_cluster.aurora.database_name
}

output "database_url_ssm_parameter" {
  description = "SSM parameter name for DATABASE_URL"
  value       = aws_ssm_parameter.database_url.name
}

output "cors_origin_ssm_parameter" {
  description = "SSM parameter name for CORS_ORIGIN"
  value       = aws_ssm_parameter.cors_origin.name
}

output "s3_bucket_name" {
  description = "S3 bucket for frontend"
  value       = aws_s3_bucket.frontend.id
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = aws_cloudfront_distribution.frontend.id
}

output "cloudfront_domain_name" {
  description = "CloudFront domain name"
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "frontend_url" {
  description = "Frontend URL (use this to access the application)"
  value       = var.app_domain_name != "" ? "https://${var.app_domain_name}" : "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "api_url" {
  description = "API URL (use this after EB deployment)"
  value       = var.api_domain_name != "" ? "https://${var.api_domain_name}" : "Set after EB environment creation"
}

# Output for EB CLI configuration
output "eb_config_summary" {
  description = "Configuration values for EB CLI setup"
  value = {
    application_name        = aws_elastic_beanstalk_application.api.name
    instance_profile        = aws_iam_instance_profile.eb.name
    service_role_arn        = aws_iam_role.eb_service.arn
    vpc_id                  = aws_vpc.main.id
    private_subnets         = join(",", aws_subnet.private[*].id)
    public_subnets          = join(",", aws_subnet.public[*].id)
    instance_security_group = aws_security_group.eb_instance.id
    alb_security_group      = aws_security_group.alb.id
    alb_http_security_group = aws_security_group.alb_http.id
  }
}

output "uploads_bucket_name" {
  description = "S3 bucket for file uploads"
  value       = aws_s3_bucket.uploads.id
}

output "uploads_bucket_arn" {
  description = "S3 bucket ARN for file uploads"
  value       = aws_s3_bucket.uploads.arn
}

