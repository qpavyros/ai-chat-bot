# Clinics Launch Campaign Design

## Goal

Launch a seven-day Meta click-to-WhatsApp acquisition test for clinics in Lebanon. Leads use the existing seven-day product trial. The first five companies that make their first subscription payment receive a 20% discount while renewals remain continuous.

## Offer and attribution

- Public campaign code: `clinics-launch-2026`.
- Signup accepts only this allowlisted code from `?campaign=clinics-launch-2026`; unknown values are ignored.
- The pending signup and resulting bot config retain `acquisition.campaignCode` and `acquisition.capturedAt`.
- Existing signups, bots, trials, and prices keep their current behavior.

## Discount rules

- The global Firestore document `marketingCampaigns/clinics-launch-2026` stores `limit`, `claimedCount`, and a small `claims` map keyed by account UID.
- The account entitlement document stores `discountPercent`, `discountCampaignCode`, `discountClaimedAt`, `discountStatus`, and `discountGraceUntil`.
- The first subscription payment claims one of five places atomically with the account payment. Replaying the operation returns the original result and never increments the count.
- A claim applies to every plan. Each on-time renewal updates the grace deadline to seven days after the new subscription expiry.
- A payment arriving after the stored grace deadline marks the discount `lapsed`; a lapsed account cannot reclaim a campaign place.
- The campaign cap counts companies that received the discount. It is not reduced when a discount later lapses.
- The UI calculates and displays the discounted monthly price but the existing manual payment workflow remains unchanged.

## Campaign journey

- Meta campaign: one ad set, Lebanon, clinics and medical centers, USD 7/day for seven days, maximum USD 50.
- Two creatives: appointment problem/result and founders offer.
- WhatsApp prefilled text names the offer and includes `CLINIC5`; the product bot provides the campaign signup URL.
- Follow-up is limited to the active service window. Later marketing follow-up requires explicit opt-in and an approved template.

## Success criteria

- At least 12 conversations, 5 qualified clinics, 3 activated trials, and 1 paying customer within 14 days.
- Pause after USD 25 if fewer than 3 serious conversations have started.
- No cold bulk messaging and no messages to real customers during automated tests.

