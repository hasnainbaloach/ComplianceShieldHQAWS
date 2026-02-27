# Compliance Shield Testing Checklist

## Pre-Launch Testing Guide

### Test Set 1: Anonymous Visitor Flow (5 test accounts)

**Objective**: Verify scan engine works for non-authenticated users

- [ ] Visit homepage on desktop
- [ ] Enter google.com → Verify risk score ~85-90 (low risk)
- [ ] Enter unknownsite.com → Verify risk score 30-70 (high risk)
- [ ] Enter competitor site → Verify scan completes in <60 seconds
- [ ] Test mobile responsiveness (sticky CTA, readable text)
- [ ] Verify scan preview image loads correctly
- [ ] Test invalid URL (e.g., "test") → Should show error toast
- [ ] Test URL without protocol (e.g., "google.com") → Should normalize to https://

**Expected Results**: All scans complete successfully, risk scores make sense, mobile UI works

---

### Test Set 2: Free User Post-Scan (5 test accounts)

**Objective**: Verify authentication flow and session persistence

- [ ] Complete scan as anonymous user
- [ ] Click "Login with Google" → Authenticate
- [ ] Verify redirect back to scan results page (NOT dashboard)
- [ ] Verify scan data displays without re-scanning
- [ ] Click "Unlock My Shield & Templates" button
- [ ] Verify Stripe checkout opens with correct email pre-filled
- [ ] Abandon checkout (close tab) → Return to app
- [ ] Verify can return to dashboard without losing data

**Expected Results**: No double-scan needed, session persists across auth, checkout works

---

### Test Set 3: Payment & Subscription (5 test accounts)

**Objective**: Verify Stripe integration and webhook handling

- [ ] Complete scan → Login → Click subscribe
- [ ] Use Stripe test card: 4242 4242 4242 4242
- [ ] Complete checkout → Return to app
- [ ] Wait 30 seconds for webhook to process
- [ ] Check users table: `is_subscribed` should be 1
- [ ] If not subscribed, click "Sync Subscription Status" button
- [ ] Verify all dashboard tabs unlock (no "Subscribe to unlock" messages)
- [ ] Check email inbox for welcome + payment confirmation emails

**Expected Results**: Subscription activates, emails arrive, all features unlock

---

### Test Set 4: Subscriber Features (5 test accounts)

**Objective**: Verify all paid features work correctly

**Remediation Checklist:**
- [ ] Open Dashboard → Audit Results tab
- [ ] Check first checklist item (ADA Alt-Text)
- [ ] Refresh page → Verify checkbox state persists
- [ ] Complete all 5 items → Verify success animation
- [ ] Check database: `checklist_progress` table should have 5 rows

**Legal Templates:**
- [ ] Open Legal Templates tab
- [ ] Generate AI Disclosure → Verify company name pre-filled
- [ ] Click "Copy to Clipboard" → Paste in notepad
- [ ] Generate Privacy Policy → Verify content looks correct
- [ ] Download as .txt file → Verify file saves

**Document Vault:**
- [ ] Open Document Vault tab
- [ ] Upload a test PDF (under 10MB)
- [ ] Verify file appears in list with correct name/size
- [ ] Click download → Verify file downloads correctly
- [ ] Delete file → Verify removed from list
- [ ] Check R2 bucket to confirm file removed

**Shield Certification:**
- [ ] Open Shield Certification tab
- [ ] Create certification with company name
- [ ] Copy public verification URL
- [ ] Open in incognito window → Verify page loads
- [ ] Verify certification shows company name + risk score
- [ ] Check page is publicly accessible (no login required)

**Expected Results**: All features work, data persists, files upload/download

---

### Test Set 5: Email Notifications (Test in production only)

**Objective**: Verify retention emails send correctly

**Welcome Email:**
- [ ] New user subscribes
- [ ] Check inbox within 5 minutes
- [ ] Verify subject: "Welcome to Compliance Shield - Your Protection Starts Now"
- [ ] Verify email contains link to dashboard
- [ ] Check spam folder if not in inbox

**Scan Alert Email:**
- [ ] Subscriber scans a site with risk score < 85
- [ ] Save scan (triggers POST /api/scans)
- [ ] Check inbox within 5 minutes
- [ ] Verify subject: "Compliance Alert: X Issues Detected on [domain]"
- [ ] Verify email shows risk score and issue count

