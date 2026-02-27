# AWS Lambda Integration Testing Guide

## Pre-Test Checklist

✅ ComplianceShieldScanner Lambda deployed  
✅ ComplianceShieldWeeklyScheduler Lambda deployed  
✅ IAM roles have Bedrock + Comprehend access  
✅ EventBridge rule scheduled (Mondays 9am UTC)  
✅ Database migration ran (added is_shield_active, last_scan_date, last_risk_score)

## Test 1: Scanner Lambda Direct Invocation

Test the scanner function independently to verify Bedrock + Comprehend integration:

```bash
# Create test payload
cat > test-payload.json << 'EOF'
{
  "url": "sprinship.com",
  "userId": "test-user-123",
  "isScheduledScan": false
}
EOF

# Invoke scanner Lambda
aws lambda invoke \
  --function-name ComplianceShieldScanner \
  --payload file://test-payload.json \
  --region us-east-1 \
  scanner-response.json

# Check output
cat scanner-response.json | jq .
```

**Expected Output:**
```json
{
  "success": true,
  "riskScore": 55-65,
  "hasCookieBanner": false,
  "hasPrivacyPolicy": true,
  "hasAiFeatures": false,
  "hasAiDisclosure": false,
  "piiExposureRisk": false,
  "piiEntitiesFound": [],
  "adaIssues": false,
  "detectedIssues": ["...", "..."],
  "scanData": "{...}"
}
```

**If this fails:**
- Check Lambda logs: `aws logs tail /aws/lambda/ComplianceShieldScanner --follow`
- Verify Bedrock access: Go to AWS Console → Bedrock → Model access → Ensure Claude 3.7 Sonnet is enabled
- Verify Comprehend permissions in IAM role

---

## Test 2: Lambda → Mocha API Integration

Test the scanner's ability to write results back to Mocha database:

```bash
# Test with isScheduledScan: true (triggers save to Mocha)
cat > test-scheduled-scan.json << 'EOF'
{
  "url": "https://stripe.com",
  "userId": "YOUR_ACTUAL_USER_ID",
  "isScheduledScan": true
}
EOF

aws lambda invoke \
  --function-name ComplianceShieldScanner \
  --payload file://test-scheduled-scan.json \
  --region us-east-1 \
  scheduled-response.json

# Check scanner output
cat scheduled-response.json | jq .
```

**Verify in Mocha Dashboard:**
1. Go to https://complianceshieldhq.mocha.app/dashboard
2. Check "Scan History" tab
3. You should see a new scan for stripe.com
4. Check your user record has updated `last_scan_date` and `last_risk_score`

**If save to Mocha fails:**
- Check Lambda logs for HTTP errors calling `/api/lambda/save-scan`
- Verify environment variable `MOCHA_API_ENDPOINT=https://complianceshieldhq.mocha.app`
- Verify environment variable `LAMBDA_SECRET=shield-2026-secure-browski` matches Mocha's expected secret
- Test the endpoint directly:

```bash
curl -X POST https://complianceshieldhq.mocha.app/api/lambda/save-scan \
  -H "Content-Type: application/json" \
  -H "X-Lambda-Secret: shield-2026-secure-browski" \
  -d '{
    "userId": "YOUR_USER_ID",
    "url": "https://test.com",
    "result": {
      "success": true,
      "riskScore": 50,
      "hasCookieBanner": false,
      "hasPrivacyPolicy": true,
      "hasAiFeatures": false,
      "hasAiDisclosure": false,
      "piiExposureRisk": false,
      "piiEntitiesFound": [],
      "adaIssues": false,
      "aiRetentionIssues": false,
      "gdprIssues": true,
      "shadowAiIssues": false,
      "detectedIssues": ["Test issue"],
      "scanData": "{}"
    }
  }'
```

---

## Test 3: Active Shield Feature

Test the "Enable Shield" button in the dashboard:

1. **Login to Dashboard:**
   - Go to https://complianceshieldhq.mocha.app
   - Sign in with Google
   - Go to Dashboard

2. **Activate Shield:**
   - You should see the "Active Shield" banner
   - Click "Enable Shield" button
   - Banner should change to show "Live" status with green pulse

3. **Verify in Database:**
```bash
# Check if is_shield_active = 1 in database
# (You can check this via admin dashboard or Mocha database viewer)
```

4. **Deactivate Shield (optional):**
```bash
curl -X POST https://complianceshieldhq.mocha.app/api/shield/deactivate \
  -H "Cookie: mocha_session=YOUR_SESSION_COOKIE" \
  --cookie-jar cookies.txt
```

---

## Test 4: Weekly Scheduler Lambda

Test the scheduler that queries active users and triggers scans:

```bash
# Manual invocation of weekly scheduler
aws lambda invoke \
  --function-name ComplianceShieldWeeklyScheduler \
  --payload '{}' \
  --region us-east-1 \
  scheduler-response.json

# Watch logs in real-time
aws logs tail /aws/lambda/ComplianceShieldWeeklyScheduler --follow
```

**Expected Log Output:**
```
[Weekly Scheduler] Starting weekly compliance scans...
[Weekly Scheduler] Found 1 active shield users
[Weekly Scheduler] Scanning for user test@example.com...
[Weekly Scheduler] ✓ Scan complete for test@example.com: oldScore=50 newScore=55
[Weekly Scheduler] ✓ Weekly scan batch complete: total=1 successful=1 failed=0
```

**If no users found:**
1. Verify you have at least one user with `is_subscribed=1` AND `is_shield_active=1`
2. Verify that user has at least one scan in the database (for `last_scan_url`)
3. Test the active users endpoint:

```bash
curl https://complianceshieldhq.mocha.app/api/lambda/active-users \
  -H "X-Lambda-Secret: shield-2026-secure-browski"
```

