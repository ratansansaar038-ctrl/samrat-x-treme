import https from "node:https";
import { randomInt } from "node:crypto";
const ENDPOINT = "https://sgp.cloud.appwrite.io/v1",
  PROJECT = "6a7f2add0011a7bfc21a",
  DB = "6a7f2d1d0035d9815939";
const ROUND_MS = 1200000,
  OFFSET = 19800000;
const ok = (res, status, data) => res.json(data, status);
const eq = (attribute, value) => ({
  method: "equal",
  attribute,
  values: [value],
});
const lim = (value) => ({ method: "limit", values: [value] });
function request(method, path, key, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const r = https.request(
      new URL(ENDPOINT + path),
      {
        method,
        timeout: 12000,
        headers: {
          "X-Appwrite-Project": PROJECT,
          "X-Appwrite-Key": key,
          Accept: "application/json",
          ...(body
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (response) => {
        let raw = "";
        response.on("data", (c) => {
          raw += c;
          if (raw.length > 1000000)
            response.destroy(new Error("Response too large"));
        });
        response.on("end", () => {
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            return reject(new Error("Invalid database response"));
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const e = new Error(data.message || "Database error");
            e.status = response.statusCode;
            return reject(e);
          }
          resolve(data);
        });
      }
    );
    r.on("timeout", () => r.destroy(new Error("Timeout")));
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
function path(table, queries = []) {
  const p = new URLSearchParams();
  for (const q of queries) p.append("queries[]", JSON.stringify(q));
  return `/tablesdb/${DB}/tables/${table}/rows` + (p.size ? "?" + p : "");
}
async function rows(table, queries, key) {
  return (await request("GET", path(table, queries), key)).rows || [];
}
function roundFor(t) {
  const start = Math.floor((t + OFFSET) / ROUND_MS) * ROUND_MS - OFFSET,
    end = start + ROUND_MS;
  return {
    roundId: "r_" + new Date(start).toISOString().replace(/[-:.TZ]/g, ""),
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    entryClosesAt: new Date(end - 60000).toISOString(),
    status: t >= end - 60000 ? "locked" : "open",
  };
}
async function stored(id, key) {
  const r = await rows("game_rounds", [eq("roundId", id), lim(2)], key);
  if (r.length > 1) throw Error("Duplicate rounds");
  return r[0] || null;
}
const valid = (r) =>
  r?.status === "settled" &&
  Number.isInteger(r.winningNumber) &&
  r.winningNumber >= 1 &&
  r.winningNumber <= 9;
async function result(key) {
  const previous = roundFor(Date.now() - ROUND_MS);
  let r = await stored(previous.roundId, key);
  if (!r) {
    try {
      r = await request("POST", path("game_rounds"), key, {
        rowId: previous.roundId,
        data: {
          roundId: previous.roundId,
          startAt: previous.startsAt,
          endsAt: previous.endsAt,
          settleAt: new Date().toISOString(),
          status: "settled",
          winningNumber: randomInt(1, 10),
        },
      });
    } catch (e) {
      if (e.status !== 409) throw e;
      r = await stored(previous.roundId, key);
    }
  }
  return {
    ok: true,
    available: valid(r),
    roundId: previous.roundId,
    winningNumber: valid(r) ? r.winningNumber : null,
    message: valid(r) ? "Saved demo result" : "Result pending",
  };
}
async function profile(user, key) {
  const r = await rows("user_profiles", [eq("userId", user), lim(2)], key);
  if (r.length !== 1)
    throw Error(r.length ? "Duplicate profiles" : "Profile not found");
  if (!Number.isSafeInteger(r[0].wallet) || r[0].wallet < 0)
    throw Error("Invalid wallet");
  return r[0];
}
export default async ({ req, res, error }) => {
  if (req.method !== "POST")
    return ok(res, 405, { ok: false, error: "POST required" });
  let b;
  const scheduled = req.headers["x-appwrite-trigger"] === "schedule";
  try {
    b = scheduled
      ? { action: "get_last_result" }
      : typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;
    if (!b || typeof b !== "object" || Array.isArray(b)) throw Error();
  } catch {
    return ok(res, 400, { ok: false, error: "Invalid JSON" });
  }
  const action = b.action,
    user = req.headers["x-appwrite-user-id"],
    key = req.headers["x-appwrite-key"];
  if (
    !["get_wallet", "get_round", "get_last_result", "preview_entries"].includes(
      action
    )
  )
    return ok(res, 400, { ok: false, error: "Unsupported action" });
  if (!key)
    return ok(res, 503, { ok: false, error: "Function API key unavailable" });
  if (!user && !["get_round", "get_last_result"].includes(action))
    return ok(res, 401, { ok: false, error: "Login required" });
  try {
    if (action === "get_last_result") return ok(res, 200, await result(key));
    if (action === "get_wallet") {
      const p = await profile(user, key);
      return ok(res, 200, { ok: true, userId: user, wallet: p.wallet });
    }
    const current = roundFor(Date.now()),
      r = await stored(current.roundId, key);
    if (action === "get_round")
      return ok(res, 200, {
        ok: true,
        ...current,
        serverTime: new Date().toISOString(),
        status: valid(r)
          ? "settled"
          : r?.status === "locked"
          ? "locked"
          : current.status,
        winningNumber: valid(r) ? r.winningNumber : null,
        acceptingEntries: false,
        mode: "free_demo",
      });
    if (current.status !== "open" || (r && r.status !== "open"))
      return ok(res, 409, { ok: false, error: "Round locked" });
    if (b.roundId && b.roundId !== current.roundId)
      return ok(res, 409, { ok: false, error: "Round mismatch" });
    if (
      !Array.isArray(b.selections) ||
      b.selections.length < 1 ||
      b.selections.length > 9
    )
      return ok(res, 400, { ok: false, error: "Select 1–9 numbers" });
    let total = 0;
    const seen = new Set(),
      selected = [];
    for (const x of b.selections) {
      if (
        !Number.isInteger(x.number) ||
        x.number < 1 ||
        x.number > 9 ||
        seen.has(x.number) ||
        ![20, 50, 100].includes(x.stakeVC)
      )
        return ok(res, 400, { ok: false, error: "Invalid selections" });
      seen.add(x.number);
      total += x.stakeVC;
      selected.push({
        number: x.number,
        stakeVC: x.stakeVC,
        potentialPayoutVC: x.stakeVC * 8,
      });
    }
    const p = await profile(user, key);
    return ok(res, 200, {
      ok: true,
      action: "preview_entries",
      roundId: current.roundId,
      selections: selected,
      totalStakeVC: total,
      walletVC: p.wallet,
      sufficientBalance: p.wallet >= total,
      walletAfterVC: p.wallet >= total ? p.wallet - total : null,
      acceptingEntries: false,
      committed: false,
      message: "Preview only. No VC deducted.",
    });
  } catch (e) {
    error("Game backend error: " + e.message);
    return ok(res, 500, {
      ok: false,
      code: "BACKEND_ERROR",
      error: "Game service unavailable; check function errors",
    });
  }
};
