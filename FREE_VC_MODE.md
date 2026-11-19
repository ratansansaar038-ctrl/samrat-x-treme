# Samrat X-Treme: free virtual coin mode

The website no longer offers UPI deposits, bank withdrawals, paid gift cards, or a voucher store. Players can request free VC from the Number Draw page, redeem **admin-issued free voucher codes**, and play the existing games. Virtual coins have no cash value.

Both Appwrite Functions (`game-wallet` and legacy `vc-approval`) explicitly reject new paid order, payout and Amazon gift-card submissions with HTTP `410`, including requests from old cached pages or clients.

## Preserved deliberately

- Existing user wallets, games, score history, voucher redemption, admin grants, and free VC request/approval are not changed.
- Existing paid transaction records and inbound provider callbacks remain in the backend solely to reconcile transactions that may have been initiated before payments were disabled. Do not delete or revoke webhook credentials until outstanding transactions have been reviewed.
- The historical gateway implementation stays in source to support reconciliation, but none of its new-order/new-payout actions can be entered through the function router.
- Do **not** merge the separate draft PR that would enable or harden payment gateways. This change is based on the current `main` branch, not that PR.

## Verification

Run `cd functions/game-wallet && npm test`. Confirm the website no longer has paid checkout controls, both functions reject paid actions, and free voucher / VC request controls remain.

Before decommissioning the old merchant accounts, reconcile any pending orders or payouts with the providers. Rotate/revoke screenshot-exposed secrets after reconciliation.
