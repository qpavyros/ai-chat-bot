# Clinics Launch Campaign Implementation Plan

> **For agentic workers:** Implement task-by-task with TDD and review every change before merging.

**Goal:** Add safe campaign attribution and an atomic founders discount for the clinics acquisition campaign, then prepare the advertising assets and launch checklist.

**Architecture:** Signup carries an allowlisted campaign code into pending signup data and bot configuration. Account payment uses one Firestore transaction across the entitlement and campaign documents to enforce the five-company cap and renewal continuity. Existing dashboard APIs expose a sanitized offer summary for the billing UI.

**Tech Stack:** Node.js 20, Express 4, Firebase Admin/Firestore transactions, browser HTML/JavaScript, `node:test`.

## Global Constraints

- Campaign code is exactly `clinics-launch-2026`; discount is 20%; global limit is 5.
- Trial duration stays at the existing `TRIAL_DAYS=7` default.
- Discount applies to all plans and stays active through renewals made no later than seven days after expiry.
- Existing customers and non-campaign signups retain current behavior.
- No bulk cold messaging, production provider calls, secrets, or customer data in tests.
- Gemini-only Antigravity workflow; no Caveman.

---

### Task 1: Campaign attribution

**Files:** `src/services/launchCampaign.js`, `src/services/signups.js`, `src/routes/signup.js`, `src/services/provisioning.js`, `src/public/signup.html`, `src/services/clientConfigSchema.js`, `tests/unit/launch-campaign.test.js`.

**Interfaces:** `normalizeCampaignCode(value) -> string|null`; signup `campaignCode` becomes `config.acquisition = {campaignCode, capturedAt}`.

- [ ] Write failing tests for allowlisted/unknown codes and preservation through pending signup and client creation.
- [ ] Run `node --test tests/unit/launch-campaign.test.js` and confirm failure.
- [ ] Implement normalization and propagation without changing non-campaign records.
- [ ] Run the focused test and `npm test`.
- [ ] Commit the independently working attribution slice.

### Task 2: Atomic founders discount

**Files:** `src/services/accountEntitlements.js`, `src/routes/admin.js`, `tests/unit/account-entitlements.test.js`.

**Interfaces:** `recordPayment(uid, {operationId, tier, now, amountUsd, campaignCode})`; result adds `discountPercent`, `discountApplied`, `discountStatus`, and `chargedAmountUsd` when relevant.

- [ ] Write failing tests for first claim, fifth/sixth claim boundary, idempotent replay, concurrent different accounts, plan changes, on-time renewal, late renewal, and non-campaign payment.
- [ ] Run the focused tests and confirm the campaign cases fail.
- [ ] Read entitlement and campaign documents before writes, then update both in one transaction.
- [ ] Pass the trusted campaign code and catalog price from the admin payment route.
- [ ] Run focused tests and `npm test`.
- [ ] Commit the discount slice.

### Task 3: Billing and admin visibility

**Files:** `src/services/accountEntitlements.js`, `src/routes/botManagement.js`, `src/public/billing.html`, `src/admin-pages/admin-client-detail.html`, `tests/unit/dashboard-entitlement-ui.test.js`, `tests/unit/deployment-regressions.test.js`.

**Interfaces:** authenticated bot summary adds `campaignOffer: {campaignCode, discountPercent, discountStatus, discountedPrices, graceUntil}|null`.

- [ ] Write failing API and static UI tests for sanitized campaign state and discounted prices.
- [ ] Add read-only entitlement lookup and expose only offer fields to the owner.
- [ ] Render original and discounted prices, offer status, and renewal grace consistently in RTL.
- [ ] Show campaign identity and applied discount in the operator client detail view.
- [ ] Build CSS if classes changed; run focused tests and `npm test`.
- [ ] Commit the visibility slice.

### Task 4: Campaign validation and launch package

**Files:** `docs/marketing/clinics-launch-2026.md`, `scripts/campaign-smoke-test.js`, `package.json`.

**Interfaces:** `npm run test:campaign` performs synthetic signup attribution, payment replay, cap, and billing-summary checks without network calls.

- [ ] Add the synthetic campaign smoke test and confirm it fails before the complete integration exists.
- [ ] Document the two ads, Lebanese copy, prefilled WhatsApp text, lead qualification flow, approved follow-up limits, daily metrics, stop rule, and rollback steps.
- [ ] Run `npm run test:campaign`, `npm test`, syntax checks, and inspect the UI at phone and desktop widths.
- [ ] Review the complete diff with Gemini, then independently review security, ownership, transaction ordering, and unrelated edits.
- [ ] Merge accepted commits into `master`, recheck VPS drift, back up, deploy, verify health/logs, and record evidence in Obsidian.
- [ ] Prepare Meta Ads Manager through the final review screen. The USD 50 publish/payment action remains the final user-approved step.

