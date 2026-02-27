# Manual User Account Deletion Guide

## Overview
This guide explains how to manually delete a user account and all associated data from the production database. This is useful for handling customer support requests or compliance requirements like GDPR/CCPA right-to-deletion requests.

## IMPORTANT: Data Deletion is Permanent
⚠️ **WARNING**: Deleting a user account permanently removes ALL data associated with that user. This action cannot be undone. Always confirm the user's identity and request before proceeding.

## What Gets Deleted
When you delete a user account, the following data is permanently removed:
1. User profile and authentication data (users table)
2. All compliance scans (scans table)
3. Monitoring preferences (monitoring_preferences table)
4. Remediation checklist progress (checklist_progress table)
5. Intent tracking events (intent_events table)
6. Uploaded governance documents (governance_documents table + R2 storage)
7. Shield certifications (shield_certifications table)
8. Anonymous scan attempts (scan_attempts table)

## How to Delete a User Account Manually

### Step 1: Find the User ID
First, locate the user's ID using their email address:

```sql
SELECT id, email, is_subscribed, stripe_customer_id 
FROM users 
WHERE email = 'user@example.com';
```

**Important**: Note the `stripe_customer_id` if the user has an active subscription. You may need to cancel their subscription in Stripe separately.

### Step 2: Delete All User Data
Execute the following SQL statements **in order** (replace `USER_ID_HERE` with the actual user ID):

```sql
-- Delete governance documents (Note: R2 files must be deleted separately - see below)
DELETE FROM governance_documents WHERE user_id = 'USER_ID_HERE';

-- Delete shield certifications
DELETE FROM shield_certifications WHERE user_id = 'USER_ID_HERE';

-- Delete checklist progress
DELETE FROM checklist_progress WHERE user_id = 'USER_ID_HERE';

-- Delete monitoring preferences
DELETE FROM monitoring_preferences WHERE user_id = 'USER_ID_HERE';

-- Delete intent events
DELETE FROM intent_events WHERE user_id = 'USER_ID_HERE';

-- Delete scans
DELETE FROM scans WHERE user_id = 'USER_ID_HERE';

-- Delete scan attempts (if you want to remove anonymous tracking too)
DELETE FROM scan_attempts WHERE user_id = 'USER_ID_HERE';

-- Finally, delete the user account itself
DELETE FROM users WHERE id = 'USER_ID_HERE';
```

### Step 3: Delete R2 Storage Files
If the user uploaded governance documents, you must also delete their files from R2 storage. 

**Current Limitation**: The app does not have a UI for bulk R2 deletion. Files are stored in R2 with keys like `governance-docs/USER_ID/filename.pdf`. You'll need to:
1. Use the Cloudflare dashboard to access your R2 bucket
2. Navigate to the `governance-docs/USER_ID/` folder
3. Manually delete all files

Alternatively, you can use the Cloudflare R2 API or wrangler CLI:
```bash
wrangler r2 object delete R2_BUCKET/governance-docs/USER_ID/filename.pdf
```

### Step 4: Cancel Stripe Subscription (if applicable)
If the user had an active subscription (is_subscribed = 1), you should cancel it in Stripe:
1. Log into your Stripe dashboard
2. Search for the customer using the `stripe_customer_id`
3. Cancel their subscription
4. Optionally, delete the customer record in Stripe

## Self-Service Deletion
Users can delete their own accounts through the app:
1. Go to Dashboard → Account Settings
2. Click "Delete Account"
3. Type "DELETE" to confirm
4. Click "Permanently Delete Account"

This triggers the same deletion process via the `/api/users/me` DELETE endpoint.

## Compliance Notes
- **GDPR**: Users have the "right to erasure" under Article 17. You must respond to deletion requests within 30 days.
- **CCPA**: Users can request deletion of their personal information. You must respond within 45 days.
- **Audit Trail**: Consider logging deletion requests (who deleted, when, which user) for compliance purposes. Currently the app does not do this automatically.

## Support
For questions or issues with manual deletions, contact the development team.