---

## Test 5: Compliance Drift Alerts

Test email alerts when risk score increases significantly:

1. **Setup:**
   - Ensure you have a user with `is_shield_active=1`
   - Set their `last_risk_score` to 30 in database
   - Run a scan that produces risk score ≥45 (15+ point increase)

2. **Trigger Alert:**
```bash
# Create payload that will trigger drift
cat > drift-test.json << 'EOF'
{
  "url": "WEBSITE_WITH_KNOWN_ISSUES",
  "userId": "YOUR_USER_ID",
  "isScheduledScan": true
}
EOF

aws lambda invoke \
  --function-name ComplianceShieldScanner \
  --payload file://drift-test.json \
  --region us-east-1 \
  drift-response.json
```

3. **Check Email:**
   - Check your inbox for email with subject: "🚨 Compliance Alert: Risk score increased by X points"
   - Email should show old score, new score, and possible causes

4. **Verify Alert Record:**
```bash
curl https://complianceshieldhq.mocha.app/api/admin/stats \
  -H "X-Admin-Password: Christmas890" | jq .
```

---

## Test 6: EventBridge Automatic Trigger

Test the scheduled weekly scan:

1. **Check EventBridge Rule Status:**
```bash
aws events describe-rule \
  --name WeeklyComplianceScans \
  --region us-east-1
```

Should show:
```json
{
  "Name": "WeeklyComplianceScans",
  "Arn": "...",
  "State": "ENABLED",
  "ScheduleExpression": "cron(0 9 ? * MON *)"
}
```

2. **Test Immediate Trigger (optional):**

Instead of waiting for Monday 9am, you can manually trigger:

```bash
# Temporarily change schedule to run in 2 minutes
CURRENT_TIME=$(date -u +"%M")
NEXT_MINUTE=$(( ($CURRENT_TIME + 2) % 60 ))

aws events put-rule \
  --name WeeklyComplianceScans \
  --schedule-expression "cron($NEXT_MINUTE * * * ? *)" \
  --state ENABLED \
  --region us-east-1

# Wait 2 minutes, then check logs
sleep 120
aws logs tail /aws/lambda/ComplianceShieldWeeklyScheduler --follow

# Change back to Monday schedule
aws events put-rule \
  --name WeeklyComplianceScans \
  --schedule-expression "cron(0 9 ? * MON *)" \
  --state ENABLED \
  --region us-east-1
```

3. **Monitor Next Scheduled Run:**
```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/Events \
  --metric-name Invocations \
  --dimensions Name=RuleName,Value=WeeklyComplianceScans \
  --start-time $(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 86400 \
  --statistics Sum \
  --region us-east-1
```

---

## Test 7: PII Detection with Comprehend

Test the Comprehend integration for PII exposure detection:

```bash
# Test on a site likely to have exposed PII (or create test page)
cat > pii-test.json << 'EOF'
{
  "url": "WEBSITE_WITH_CONTACT_INFO",
  "userId": "test-user",
  "isScheduledScan": false
}
EOF

aws lambda invoke \
  --function-name ComplianceShieldScanner \
  --payload file://pii-test.json \
  --region us-east-1 \
  pii-response.json

# Check if PII was detected
cat pii-response.json | jq '{
  piiExposureRisk, 
  piiEntitiesFound, 
  riskScore
}'
```

**Expected output if PII found:**
```json
{
  "piiExposureRisk": true,
  "piiEntitiesFound": ["EMAIL", "PHONE"],
  "riskScore": 85
}
```

---

## Troubleshooting Guide

### Scanner Lambda Timeout
```bash
# Increase timeout to 300 seconds
aws lambda update-function-configuration \
  --function-name ComplianceShieldScanner \
  --timeout 300 \
  --region us-east-1
```

### Bedrock Access Denied
1. Go to AWS Console → Bedrock → Model access
2. Request access to Claude 3.7 Sonnet
3. Wait 5-10 minutes for approval
4. Retry test

### Comprehend Errors
```bash
# Check IAM policy has comprehend:DetectPiiEntities
aws iam get-role-policy \
  --role-name ComplianceShieldLambdaRole \
  --policy-name YourPolicyName \
  --region us-east-1
```

### Lambda → Mocha Connection Fails
- Verify `MOCHA_API_ENDPOINT` in Lambda environment
- Verify `LAMBDA_SECRET` matches on both sides
- Test endpoint with curl (see Test 2)
- Check Mocha backend logs for incoming requests

### EventBridge Not Triggering
```bash
# Check Lambda has permission for EventBridge
aws lambda get-policy \
  --function-name ComplianceShieldWeeklyScheduler \
  --region us-east-1

# Should show events.amazonaws.com in Principal
```

---

## Success Criteria

✅ Scanner Lambda returns valid scan results  
✅ Bedrock (Claude 3.7) successfully analyzes websites  
✅ Comprehend detects PII entities  
✅ Scan results save to Mocha database  
✅ "Enable Shield" button works in dashboard  
✅ Weekly scheduler finds active users  
✅ Weekly scheduler invokes scanner for each user  
✅ Email alerts sent when risk score increases ≥15 points  
✅ EventBridge triggers scheduler on Monday 9am UTC  

---

## Cost Monitoring

Track your AWS costs:

```bash
# Check Lambda invocation count
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Invocations \
  --dimensions Name=FunctionName,Value=ComplianceShieldScanner \
  --start-time $(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 2592000 \
  --statistics Sum \
  --region us-east-1

# Expected monthly costs (100 active users):
# - Lambda: ~$0.10/month
# - Bedrock: ~$8/month (400 scans × $0.02)
# - Comprehend: ~$2/month (400 scans × $0.005)
# Total: ~$10/month
```
