---
name: ship-deploy
description: >-
  Deploy Ship to AWS — API to Elastic Beanstalk, frontend to S3 + CloudFront — as one paired
  operation, with the health-polling sequence that decides when it is actually done. Use when asked
  to deploy, ship, or release Ship, or to check whether a deploy has finished. "Deploy" always means
  both halves; deploying one alone leaves the API and frontend out of sync.
---

# Ship Deployment

Deploy Ship API and frontend to AWS.

## Critical Rule

**"Deploy" means deploy BOTH API and frontend.** Never deploy just one - they must stay in sync.

## Full Deploy Sequence

```bash
# 1. Deploy API
./scripts/deploy.sh

# 2. Monitor API until healthy (poll every 30s until Green/Ready)
aws elasticbeanstalk describe-environments --environment-names ship-api-prod --query 'Environments[0].[Health,HealthStatus,Status]'

# 3. Deploy frontend
pnpm build:web
aws s3 sync web/dist/ s3://$(cd terraform && terraform output -raw s3_bucket_name)/ --delete
aws cloudfront create-invalidation --distribution-id $(cd terraform && terraform output -raw cloudfront_distribution_id) --paths "/*"

# 4. Wait for CloudFront invalidation to complete
aws cloudfront get-invalidation --distribution-id DIST_ID --id INVALIDATION_ID --query 'Invalidation.Status'
```

## Monitoring

**Poll every 30 seconds** until Status is `Ready` and Health is `Green`.

During rolling updates, temporary `Red/Degraded` status is normal while old instances drain. Don't report "done" until both API and frontend are fully deployed.

## Details

| Component | Strategy | Duration |
|-----------|----------|----------|
| API | RollingWithAdditionalBatch | 3-5 min |
| Frontend | S3 sync + CloudFront invalidation | 30-60 sec |

- ALB health check hits `/health` endpoint
- Frontend deploys to S3, served via CloudFront
