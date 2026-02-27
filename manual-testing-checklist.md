# Manual Testing Checklist for Compliance Shield

## CRITICAL: I cannot create real test accounts or perform live OAuth testing. You must test these flows yourself.

## Test Flow 1: Anonymous User → Scan → Login → Payment

### Steps:
1. Open https://complianceshieldhq.mocha.app in incognito browser
2. Enter a URL (e.g., "google.com") and click "Scan My Site"
3. Wait for scan to complete (shows 4 scanning steps, ~6 seconds)
4. Verify scan results display with risk score
5. Click "Preview My Free Checklist" button
6. Verify free checklist shows 2 unlocked + 3 locked tasks
7. Click "Login with Google to Unlock Your Full Shield" button
8. Complete Google OAuth login
9. **EXPECTED:** Should redirect to Stripe checkout
10. **VERIFY:** After payment, webhook should update subscription status

### What to check:
- [ ] Scan completes without errors
- [ ] Risk score displays correctly
- [ ] Login button triggers Google OAuth
- [ ] After login, redirects to checkout (NOT homepage)
- [ ] Stripe checkout session loads
- [ ] After payment, user shows as subscribed in dashboard

---

## Test Flow 2: Anonymous User → Login First → Dashboard

### Steps:
1. Open homepage in incognito
2. Click "Get Started" (top right)
3. Complete Google login
4. **EXPECTED:** Redirects to /dashboard
5. Verify "Subscribe Now" section shows (yellow warning box)
6. Click "Subscribe Now" button
7. Complete Stripe checkout

### What to check:
- [ ] Login redirects to dashboard (NOT homepage)
- [ ] Dashboard loads for non-subscriber
- [ ] Subscribe button works
- [ ] After payment, subscription activates

---

## Test Flow 3: Existing Subscriber → Login → Dashboard

### Steps:
1. Login as user who already paid
2. **EXPECTED:** Dashboard shows "Active Shield Status" banner
3. Verify all 4 tabs accessible: Audit Results, Legal Templates, Trust Badge, Governance Vault
4. Try each feature

### What to check:
- [ ] Green "Active Shield" banner displays
- [ ] All tabs load without errors
- [ ] Checklist items can be checked/unchecked
- [ ] Policy generator creates documents
- [ ] Badge generator works
- [ ] Vault allows file upload

---

## Test Flow 4: Scan → Login Mid-Flow → Resume

### Steps:
1. Scan a URL as anonymous user
2. View free checklist preview
3. Click login button
4. Complete Google login
5. **EXPECTED:** Returns to scan results OR checkout
6. Should NOT lose scan data

### What to check:
- [ ] Scan data persists after login
- [ ] User doesn't have to re-scan
- [ ] Flow continues logically

---

## Test Flow 5: Stripe Webhook

### Steps:
1. Complete a test payment in Stripe
2. Check webhook logs in Stripe dashboard
3. Verify webhook returns HTTP 200 (not 400)
4. Check user record in database

### What to check:
- [ ] Webhook receives event successfully
- [ ] `is_subscribed` set to 1 in users table
- [ ] Welcome email sent (if email service configured)
- [ ] No "Invalid Signature" errors

---

## Known Issues to Verify Fixed:

### Issue #1: Login Redirects to Homepage (CRITICAL)
**Status:** Should be fixed with latest changes
**Test:** Follow Test Flow 1 - verify redirects to checkout/dashboard, NOT homepage

### Issue #2: Webhook 400 Errors
**Status:** Should be fixed - now uses `constructEventAsync`
**Test:** Complete payment and check Stripe webhook logs

### Issue #3: Session Not Persisting
**Status:** Should be fixed - using HTTP-only cookies
**Test:** Login, close tab, reopen - should stay logged in

---

## Mobile Testing (Facebook In-App Browser)

### Steps:
1. Share link in Facebook Messenger
2. Open in Facebook's in-app browser
3. Complete scan
4. Attempt login

### What to check:
- [ ] Scan works in mobile browser
- [ ] Google OAuth works (may redirect to external browser)
- [ ] Session persists after returning from OAuth
- [ ] Checkout loads correctly

---

## Browser Console Errors

During ALL tests above, keep browser DevTools open and check for:
- [ ] No JavaScript errors in console
- [ ] No failed network requests (check Network tab)
- [ ] AuthCallback logs show successful flow (check "[AuthCallback]" messages)
- [ ] No CORS errors

---

## Database Verification

After completing payments, check these tables:
```sql
-- User should exist and be subscribed
SELECT * FROM users WHERE email = 'your-test-email@gmail.com';

-- Should show is_subscribed = 1, stripe_customer_id populated

-- Scans should be saved
SELECT * FROM scans WHERE user_id = 'user-id-from-above';

-- Checklist progress should persist
SELECT * FROM checklist_progress WHERE user_id = 'user-id-from-above';
```

---

## Critical Questions to Answer:

1. **Does login redirect properly?** (NOT to homepage)
2. **Does scan data persist through login?**
3. **Does Stripe checkout open?**
4. **Does webhook activate subscription?**
5. **Do all subscriber features work?**

---

## If Something Fails:

1. Check browser console for errors
2. Check logs in Mocha (read_logs tool)
3. Check Stripe webhook dashboard for delivery failures
4. Check database for user/subscription record
5. Try the "Sync Subscription Status" button in dashboard

---

## Automated Testing Limitations:

I (the AI agent) CANNOT:
- Create real Google accounts
- Complete OAuth flows
- Make real Stripe payments
- Test in mobile browsers
- Access your production database

YOU MUST perform these tests manually with real user accounts.
