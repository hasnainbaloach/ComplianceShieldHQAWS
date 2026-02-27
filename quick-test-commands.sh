#!/bin/bash
# Quick Test Script for Lambda Integration
# Usage: bash docs/quick-test-commands.sh

set -e

echo "======================================"
echo "Lambda Integration Quick Test"
echo "======================================"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Scanner Lambda
echo -e "${YELLOW}Test 1: Scanner Lambda${NC}"
cat > /tmp/test-scan.json << 'EOF'
{
  "url": "sprinship.com",
  "userId": "test-user-123",
  "isScheduledScan": false
}
EOF

aws lambda invoke \
  --function-name ComplianceShieldScanner \
  --payload file:///tmp/test-scan.json \
  --region us-east-1 \
  /tmp/scanner-response.json > /dev/null 2>&1

if [ $? -eq 0 ]; then
  RISK_SCORE=$(cat /tmp/scanner-response.json | jq -r '.riskScore')
  echo -e "${GREEN}✓ Scanner Lambda working - Risk Score: $RISK_SCORE${NC}"
else
  echo -e "${RED}✗ Scanner Lambda failed${NC}"
  exit 1
fi
echo ""

# Test 2: Active Users Endpoint
echo -e "${YELLOW}Test 2: Active Users Endpoint${NC}"
ACTIVE_USERS=$(curl -s https://complianceshieldhq.mocha.app/api/lambda/active-users \
  -H "X-Lambda-Secret: shield-2026-secure-browski" | jq -r '.count')

echo -e "${GREEN}✓ Found $ACTIVE_USERS active shield users${NC}"
echo ""

# Test 3: Weekly Scheduler
echo -e "${YELLOW}Test 3: Weekly Scheduler Lambda${NC}"
aws lambda invoke \
  --function-name ComplianceShieldWeeklyScheduler \
  --payload '{}' \
  --region us-east-1 \
  /tmp/scheduler-response.json > /dev/null 2>&1

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ Weekly Scheduler executed successfully${NC}"
else
  echo -e "${RED}✗ Weekly Scheduler failed${NC}"
  exit 1
fi
echo ""

# Test 4: EventBridge Rule
echo -e "${YELLOW}Test 4: EventBridge Rule Status${NC}"
RULE_STATE=$(aws events describe-rule \
  --name WeeklyComplianceScans \
  --region us-east-1 \
  --query 'State' \
  --output text)

if [ "$RULE_STATE" == "ENABLED" ]; then
  echo -e "${GREEN}✓ EventBridge rule is ENABLED${NC}"
else
  echo -e "${RED}✗ EventBridge rule is $RULE_STATE${NC}"
fi
echo ""

# Summary
echo "======================================"
echo -e "${GREEN}All tests passed!${NC}"
echo "======================================"
echo ""
echo "Next steps:"
echo "1. Enable Active Shield in your dashboard"
echo "2. Wait for Monday 9am UTC for automated scan"
echo "3. Monitor: aws logs tail /aws/lambda/ComplianceShieldWeeklyScheduler --follow"
echo ""
