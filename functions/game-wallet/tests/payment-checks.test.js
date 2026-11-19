import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesDepositAmount, safePayoutFallback } from "../src/payment-checks.js";

test("credits 10 VC per verified INR only", () => {
  assert.equal(matchesDepositAmount("100.00", 1000), true);
  assert.equal(matchesDepositAmount(300, 3000), true);
  assert.equal(matchesDepositAmount("100.00", 5000), false);
  assert.equal(matchesDepositAmount(undefined, 1000), false);
  assert.equal(matchesDepositAmount(-100, -1000), false);
  assert.equal(matchesDepositAmount("not-a-number", 1000), false);
});

test("payout fallback is prohibited on an uncertain or rejected transfer", () => {
  assert.equal(safePayoutFallback({ ok: false, needsReview: true }), false);
  assert.equal(safePayoutFallback({ ok: false, error: "Payout rejected" }), false);
  assert.equal(safePayoutFallback({ ok: true }), false);
  assert.equal(safePayoutFallback({ ok: false, error: "InstentPayment payout error: InstentPayment credentials missing in Appwrite" }), true);
});