**Payment Confirmation:**
- [ ] New subscription payment processed
- [ ] Check inbox within 5 minutes
- [ ] Verify subject: "Payment Confirmed - Compliance Shield Pro Active"
- [ ] Verify email shows $49.00 amount

**Expected Results**: All emails deliver within 5 minutes, formatting looks correct

---

### Edge Case Testing

**Test Case 1: Stale localStorage**
- [ ] Scan site → Save to localStorage
- [ ] Wait 24 hours
- [ ] Return to site → Verify old scan data cleared
- [ ] Enter new URL → Verify fresh scan runs

**Test Case 2: Canceled Subscription**
- [ ] Subscribe → Complete a scan
- [ ] Cancel subscription in Stripe dashboard
- [ ] Wait for webhook to process
- [ ] Return to app → Verify subscription status updates
- [ ] Verify features lock behind paywall again

**Test Case 3: Slow Network**
- [ ] Open DevTools → Network → Throttle to Slow 3G
- [ ] Run scan → Verify loading state shows
- [ ] Wait for 60+ seconds
- [ ] Verify either completes or shows timeout error

**Test Case 4: Blocked Cookies**
- [ ] Open incognito → Block third-party cookies
- [ ] Visit site → Verify cookie consent banner shows
- [ ] Click "Accept" or "Decline" → Verify banner dismisses
- [ ] Run scan → Verify localStorage fallback works

**Test Case 5: Multiple Browsers**
- [ ] Login on Chrome → Complete scan
- [ ] Open Safari → Login with same account
- [ ] Verify subscription status syncs
- [ ] Verify checklist progress syncs across browsers

---

## Production Monitoring (First 50 Signups)

**Metrics to Track:**
- [ ] Scan completion rate (scans started vs completed)
- [ ] Scan-to-login conversion (anonymous scans vs logins)
- [ ] Login-to-subscribe conversion (logins vs subscriptions)
- [ ] Average time from scan to subscribe
- [ ] Email delivery rate (check bounce/spam rates)
- [ ] Stripe webhook success rate (check Stripe dashboard)

**Error Monitoring:**
- [ ] Check browser console for JavaScript errors
- [ ] Monitor Cloudflare Workers logs for backend errors
- [ ] Watch for failed Stripe webhooks in Stripe dashboard
- [ ] Check email service logs for delivery failures

**Customer Support Queries (Expected):**
- "I paid but features are still locked" → Sync Subscription Status button
- "My scan score seems wrong" → Explain scanner limitations + manual review
- "Where's my email?" → Check spam folder, verify email service configured
- "Can I cancel?" → Yes, no long-term contracts

---

## Known Issues (Not Bugs)

1. **Scanner may show general assessment instead of detailed scan**
   - Happens when Firecrawl/OpenAI unavailable or API keys missing
   - Fallback provides industry benchmark estimate
   - Expected behavior, not a failure

2. **Stripe webhook can take 5-30 seconds**
   - Not instant - users may see "Subscribe to unlock" briefly
   - "Sync Subscription Status" button provides manual recovery
   - Monitor webhook delivery in Stripe dashboard

3. **Dev preview data doesn't transfer to production**
   - Development and published app use separate databases
   - Migrations run on publish but don't copy data
   - This is a platform limitation, not a bug

4. **Email notifications require EMAILS binding**
   - May need to configure in Mocha dashboard
   - If emails don't send, check binding configuration
   - Feature gracefully degrades if unavailable

---

## Launch Readiness Criteria

- [ ] All 20 test scenarios pass (4 tests × 5 accounts each)
- [ ] Stripe test mode works correctly
- [ ] Stripe live mode configured and tested
- [ ] Email notifications deliver successfully
- [ ] Google Analytics tracking verified
- [ ] Mobile experience tested on iOS + Android
- [ ] Privacy Policy + Terms of Service reviewed
- [ ] Contact form sends emails to info@hikmahspark.com
- [ ] Published app loads without errors
- [ ] All secrets configured in production

**When all checkboxes complete → READY TO LAUNCH 🚀**
