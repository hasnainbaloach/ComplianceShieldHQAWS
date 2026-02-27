# Compliance Shield - Deployment Guide

## AWS Lambda Deployment

### Prerequisites
1. AWS Account with Bedrock access (Claude 3.7 Sonnet)
2. IAM permissions for Lambda, Bedrock, Comprehend, EventBridge
3. Firecrawl API key

### Step 1: Deploy Scanner Lambda

```bash
# Package Lambda function
cd src/lambda
zip -r scanner.zip scanner-function.ts package.json node_modules/

# Upload via AWS Console or CLI
aws lambda create-function \
  --function-name compliance-shield-scanner \
  --runtime nodejs18.x \
  --handler scanner-function.handler \
  --zip-file fileb://scanner.zip \
  --role arn:aws:iam::YOUR_ACCOUNT:role/lambda-execution-role \
  --timeout 180 \
  --memory-size 512 \
  --environment Variables={
    AWS_REGION=us-east-1,
    FIRECRAWL_API_KEY=your_key,
    API_ENDPOINT=https://complianceshieldhq.com,
    LAMBDA_SECRET=your_secret
  }
```

### Step 2: Deploy Weekly Scheduler Lambda

```bash
# Package scheduler
cd src/lambda
zip -r scheduler.zip weekly-scheduler.ts package.json node_modules/

# Upload
aws lambda create-function \
  --function-name compliance-shield-scheduler \
  --runtime nodejs18.x \
  --handler weekly-scheduler.handler \
  --zip-file fileb://scheduler.zip \
  --role arn:aws:iam::YOUR_ACCOUNT:role/lambda-execution-role \
  --timeout 300 \
  --memory-size 256 \
  --environment Variables={
    AWS_REGION=us-east-1,
    API_ENDPOINT=https://complianceshieldhq.com,
    LAMBDA_SECRET=your_secret,
    SCANNER_LAMBDA_ARN=arn:aws:lambda:us-east-1:YOUR_ACCOUNT:function:compliance-shield-scanner
  }
```

### Step 3: Configure EventBridge

```bash
# Create EventBridge rule for weekly monitoring
aws events put-rule \
  --name compliance-shield-weekly-scan \
  --schedule-expression "cron(0 9 ? * MON *)" \
  --description "Weekly compliance monitoring - Every Monday 9am UTC"

# Add Lambda target
aws events put-targets \
  --rule compliance-shield-weekly-scan \
  --targets "Id"="1","Arn"="arn:aws:lambda:us-east-1:YOUR_ACCOUNT:function:compliance-shield-scheduler"
```

### Step 4: Bedrock Model Access

1. Navigate to AWS Bedrock Console (us-east-1)
2. Go to "Model access"
3. Request access to: `us.anthropic.claude-3-7-sonnet-20250219-v1:0`
4. Wait for approval (24-48 hours)

### Step 5: Test Scanner

```bash
# Invoke scanner directly
aws lambda invoke \
  --function-name compliance-shield-scanner \
  --payload '{"url":"https://google.com","userId":"test","isScheduledScan":false}' \
  response.json

cat response.json
```

## Cloudflare Workers Deployment

### Deploy via Mocha Platform
1. Go to app Settings
2. Click "Publish to Production"
3. Configure custom domain (complianceshieldhq.com)
4. Add secrets in Settings → Secrets:
   - AWS_ACCESS_KEY_ID
   - AWS_SECRET_ACCESS_KEY
   - AWS_REGION
   - FIRECRAWL_API_KEY
   - STRIPE_SECRET_KEY
   - LAMBDA_SCANNER_ARN
   - LAMBDA_SECRET

### Environment Variables

Copy `.env.example` to `.env` and fill in all values before deployment.

## Database Migrations

Migrations run automatically on deployment. To manually apply:

```bash
# Connect to D1 database
wrangler d1 execute DB --file=src/migrations/0001_initial.sql
```

## Monitoring

### CloudWatch Logs
- Scanner Lambda: `/aws/lambda/compliance-shield-scanner`
- Scheduler Lambda: `/aws/lambda/compliance-shield-scheduler`

### Metrics to Watch
- Lambda invocation count
- Bedrock request latency
- Comprehend API calls
- Error rate
- Cost per scan

## Cost Optimization

- Use reserved concurrency on Lambda
- Enable Bedrock provisioned throughput if >10K scans/month
- Cache Firecrawl results for 24 hours
- Batch EventBridge invocations

## Security Checklist

- ✅ All secrets in environment variables
- ✅ IAM roles follow least privilege
- ✅ Lambda VPC configuration (optional)
- ✅ API authentication with LAMBDA_SECRET
- ✅ HTTPS only (no HTTP)
- ✅ CORS restricted to production domain
