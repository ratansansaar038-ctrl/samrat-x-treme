# Samrat X-Treme: dual payment gateway handover

**Status:** Code prepared and local tests passed. **Do not enable real-money processing until the merchant providers approve the exact business model and its legal compliance has been checked.** No real transaction has been verified.

The existing `functions/game-wallet/src/main.js` already contains InstentPayment as primary and PaisaPay as secondary. The frontend uses `auto_create_order` and `auto_create_payout`. This change hardens those paths; it does not replace the existing wallet or Number Draw system.

## Appwrite configuration

In the **game-wallet Function → Settings → Environment variables**, configure these secrets as appropriate. Never commit their values to GitHub or share screenshots showing them.

| Variable | Purpose |
| --- | --- |
| `APPWRITE_API_KEY` | Existing database access |
| `PROXY_URL` | Authenticated HTTP CONNECT proxy with the merchant's allowlisted fixed public IP |
| `INSTENT_MERCHANT_ID` | InstentPayment merchant ID |
| `INSTENT_MERCHANT_EMAIL` | InstentPayment merchant email |
| `INSTENT_API_SECRET` | InstentPayment API secret |
| `PAISAPAY_TOKEN` | PaisaPay merchant token |
| `PAISAPAY_SECRET_KEY` | PaisaPay encryption/decryption key |

- First verify the **official API hostnames and request/response schemas** with both providers. The public API documentation for the exact domains used in the existing code was not independently confirmed.
- The IP given to a provider must be the proxy's **outgoing public IPv4 address**, not GitHub Pages' A record IP and not the user's phone IP.
- When the proxy fails, API calls intentionally stop rather than silently use an unallowlisted IP.
- Configure each provider's callback/webhook to the Appwrite Function's correctly configured public HTTP endpoint, not to `index.html`. Confirm callback permissions and gateway-specific authentication with the merchant documentation.
- Redeploy the updated function only in an approved **sandbox/test environment** first; do not change live mode before merchant approval.

## Test checklist

1. Confirm that the two merchant API endpoints are genuine and that proxy requests originate from the allowlisted IP.
2. Start a **sandbox** deposit through InstentPayment; check that wallet credit occurs only after server-side verification of status, order, and amount.
3. Confirm PaisaPay sandbox fallback works only for an eligible failed deposit, and the same callback twice does not credit VC twice.
4. Confirm any missing/wrong payment amount causes **zero** wallet credit.
5. Confirm a timed-out payout is held in a `*_payout_review` state, with **no** automatic refund or attempt at another gateway until the provider confirms the outcome.
6. Reconcile pending/review payouts manually before authorising another attempt. PaisaPay payout completion reconciliation requires provider-specific API documentation before live activation.

## Important limitations

- Local Node tests do **not** prove either real gateway works; production credentials, static-IP configuration, webhook URL, official integration docs, and end-to-end sandbox results are still required.
- A payment processor's technical approval does not replace legal clearance for a paid random-number/VC prize game in India.
