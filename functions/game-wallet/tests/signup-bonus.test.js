import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { readFileSync } from "node:fs";
import gameWallet from "../src/main.js";
import legacyWallet from "../../vc-approval/src/main.js";

function invoke(handler) {
  return handler({
    req: {
      method: "POST",
      body: JSON.stringify({ action: "register_profile", name: "New Player", email: "new@example.com" }),
      headers: {
        "content-type": "application/json",
        "x-appwrite-key": "test-only",
        "x-appwrite-user-id": "new-player-id",
      },
    },
    res: { json: (body, code) => ({ body, code }) },
    error: () => {},
  });
}

function mockProfileRequests({ conflict = false } = {}) {
  let profileExists = false;
  let createdWallet = null;
  let createCount = 0;
  const original = https.request;
  https.request = (target, options, onResponse) => {
    const req = new EventEmitter();
    let body = "";
    req.write = chunk => { body += String(chunk); };
    req.end = () => queueMicrotask(() => {
      const path = String(target);
      const send = (code, data) => {
        const response = new EventEmitter();
        response.statusCode = code;
        onResponse(response);
        response.emit("data", JSON.stringify(data));
        response.emit("end");
      };
      if (!path.includes("/tables/user_profiles/rows")) {
        req.emit("error", new Error("Unexpected request: " + path));
        return;
      }
      if (options.method === "GET") {
        send(200, { rows: profileExists ? [{ userId: "new-player-id", wallet: createdWallet }] : [] });
      } else if (options.method === "POST") {
        createCount++;
        if (conflict) { send(409, { message: "Row already exists" }); return; }
        const payload = JSON.parse(body);
        assert.equal(payload.rowId, "new-player-id");
        createdWallet = payload.data.wallet;
        profileExists = true;
        send(201, { $id: payload.rowId });
      } else {
        req.emit("error", new Error("Unexpected method: " + options.method));
      }
    });
    return req;
  };
  return {
    get createdWallet() { return createdWallet; },
    get createCount() { return createCount; },
    restore() { https.request = original; },
  };
}

for (const [name, handler] of [["game-wallet", gameWallet], ["legacy vc-approval", legacyWallet]]) {
  test(name + " gives exactly one 1,000 VC Sign Up Bonus to a newly registered profile", async () => {
    const api = mockProfileRequests();
    try {
      const first = await invoke(handler);
      assert.equal(first.code, 200);
      assert.equal(first.body.ok, true);
      assert.equal(first.body.created, true);
      assert.equal(first.body.signupBonusLabel, "Sign Up Bonus");
      assert.equal(first.body.signupBonusVC, 1000);
      assert.equal(api.createdWallet, 1000);
      const second = await invoke(handler);
      assert.equal(second.code, 200);
      assert.equal(second.body.created, false);
      assert.equal(second.body.signupBonusVC, 0);
      assert.equal(api.createCount, 1, "second login must not credit again");
    } finally {
      api.restore();
    }
  });

  test(name + " returns no extra signup VC when concurrent creation loses a row conflict", async () => {
    const api = mockProfileRequests({ conflict: true });
    try {
      const result = await invoke(handler);
      assert.equal(result.code, 200);
      assert.equal(result.body.created, false);
      assert.equal(result.body.signupBonusVC, 0);
    } finally {
      api.restore();
    }
  });
}

test("website signup flow and welcome badge advertise the same one-time bonus", () => {
  const signup = readFileSync(new URL("../../../signup.html", import.meta.url), "utf8");
  const home = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
  assert.match(signup, /wallet:1000,wins:0/);
  assert.match(signup, /Sign Up Bonus: 1,000/);
  assert.match(home, /Sign Up Bonus: Get 1,000 FREE VC once/);
  assert.match(home, /profileResult\.signupBonusVC === 1000/);
});
