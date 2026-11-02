import https from "node:https";
import { randomInt, createHash, randomBytes } from "node:crypto";

const ENDPOINT = "https://sgp.cloud.appwrite.io/v1";
const PROJECT = "6a7f2add0011a7bfc21a";
const DB = "6a7f2d1d0035d9815939";
const ROUND_MS = 1200000, OFFSET = 19800000;
const send = (res, code, obj) => res.json(obj, code);
const eq = (attribute, value) => ({ method: "equal", attribute, values: [value] });
const lim = (n) => ({ method: "limit", values: [n] });
const order = (attribute, direction) => ({ method: direction === "asc" ? "orderAsc" : "orderDesc", attribute });

function request(method, path, key, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const req = https.request(new URL(ENDPOINT + path), {
      method, timeout: 15000,
      headers: {
        "X-Appwrite-Project": PROJECT, "X-Appwrite-Key": key,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {})
      }
    }, r => {
      let raw = "";
      r.on("data", x => { raw += x; if (raw.length > 1000000) r.destroy(new Error("Response too large")); });
      r.on("end", () => {
        let data;
        try { data = JSON.parse(raw); } catch { return reject(new Error("Invalid JSON response")); }
        if (r.statusCode < 200 || r.statusCode >= 300) {
          const e = new Error(data.message || "Database error"); e.status = r.statusCode; return reject(e);
        }
        resolve(data);
      });
    });
    req.on("timeout", () => req.destroy(new Error("Timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
function tablePath(table, queries = []) {
  const q = new URLSearchParams();
  for (const x of queries) q.append("queries[]", JSON.stringify(x));
  return `/tablesdb/${DB}/tables/${table}/rows` + (q.size ? "?" + q : "");
}
async function rows(table, queries, key) {
  return (await request("GET", tablePath(table, queries), key)).rows || [];
}
function roundFor(t) {
  const start = Math.floor((t + OFFSET) / ROUND_MS) * ROUND_MS - OFFSET, end = start + ROUND_MS;
  return {
    roundId: "r_" + new Date(start).toISOString().replace(/[-:.TZ]/g, ""),
    startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(),
    entryClosesAt: new Date(end - 60000).toISOString(),
    status: t >= end - 60000 ? "locked" : "open"
  };
}
async function stored(id, key) {
  const x = await rows("game_rounds", [eq("roundId", id), lim(2)], key);
  if (x.length > 1) throw Error("Duplicate rounds");
  return x[0] || null;
}
const valid = r => r?.status === "settled" && Number.isInteger(r.winningNumber) && r.winningNumber >= 1 && r.winningNumber <= 9;
async function profile(user, key) {
  const x = await rows("user_profiles", [eq("userId", user), lim(2)], key);
  if (x.length !== 1) throw Error("Profile missing or duplicated");
  if (!Number.isSafeInteger(x[0].wallet) || x[0].wallet < 0) throw Error("Invalid wallet");
  return x[0];
}
const op = (action, table, rowId, data) => ({ action, databaseId: DB, tableId: table, rowId, data });
async function transact(key, operations) {
  const tx = await request("POST", "/tablesdb/transactions", key, {});
  try {
    await request("POST", `/tablesdb/transactions/${tx.$id}/operations`, key, { operations });
    await request("PATCH", `/tablesdb/transactions/${tx.$id}`, key, { commit: true });
  } catch (e) {
    try { await request("PATCH", `/tablesdb/transactions/${tx.$id}`, key, { rollback: true }); } catch {}
    throw e;
  }
}
async function settleRound(round, key) {
  if (!valid(round)) return 0;
  let total = 0;
  for (let batch = 0; batch < 100; batch++) {
    const entries = await rows("game_entries", [eq("roundId", round.roundId), eq("status", "pending"), lim(50)], key);
    if (!entries.length) break;
    let done = 0;
    for (const entry of entries) {
      if (!Number.isInteger(entry.stakeVC) || entry.stakeVC < 1 || !Number.isInteger(entry.selectNumber)) continue;
      const win = entry.selectNumber === round.winningNumber, payout = win ? entry.stakeVC * 8 : 0;
      const p = await profile(entry.userId, key);
      const operations = [
        op("update", "game_entries", entry.$id, { status: win ? "won" : "lost", payoutVC: payout, settleAt: new Date().toISOString() }),
        op("increment", "user_profiles", p.$id, { column: "rounds", value: 1 }),
        op("increment", "user_profiles", p.$id, { column: win ? "wins" : "losses", value: 1 })
      ];
      if (payout) operations.push(op("increment", "user_profiles", p.$id, { column: "wallet", value: payout }));
      try { await transact(key, operations); done++; total++; } catch (e) { if (e.status !== 409) throw e; }
    }
    if (!done) break;
  }
  return total;
}
async function lastResult(key) {
  const previous = roundFor(Date.now() - ROUND_MS);
  let r = await stored(previous.roundId, key);
  if (!r) {
    try {
      r = await request("POST", tablePath("game_rounds"), key, {
        rowId: previous.roundId,
        data: {
          roundId: previous.roundId, startAt: previous.startsAt, endsAt: previous.endsAt,
          settleAt: new Date().toISOString(), status: "settled", winningNumber: randomInt(1, 10)
        }
      });
    } catch (e) {
      if (e.status !== 409) throw e;
      r = await stored(previous.roundId, key);
    }
  }
  const settled = valid(r) ? await settleRound(r, key) : 0;
  return { ok: true, available: valid(r), roundId: previous.roundId, winningNumber: valid(r) ? r.winningNumber : null, settledEntries: settled };
}
async function placeEntry(user, b, key) {
  const current = roundFor(Date.now());
  if (current.status !== "open" || b.roundId !== current.roundId) return { ok: false, error: "Round locked or changed. Refresh." };
  if (!Number.isInteger(b.number) || b.number < 1 || b.number > 9 || ![20, 50, 100].includes(b.stakeVC))
    return { ok: false, error: "Invalid number or VC amount" };
  const r = await stored(current.roundId, key);
  if (r && r.status !== "open") return { ok: false, error: "Round closed" };
  const p = await profile(user, key);
  if (p.wallet < b.stakeVC) return { ok: false, error: "Not enough VC. Request coins from admin." };
  const id = "e_" + createHash("sha256").update(user + "|" + current.roundId).digest("hex").slice(0, 30);
  try {
    await transact(key, [
      op("create", "game_entries", id, { roundId: current.roundId, userId: user, selectNumber: b.number, stakeVC: b.stakeVC, status: "pending", payoutVC: 0 }),
      op("decrement", "user_profiles", p.$id, { column: "wallet", value: b.stakeVC, min: 0 })
    ]);
  } catch (e) {
    if (e.status === 409) return { ok: false, error: "Entry already placed or wallet changed. Refresh." };
    throw e;
  }
  return { ok: true, committed: true, roundId: current.roundId, number: b.number, stakeVC: b.stakeVC };
}
async function grantCoins(admin, b, key) {
  const allowed = (process.env.ADMIN_USER_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!allowed.includes(admin)) return { ok: false, error: "Admin access denied" };
  if (typeof b.targetUserId !== "string" || !b.targetUserId.trim() || !Number.isSafeInteger(b.amount) || b.amount < 1 || b.amount > 100000)
    return { ok: false, error: "Invalid user or amount (1-100000)" };
  const p = await profile(b.targetUserId.trim(), key);
  await transact(key, [op("increment", "user_profiles", p.$id, { column: "wallet", value: b.amount, max: 900000000 })]);
  return { ok: true, message: "Virtual coins credited", targetUserId: b.targetUserId, amount: b.amount };
}


// Server-created game sessions. The browser never chooses a challenge.
const GAME_IDS = ["speed_tap", "memory_x"];
const SYMBOLS = ["🌟", "⚡", "💎", "🔥", "🚀", "👑", "🎯", "🦁"];
const speedLevels = { easy: 1400, medium: 900, extreme: 550 };
const scoreId = sessionId => "s_" + createHash("sha256").update(sessionId).digest("hex").slice(0, 30);
function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
async function startGame(user, b, key) {
  if (!GAME_IDS.includes(b.gameId))
    return { ok: false, error: "Invalid game" };
  if (b.gameId === "speed_tap" && !Object.hasOwn(speedLevels, b.level))
    return { ok: false, error: "Invalid difficulty" };
  const now = Date.now();
  const gameId = b.gameId;
  const level = gameId === "speed_tap" ? b.level : "standard";
  const challenge = gameId === "memory_x"
    ? { deck: shuffle([...SYMBOLS, ...SYMBOLS]) }
    : { targets: Array.from({ length: 500 }, () => randomInt(9)), interval: speedLevels[level] };
  const sessionId = "g_" + randomBytes(15).toString("hex");
  const startedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + (gameId === "speed_tap" ? 40000 : 70000)).toISOString();
  await request("POST", tablePath("game_sessions"), key, {
    rowId: sessionId,
    data: {
      
      userId: user, gameid: gameId, challenge: JSON.stringify({ ...challenge, level }),
      
      startedAt, expiresAt, completed: false
    }
  });
  return { ok: true, sessionId, gameId, level, challenge, startedAt, expiresAt };
}
function verifyMemory(deck, events, elapsedMs) {
  if (!Array.isArray(deck) || deck.length !== 16 || !Array.isArray(events) || events.length > 500)
    return null;
  if (!Number.isInteger(elapsedMs) || elapsedMs < 1000 || elapsedMs > 60000) return null;
  const matched = new Set();
  let open = null, lockedUntil = -1, previousTime = -1;
  for (const e of events) {
    if (!Array.isArray(e) || e.length !== 2) return null;
    const [i, t] = e;
    if (!Number.isInteger(i) || i < 0 || i > 15 ||
        !Number.isInteger(t) || t < 0 || t > elapsedMs ||
        t < previousTime || t < lockedUntil || matched.has(i) || i === open) return null;
    previousTime = t;
    if (open === null) { open = i; continue; }
    if (deck[open] === deck[i]) {
      matched.add(open); matched.add(i);
    } else lockedUntil = t + 700;
    open = null;
  }
  if (matched.size !== 16 || open !== null) return null;
  return { score: 8, durationMs: elapsedMs };
}
function verifySpeed(challenge, events, elapsedMs) {
  if (!Array.isArray(events) || events.length > 1500 ||
      !Number.isInteger(elapsedMs) || elapsedMs < 29500 || elapsedMs > 30500) return null;
  let score = 0, hits = 0, misses = 0, cursor = 0, target = challenge.targets[0], last = -1;
  let targetAt = 0;
  const interval = challenge.interval;
  for (const e of events) {
    if (!Array.isArray(e) || e.length !== 2) return null;
    const [tile, t] = e;
    if (!Number.isInteger(tile) || tile < 0 || tile > 8 ||
        !Number.isInteger(t) || t < last || t < 0 || t >= 30000) return null;
    last = t;
    while (t - targetAt >= interval) {
      score = Math.max(0, score - 2); misses++;
      targetAt += interval; cursor++;
      target = challenge.targets[cursor];
      if (target === undefined) return null;
    }
    if (tile === target) {
      score += 10; hits++; targetAt = t; cursor++;
      target = challenge.targets[cursor];
      if (target === undefined) return null;
    } else {
      score = Math.max(0, score - 5); misses++;
    }
  }
  while (30000 - targetAt >= interval) {
    score = Math.max(0, score - 2); misses++;
    targetAt += interval;
  }
  return { score, durationMs: 30000, hits, misses };
}
async function finishGame(user, b, key) {
  if (typeof b.sessionId !== "string" || !/^g_[a-f0-9]{30}$/.test(b.sessionId))
    return { ok: false, error: "Invalid session" };
  const session = await request("GET", tablePath("game_sessions") + "/" + b.sessionId, key);
  if (session.userId !== user || session.completed)
    return { ok: false, error: "Session unavailable or already submitted" };
  const started = Date.parse(session.startedAt), now = Date.now();
  if (!Number.isFinite(started) || now > Date.parse(session.expiresAt) || now < started)
    return { ok: false, error: "Session expired" };
  let challenge;
  try { challenge = JSON.parse(session.challenge); } catch { return { ok: false, error: "Invalid challenge" }; }
  const elapsedMs = b.elapsedMs;
  const actual = now - started;
  // The server clock bounds elapsed time; browser-reported timestamps are not trusted alone.
  if (!Number.isInteger(elapsedMs) || Math.abs(actual - elapsedMs) > 3000)
    return { ok: false, error: "Game timing mismatch" };
  const verified = session.gameid === "memory_x"
    ? verifyMemory(challenge.deck, b.events, elapsedMs)
    : session.gameid === "speed_tap" && Object.hasOwn(speedLevels, challenge.level)
    ? verifySpeed(challenge, b.events, elapsedMs)
    : null;
  if (!verified) return { ok: false, error: "Invalid game replay" };
  try {
    await transact(key, [
      op("update", "game_sessions", session.$id, { completed: true }),
      op("create", "game_scores", scoreId(session.$id), {
        userId: user, gameId: session.gameid, score: verified.score,
        durationMs: verified.durationMs, level: challenge.level,
        verified: true, playedAt: new Date().toISOString()
      })
    ]);
  } catch (e) {
    if (e.status === 409) return { ok: false, error: "Session already submitted" };
    throw e;
  }
  return { ok: true, verified: true, gameid: session.gameid, ...verified };
}

// Read-only leaderboard: only server-verified rows are eligible.
// Client-submitted scores are intentionally NOT accepted by this endpoint.
async function getLeaderboard(gameId, key) {
  if (!["speed_tap", "memory_x"].includes(gameId))
    return { ok: false, error: "Invalid game" };
  const field = gameId === "speed_tap" ? "score" : "durationMs";
  const direction = gameId === "speed_tap" ? "desc" : "asc";
  // Read in rank order and deduplicate players. Cap scanned rows to 100.
  const result = await rows("game_scores", [
    eq("gameId", gameId), eq("verified", true), order(field, direction), lim(100)
  ], key);
  const bestByUser = new Map();
  for (const r of result) {
    const value = r[field];
    if (typeof r.userId !== "string" || !Number.isSafeInteger(value) || value < 0 || (gameId === "memory_x" && value === 0)) continue;
    if (!bestByUser.has(r.userId)) bestByUser.set(r.userId, value);
  }
  const entries = [...bestByUser].slice(0, 10).map(([userId, value], i) => ({
    rank: i + 1,
    player: "Player " + userId.slice(0, 6),
    score: gameId === "speed_tap" ? value : null,
    durationMs: gameId === "memory_x" ? value : null
  }));
  return { ok: true, gameId, verifiedOnly: true, entries };
}

export default async ({ req, res, error }) => {
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "POST required" });
  let b;
  try {
    b = req.headers["x-appwrite-trigger"] === "schedule" ? { action: "get_last_result" }
      : typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!b || typeof b !== "object" || Array.isArray(b)) throw Error();
  } catch { return send(res, 400, { ok: false, error: "Invalid JSON" }); }
  const action = b.action, user = req.headers["x-appwrite-user-id"], key = req.headers["x-appwrite-key"];
  if (!["get_wallet", "get_round", "get_last_result", "place_entry", "grant_coins", "my_entries", "register_profile", "get_leaderboard", "start_game", "finish_game"].includes(action))
    return send(res, 400, { ok: false, error: "Unsupported action" });
  if (!key) return send(res, 503, { ok: false, error: "Function API key missing" });
  if (!user && !["get_round", "get_last_result", "get_leaderboard"].includes(action))
    return send(res, 401, { ok: false, error: "Sign in required" });
  try {
    if (action === "start_game") {
      const x = await startGame(user, b, key);
      return send(res, x.ok ? 200 : 400, x);
    }
    if (action === "finish_game") {
      const x = await finishGame(user, b, key);
      return send(res, x.ok ? 200 : 400, x);
    }
    if (action === "get_leaderboard") {
      const x = await getLeaderboard(b.gameId, key);
      return send(res, x.ok ? 200 : 400, x);
    }
    if (action === "get_last_result") return send(res, 200, await lastResult(key));
    if (action === "get_round") {
      const current = roundFor(Date.now()), r = await stored(current.roundId, key);
      return send(res, 200, {
        ok: true, ...current, serverTime: new Date().toISOString(),
        acceptingEntries: current.status === "open" && (!r || r.status === "open"),
        mode: "free_virtual_coins"
      });
    }
    if (action === "register_profile") {
      const existing = await rows("user_profiles", [eq("userId", user), lim(2)], key);
      if (existing.length) return send(res, 200, { ok: true, created: false });
      try {
        await request("POST", tablePath("user_profiles"), key, {
          rowId: user,
          data: {
            userId: user, name: typeof b.name === "string" ? b.name.slice(0, 80) : "",
            email: typeof b.email === "string" ? b.email.slice(0, 160) : "",
            wallet: 0, wins: 0, losses: 0, rounds: 0,
            referralPoints: 0, rewardPoints: 0, totalRewardsClaimed: 0
          }
        });
      } catch (e) { if (e.status !== 409) throw e; }
      return send(res, 200, { ok: true, created: true });
    }
    if (action === "get_wallet") {
      const p = await profile(user, key);
      return send(res, 200, {
        ok: true, userId: user, wallet: p.wallet,
        wins: p.wins || 0, losses: p.losses || 0, rounds: p.rounds || 0,
        isAdmin: (process.env.ADMIN_USER_IDS || "").split(",").map(x => x.trim()).includes(user)
      });
    }
    if (action === "place_entry") {
      const x = await placeEntry(user, b, key);
      return send(res, x.ok ? 200 : 409, x);
    }
    if (action === "grant_coins") {
      const x = await grantCoins(user, b, key);
      return send(res, x.ok ? 200 : 403, x);
    }
    if (action === "my_entries") {
      const current = roundFor(Date.now());
      const x = await rows("game_entries", [eq("userId", user), eq("roundId", current.roundId), lim(10)], key);
      return send(res, 200, {
        ok: true, entries: x.map(y => ({
          number: y.selectNumber, stakeVC: y.stakeVC, status: y.status, payoutVC: y.payoutVC
        }))
      });
    }
  } catch (e) {
    error("Game backend: " + e.message);
    return send(res, e.status === 409 ? 409 : 500, {
      ok: false, error: "Game service error. Check function logs.", code: e.status || 500
    });
  }
};
