import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import https from "node:https";
import gameWallet from "../src/main.js";
import legacyVcApproval from "../../vc-approval/src/main.js";

async function invoke(handler, action, extra = {}) {
  return handler({
    req: {
      method: "POST",
      body: JSON.stringify({ action, amount: 100, ...extra }),
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
  assert.match(sw, /samrat-xtreme-v3-custom-vc/);
  for (const id of ["vcRequestAmount", "stake"]) {
    assert.match(draw, new RegExp(`<select id="${id}">[\\s\\S]*?<option value="100">100 VC`));
  }
  for (const id of ["vcRequestCustom", "stakeCustom"]) {
    assert.match(draw, new RegExp(`id="${id}" type="number"`));
  }
  assert.match(draw, /<option value="500">500 VC<\/option>/);
  assert.match(draw, /<option value="custom">Custom amount<\/option>/);
  assert.match(draw, /stakeVC=readVCAmount\('stake','stakeCustom'\)/);
  assert.match(draw, /amount=readVCAmount\('vcRequestAmount','vcRequestCustom'\)/);
});

test("live ticker no longer advertises paid Amazon vouchers", () => {
  const walletSource = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  const approvalSource = readFileSync(new URL("../../vc-approval/src/main.js", import.meta.url), "utf8");
  for (const source of [walletSource, approvalSource]) {
    assert.doesNotMatch(source, /items\.push\("🎁 Start with ₹10 Amazon Pay E-Voucher/);
    assert.match(source, /items\.push\("🎁 Request free VC or redeem an admin-issued free voucher!/);
  }
});

test("free VC request action reaches a validated handler in both functions", async () => {
  for (const handler of [gameWallet, legacyVcApproval]) {
    for (const amount of [0, -1, 1.5, 100001]) {
      const result = await invoke(handler, "request_vc", { amount });
      assert.equal(result.code, 400);
      assert.equal(result.body.ok, false);
      assert.match(result.body.error, /whole VC amount from 1 to 100000/);
    }
  }
});

test("both game backends validate custom draw stake limits", () => {
  for (const path of ["../src/main.js", "../../vc-approval/src/main.js"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /Number\.isSafeInteger\(b\.stakeVC\)/);
    assert.match(source, /b\.stakeVC > MAX_CUSTOM_VC/);
    assert.match(source, /MAX_CUSTOM_VC = 100000/);
  }
});

test("VC admin endpoints deny non-admin users instead of failing", async () => {
  for (const handler of [gameWallet, legacyVcApproval]) {
    for (const action of ["admin_list_vc_requests", "admin_decide_vc_request"]) {
      const result = await invoke(handler, action);
      assert.equal(result.code, action === "admin_list_vc_requests" ? 403 : 409);
      assert.equal(result.body.error, "Admin access denied");
    }
  }
});

test("free VC request saves a pending row and notifies Telegram", async () => {
  const originalRequest = https.request;
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  const oldChat = process.env.TELEGRAM_CHAT_ID;
  const calls = [];
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  process.env.TELEGRAM_CHAT_ID = "123456";
  https.request = (target, options, onResponse) => {
    let body = "";
    const req = new EventEmitter();
    req.write = (chunk) => { body += String(chunk); };
    req.end = (tail) => { if (tail) body += String(tail); queueMicrotask(() => {
      const path = String(target);
      const payload = body ? JSON.parse(body) : {};
      calls.push({ path, method: options.method, payload });
      let data;
      if (path.includes("/user_profiles/")) {
        data = { rows: [{ $id: "test-player", name: "Tester", email: "tester@example.com", wallet: 20 }] };
      } else if (path.includes("/vc_requests/") && options.method === "GET") {
        data = { rows: [] };
      } else if (path.includes("/vc_requests/") && options.method === "POST") {
        data = { $id: payload.rowId };
      } else if (path.includes("api.telegram.org")) {
        data = { ok: true };
      } else {
        req.emit("error", new Error("Unexpected mock request"));
        return;
      }
      const response = new EventEmitter();
      response.statusCode = 200;
      onResponse(response);
      response.emit("data", JSON.stringify(data));
      response.emit("end");
    }); };
    return req;
  };
  try {
    const result = await invoke(gameWallet, "request_vc", { amount: 2500 });
    assert.equal(result.code, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.status, "pending");
    assert.equal(result.body.telegramNotified, true);
    const row = calls.find((call) => call.method === "POST" && call.path.includes("/vc_requests/"));
    assert.equal(row.payload.data.status, "pending");
    assert.equal(row.payload.data.amount, 2500);
    assert.ok(calls.some((call) => call.path.includes("api.telegram.org") && call.payload.text.includes("NEW VC REQUEST")));
  } finally {
    https.request = originalRequest;
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    if (oldChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = oldChat;
  }
});
