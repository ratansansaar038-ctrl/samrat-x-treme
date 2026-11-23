# Samrat X-Treme: APITxT SMS OTP and Admin Visit Counter — staged rollout

**This is not live until Appwrite has been configured and the `game-wallet` Function has been deployed.**
Do NOT merge the frontend before the backend passes a real SMS test.

## 1. Secrets (game-wallet Function environment variables only)
- `APITXT_SMS_AUTHKEY`: **new, rotated** APITxT SMS-capable auth key. An earlier credential was posted into chat; do not reuse it until rotated.
- `SAMRAT_SMS_OTP_SECRET`: a new random **32+ character** secret for HMAC verification. Keep it private and stable across deployments.
- Optional `APITXT_SMS_TEMPLATE_ID`: only if the APITxT SMS account requires a specific approved template.

Never put keys in GitHub source, HTML, browser JavaScript, URL query strings or logs. APITxT SMS is called server-side using POST form data at `https://apitxt.com/api/sendOTP`, with `mobile`, `otp`, `channel=sms`, and `authkey`. Provider returns `status: success` for a *send request*, not for OTP verification; the webhook is a **delivery report**, not proof of user possession.

## 2. Appwrite project setup
Project: `6a7f2add0011a7bfc21a`, region `sgp`, database `6a7f2d1d0035d9815939`.
- Auth → Settings → Phone ON and Email/Password ON.
- The `game-wallet` Function needs a server-side API key with `users.read` to validate the phone on the authenticated Appwrite user, and the existing TablesDB row read/write permissions.
- Redeploy `functions/game-wallet/src/main.js` and `functions/game-wallet/src/otp.js` together. The static website deploy cannot change the live Function.
- Ensure the Function only accepts authenticated user headers from Appwrite for `start_sms_otp`, `sms_otp_status`, and `verify_sms_otp`.

Create **private** TablesDB table `phone_otp_challenges` under the database:
| Column | Type | Required | Notes |
|---|---|---|---|
| phoneDigest | string (64) | yes | HMAC of country-coded number, not the raw number |
| otpDigest | string (64) | yes | HMAC of the OTP, cleared after successful verification |
| sentAt | string (32) | yes | UTC ISO timestamp |
| expiresAt | string (32) | yes | UTC ISO timestamp |
| failedAttempts | integer | yes | Start at 0, maximum 5 |
| verified | boolean | yes | Verified only by the backend |
| verifiedAt | string (32) | yes | Empty string until verified |
| sentDay | string (10) | yes | UTC day for rate limiting |
| sendsToday | integer | yes | Maximum 6 per day |

Table row ID is `otp_<28 hexadecimal chars>`, uniquely based on user ID. **Do not grant direct client row permissions.**

Create a second **private** table `site_visitors`. The counter stores a hashed random browser token in each row ID; no extra columns are required by the application. The dashboard shows **estimated unique browsers since counting started**, not historic visits, page views, or verified unique people. No IP or phone is recorded for the counter.

## 3. Safeguards
- Only the server generates the six-digit code.
- 5-minute expiry; 60-second resend cooldown; max 6 SMS sends per account per UTC day; max 5 incorrect attempts per code.
- The provider API key and raw OTP are never returned to browser or written to a database.
- `register_profile` checks an existing profile first; legacy users keep their current balance, while new players only get +1,000 VC after a successfully verified OTP tied to their current Appwrite phone.
- Provider SMS charges may apply even if a delivery report later says failed.
- Phone number reuse across **different accounts** is not separately enforced by the OTP table. Confirm the Appwrite Auth phone uniqueness behavior and add abuse controls before high-volume promotion.
- Upstream signup `user_already_exists` and login `invalid credentials` reports need separate root-cause verification.

## 4. Acceptance test before merging
1. In GitHub Actions verify **all** signup, visitor and OTP tests pass.
2. From an unused email, try invalid mobile and confirm no account is created.
3. Enter a valid phone and confirm APITxT SMS arrives from the expected sender/template.
4. Enter a wrong OTP; confirm no bonus or wallet row. Wait 5 minutes and confirm expired OTP is rejected.
5. Enter the correct OTP; confirm exactly 1,000 VC and redirect to Lucky Draw.
6. Retry same account; confirm no duplicate VC or unwanted SMS.
7. Open Admin Dashboard from an authorized account and confirm visitor count increases for a new browser only after tracking is active. If the counter displays `—`, investigate table permissions or Function deployment instead of inventing a value.

No SMS has been sent from this development branch; a live test is required.
