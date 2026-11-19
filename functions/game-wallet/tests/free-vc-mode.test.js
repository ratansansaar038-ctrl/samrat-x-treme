import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import gameWallet from "../src/main.js";
import legacyVcApproval from "../../vc-approval/src/main.js";

async function invoke(handler, action) {
  return handler({
    req: {
      method: "POST",
      body: JSON.stringify({ action, amount: 100 }),
      headers: {
        "content-type": "application/json",
        "x-appwrite-key": "unit-test-only",
        "x-appwrite-user-id": "test-player",
      },
    },
    res: { json: (body, code) => ({ body, code }) },
    error: () => {},
  });
}

test("game-wallet blocks all new paid actions without contacting gateways", async () => {
  for (const action of [
    "auto_create_order",
    "auto_create_payout",
    "instent_create_order",
    "instent_create_payout",
    "paisapay_create_order",
    "paisapay_create_payout",
    "submit_gift_card",
  ]) {
    const result = await invoke(gameWallet, action);
    assert.equal(result.code, 410, action);
    assert.equal(result.body.ok, false, action);
    assert.match(result.body.error, /disabled/, action);
  }
});

test("legacy vc-approval also blocks payment, payout and paid gift cards", async () => {
  for (const action of [
    "paisapay_create_order",
    "paisapay_create_payout",
    "submit_gift_card",
  ]) {
    const result = await invoke(legacyVcApproval, action);
    assert.equal(result.code, 410, action);
    assert.equal(result.body.ok, false, action);
  }
});

test("public pages have no paid checkout action but retain free VC redemption", () => {
  const home = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
  const draw = readFileSync(new URL("../../../number-draw.html", import.meta.url), "utf8");
  const sw = readFileSync(new URL("../../../service-worker.js", import.meta.url), "utf8");
  assert.doesNotMatch(home, /api\('auto_create_(?:order|payout)'/);
  assert.doesNotMatch(home, /api\('submit_gift_card'/);
  assert.doesNotMatch(home, /id="ppDepositBtn"|id="ppWithdrawBtn"|id="redeemBtn"/);
  assert.doesNotMatch(draw, /buyArcadeVoucher|Buy Arcade Voucher/);
  assert.match(home, /REQUEST FREE VC \/ REDEEM A FREE VOUCHER/);
  assert.match(draw, /api\('redeem_voucher'/);
  assert.match(draw, /REQUEST VC/);
  assert.match(sw, /samrat-xtreme-v2-free-vc/);
});

test("live ticker no longer advertises paid Amazon vouchers", () => {
  const walletSource = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  const approvalSource = readFileSync(new URL("../../vc-approval/src/main.js", import.meta.url), "utf8");
  for (const source of [walletSource, approvalSource]) {
    assert.doesNotMatch(source, /items\.push\("🎁 Start with ₹10 Amazon Pay E-Voucher/);
    assert.match(source, /items\.push\("🎁 Request free VC or redeem an admin-issued free voucher!/);
  }
});
