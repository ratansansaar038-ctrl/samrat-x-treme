
import https from "node:https";
import { randomInt, createHash, randomBytes } from "node:crypto";

const ENDPOINT = "https://sgp.cloud.appwrite.io/v1";
const PROJECT = "6a7f2add0011a7bfc21a";
const DB = "6a7f2d1d0035d9815939";
const ROUND_MS = 1200000, OFFSET = 19800000;

const send = (res, code, obj) => res.json(obj, code);
const eq = (attribute, value) => ({ method: "equal", attribute, values: [value] });
const lim = n => ({ method: "limit", values: [n] });
const order = (attribute, direction) => ({
  method: direction === "asc" ? "orderAsc" : "orderDesc",
  attribute
});

function request(method, path, key, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const req = https.request(new URL(ENDPOINT + path), {
      method,
      timeout: 15000,
      headers: {
        "X-Appwrite-Project": PROJECT,
        "X-Appwrite-Key": key,
        Accept: "application/json",
        ...(body ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        } : {})
      }
    }, r => {
      let raw = "";
      r.on("data", x => {
        raw += x;
        if (raw.length > 1000000)
          r.destroy(new Error("Response too large"));
      });
      r.on("end", () => {
        let data;
        try { data = JSON.parse(raw); }
        catch { return reject(new Error("Invalid JSON response")); }
        if (r.statusCode < 200 || r.statusCode >= 300) {
          const e = new Error(data.message || "Database error");
          e.status = r.statusCode;
          return reject(e);
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
  for (const x of queries)
    q.append("queries[]", JSON.stringify(x));
  return `/tablesdb/${DB}/tables/${table}/rows` +
    (q.size ? "?" + q : "");
}

async function rows(table, queries, key) {
  return (await request("GET", tablePath(table, queries), key)).rows || [];
}

function roundFor(t) {
  const start = Math.floor((t + OFFSET) / ROUND_MS) * ROUND_MS - OFFSET;
  const end = start + ROUND_MS;
  return {
    roundId: "r_" + new Date(start).toISOString().replace(/[-:.TZ]/g, ""),
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    entryClosesAt: new Date(end - 60000).toISOString(),
    status: t >= end - 60000 ? "locked" : "open"
  };
}

async function stored(id, key) {
  const x = await rows("game_rounds", [eq("roundId", id), lim(2)], key);
  if (x.length > 1) throw Error("Duplicate rounds");
  return x[0] || null;
}

const valid = r => r?.status === "settled" &&
  Number.isInteger(r.winningNumber) &&
  r.winningNumber >= 1 && r.winningNumber <= 9;

async function profile(user, key) {
  const x = await rows("user_profiles", [eq("userId", user), lim(2)], key);
  if (x.length !== 1) throw Error("Profile missing or duplicated");
  if (!Number.isSafeInteger(x[0].wallet) || x[0].wallet < 0)
    throw Error("Invalid wallet");
  return x[0];
}

const op = (action, table, rowId, data) =>
  ({ action, databaseId: DB, tableId: table, rowId, data });

async function transact(key, operations) {
  const tx = await request("POST", "/tablesdb/transactions", key, {});
  try {
    await request(
      "POST",
      `/tablesdb/transactions/${tx.$id}/operations`,
      key,
      { operations }
    );
    await request(
      "PATCH",
      `/tablesdb/transactions/${tx.$id}`,
      key,
      { commit: true }
    );
  } catch (e) {
    try {
      await request(
        "PATCH",
        `/tablesdb/transactions/${tx.$id}`,
        key,
        { rollback: true }
      );
    } catch {}
    throw e;
  }
}

async function settleRound(round, key) {
  if (!valid(round)) return 0;
  let total = 0;

  for (let batch = 0; batch < 100; batch++) {
    const entries = await rows("game_entries", [
      eq("roundId", round.roundId),
      eq("status", "pending"),
      lim(50)
    ], key);

    if (!entries.length) break;
    let done = 0;

    for (const entry of entries) {
      if (!Number.isInteger(entry.stakeVc) ||
          entry.stakeVc < 1 ||
          !Number.isInteger(entry.selectNumber)) continue;

      const win = entry.selectNumber === round.winningNumber;
      const payout = win ? entry.stakeVc * 8 : 0;
      const p = await profile(entry.userId, key);
      const previousEntries = await rows("game_entries", [eq("roundId", round.roundId), eq("userId", entry.userId), lim(100)], key);
      const roundCounted = previousEntries.some(x => x.status === "won" || x.status === "lost");

      const operations = [
        op("update", "game_entries", entry.$id, {
          status: win ? "won" : "lost",
          payoutVc: payout,
          settleAt: new Date().toISOString()
        }),

        op("increment", "user_profiles", p.$id, {
          column: win ? "wins" : "losses",
          value: 1
        })
      ];

      if (!roundCounted) operations.push(op("increment", "user_profiles", p.$id, { column: "rounds", value: 1 }));
      if (payout) operations.push(
        op("increment", "user_profiles", p.$id, {
          column: "wallet", value: payout
        })
      );

      try {
        await transact(key, operations);
        done++;
        total++;
      } catch (e) {
        if (e.status !== 409) throw e;
      }
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
          roundId: previous.roundId,
          startAt: previous.startsAt,
          endsAt: previous.endsAt,
          settleAt: new Date().toISOString(),
          status: "settled",
          winningNumber: randomInt(1, 10)
        }
      });
    } catch (e) {
      if (e.status !== 409) throw e;
      r = await stored(previous.roundId, key);
    }
  }

  const settled = valid(r) ? await settleRound(r, key) : 0;
  let recovery;
  try {
    recovery = await recoverPendingRounds(key, previous.roundId);
  } catch (e) {
    console.error("Number draw recovery failed: " + e.message);
    recovery = { ok: false, error: "Recovery temporarily unavailable" };
  }
  return {
    ok: true,
    available: valid(r),
    roundId: previous.roundId,
    winningNumber: valid(r) ? r.winningNumber : null,
    settledEntries: settled,
    recovery
  };
}

// RECOVERY V1: Recover only expired rounds containing pending entries.
// Existing settled winning numbers are never changed; processing is bounded.
async function recoverPendingRounds(key, justProcessedRoundId) {
  const entries = await rows("game_entries", [
    eq("status", "pending"), lim(100)
  ], key);
  const cutoff = Date.now() - 10000;
  const candidates = new Map();

  for (const entry of entries) {
    const rid = entry.roundId;
    const match = typeof rid === "string" && /^r_(\d{17})$/.exec(rid);
    if (!match || rid === justProcessedRoundId) continue;
    const digits = match[1];
    const y = +digits.slice(0, 4), m = +digits.slice(4, 6);
    const d = +digits.slice(6, 8), h = +digits.slice(8, 10);
    const minute = +digits.slice(10, 12), sec = +digits.slice(12, 14);
    const millis = +digits.slice(14, 17);
    const startMs = Date.UTC(y, m - 1, d, h, minute, sec, millis);
    if (!Number.isFinite(startMs)) continue;
    const round = roundFor(startMs);
    if (round.roundId !== rid || Date.parse(round.endsAt) > cutoff) continue;
    candidates.set(rid, round);
  }

  let recoveredRounds = 0, recoveredEntries = 0;
  const flaggedRounds = [];
  for (const round of [...candidates.values()]
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 2)) {
    let saved = await stored(round.roundId, key);
    if (!saved) {
      try {
        saved = await request("POST", tablePath("game_rounds"), key, {
          rowId: round.roundId,
          data: {
            roundId: round.roundId,
            startAt: round.startsAt,
            endsAt: round.endsAt,
            settleAt: new Date().toISOString(),
            status: "settled",
            winningNumber: randomInt(1, 10)
          }
        });
      } catch (e) {
        if (e.status !== 409) throw e;
        saved = await stored(round.roundId, key);
      }
    }
    if (!valid(saved)) {
      flaggedRounds.push(round.roundId);
      continue;
    }
    recoveredEntries += await settleRound(saved, key);
    recoveredRounds++;
  }
  return {
    ok: true, checkedPending: entries.length,
    scanLimitReached: entries.length === 100,
    recoveredRounds, recoveredEntries,
    flaggedRounds
  };
}

async function placeEntry(user, b, key) {
  const current = roundFor(Date.now());

  if (current.status !== "open" || b.roundId !== current.roundId)
    return { ok: false, error: "Round locked or changed. Refresh." };

  if (!Number.isInteger(b.number) || b.number < 1 || b.number > 9 ||
      ![20, 50, 100].includes(b.stakeVC))
    return { ok: false, error: "Invalid number or VC amount" };

  const r = await stored(current.roundId, key);
  if (r && r.status !== "open")
    return { ok: false, error: "Round closed" };

  const p = await profile(user, key);
  if (p.wallet < b.stakeVC)
    return {
      ok: false,
      error: "Not enough VC. Request coins from admin."
    };

  const id = "e_" + createHash("sha256")
    .update(user + "|" + current.roundId + "|" + b.number)
    .digest("hex").slice(0, 30);

  try {
    await transact(key, [
      op("create", "game_entries", id, {
        roundId: current.roundId,
        userId: user,
        selectNumber: b.number,
        stakeVc: b.stakeVC,
        status: "pending",
        payoutVc: 0
      }),
      op("decrement", "user_profiles", p.$id, {
        column: "wallet",
        value: b.stakeVC,
        min: 0
      })
    ]);
  } catch (e) {
    if (e.status === 409)
      return {
        ok: false,
        error: "Entry already placed or wallet changed. Refresh."
      };
    throw e;
  }

  return {
    ok: true,
    committed: true,
    roundId: current.roundId,
    number: b.number,
    stakeVC: b.stakeVC
  };
}


async function redeemVoucher(user, b, key) {
  const code = typeof b.code === "string"
    ? b.code.trim().toUpperCase() : "";

  if (!/^[A-Z0-9-]{8,64}$/.test(code))
    return { ok: false, error: "Enter a valid voucher code" };

  const found = await rows("vouchers", [
    eq("code", code), lim(2)
  ], key);

  if (found.length !== 1)
    return { ok: false, error: "Invalid or unavailable voucher" };

  const voucher = found[0];
  if (voucher.isRedeemed !== false)
    return { ok: false, error: "Voucher already used or unavailable" };

  if (!Number.isSafeInteger(voucher.coins) ||
      voucher.coins < 1 || voucher.coins > 100000)
    return { ok: false, error: "Voucher configuration invalid" };

  const player = await profile(user, key);
  // Redemption timestamp is in voucher_redemptions.$createdAt

  try {
    await transact(key, [
      op("create", "voucher_redemptions", voucher.$id, {
        code,
        userId: user,
        coins: voucher.coins,
      }),
      op("update", "vouchers", voucher.$id, {
        isRedeemed: true,
        redeemedBy: user,
      }),
      op("increment", "user_profiles", player.$id, {
        column: "wallet",
        value: voucher.coins,
        max: 900000000
      })
    ]);
  } catch (e) {
    if (e.status === 409)
      return { ok: false, error: "Voucher already redeemed or wallet busy; please retry" };
    throw e;
  }

  return {
    ok: true,
    message: "Virtual coins credited",
    coinsAdded: voucher.coins
  };
}


async function makeVouchers(user,b,key){
  const admins=(process.env.ADMIN_USER_IDS||'').split(',').map(x=>x.trim());
  if(!admins.includes(user))return {ok:false,error:'Admin only'};
  const counts=b.quantities;
  if(!counts||typeof counts!=='object'||Array.isArray(counts))
    return {ok:false,error:'Invalid quantities'};
  const vouchers=[];
  for(const tier of [20,50,100,200]){
    const n=counts[String(tier)]??0;
    if(!Number.isSafeInteger(n)||n<0||n>50)
      return {ok:false,error:'Invalid quantity'};
    for(let i=0;i<n;i++){
      const code='SX-'+randomBytes(12).toString('hex').toUpperCase();
      vouchers.push({code,coins:tier});
    }
  }
  if(vouchers.length<1||vouchers.length>50)
    return {ok:false,error:'Choose 1 to 50 vouchers total'};
  await transact(key,vouchers.map(v=>op('create','vouchers',v.code,{
    code:v.code,coins:v.coins,isRedeemed:false
  })));
  return {ok:true,vouchers};
}
async function unusedVouchers(user,key){
  const admins=(process.env.ADMIN_USER_IDS||'').split(',').map(x=>x.trim());
  if(!admins.includes(user))return {ok:false,error:'Admin only'};
  const found=await rows('vouchers',[order('$createdAt','desc'),lim(100)],key);
  return {ok:true,vouchers:found.filter(x=>x.isRedeemed===false)
    .map(x=>({code:x.code,coins:x.coins})),limit:100};
}

// SAMRAT ADMIN DASHBOARD V1 - server-only access, no direct client table privileges.
const dashboardIsAdmin = user => typeof user === 'string' &&
  (process.env.ADMIN_USER_IDS || '').split(',')
    .map(value => value.trim()).filter(Boolean).includes(user);

async function adminSnapshot(table, queries, key) {
  const data = await request('GET', tablePath(table, queries), key);
  return {
    total: Number.isSafeInteger(data.total) ? data.total : null,
    rows: Array.isArray(data.rows) ? data.rows : []
  };
}

async function adminDashboard(user, key) {
  if (!dashboardIsAdmin(user))
    return { ok: false, error: 'Admin access denied' };

  const items = [
    ['players', 'user_profiles', [order('$createdAt', 'desc'), lim(40)]],
    ['vouchers', 'vouchers', [order('$createdAt', 'desc'), lim(60)]],
    ['unused', 'vouchers', [eq('isRedeemed', false), lim(1)]],
    ['redeemed', 'vouchers', [eq('isRedeemed', true), lim(1)]],
    ['rounds', 'game_rounds', [order('$createdAt', 'desc'), lim(8)]],
    ['games', 'game_scores', [order('$createdAt', 'desc'), lim(8)]]
  ];
  const results = await Promise.allSettled(items.map(
    async ([name, table, query]) => [name, await adminSnapshot(table, query, key)]
  ));
  const data = {};
  const warnings = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      const [name, value] = result.value;
      data[name] = value;
    } else {
      warnings.push(items[i][0]);
    }
  }

  return {
    ok: true,
    stats: {
      players: data.players?.total ?? null,
      vouchers: data.vouchers?.total ?? null,
      unused: data.unused?.total ?? null,
      redeemed: data.redeemed?.total ?? null
    },
    players: (data.players?.rows || []).map(x => ({
      userId: x.userId, name: x.name, email: x.email, wallet: x.wallet,
      wins: x.wins, losses: x.losses, rounds: x.rounds
    })),
    vouchers: (data.vouchers?.rows || []).map(x => ({
      code: x.code, coins: x.coins, isRedeemed: x.isRedeemed,
      redeemedBy: x.redeemedBy, createdAt: x.$createdAt
    })),
    rounds: (data.rounds?.rows || []).map(x => ({
      roundId: x.roundId, status: x.status, winningNumber: x.winningNumber,
      endsAt: x.endsAt
    })),
    games: (data.games?.rows || []).map(x => ({
      userId: x.userId, gameId: x.gameId, score: x.score,
      playedAt: x.playedAt || x.$createdAt, verified: x.verified
    })),
    warnings
  };
}

// ADMIN WINNING REPORT V1. Read-only; never changes draw results or wallet balances.
async function adminRoundReport(user, b, key) {
  if (!dashboardIsAdmin(user))
    return { ok: false, error: "Admin access denied" };

  const roundId = typeof b.roundId === "string" ? b.roundId.trim() : "";
  if (!/^r_\d{17}$/.test(roundId))
    return { ok: false, error: "Invalid round ID" };

  const round = await stored(roundId, key);
  if (!valid(round))
    return { ok: false, error: "Winning result unavailable for this round" };

  // Read every page for exact counts; refuse incomplete reports instead of guessing.
  const all = [];
  let cursor = null;
  for (let page = 0; page < 31; page++) {
    const queries = [
      eq("roundId", roundId),
      order("$createdAt", "asc"),
      lim(100)
    ];
    if (cursor) queries.push({ method: "cursorAfter", values: [cursor] });
    const batch = await rows("game_entries", queries, key);
    if (all.length + batch.length > 3000)
      return { ok: false, error: "Report exceeds 3000 entries; use a paginated export" };
    all.push(...batch);
    if (batch.length < 100) break;
    const next = batch[batch.length - 1]?.$id;
    if (!next || next === cursor)
      return { ok: false, error: "Report pagination incomplete; retry" };
    cursor = next;
    if (page === 30)
      return { ok: false, error: "Report pagination limit reached" };
  }

  const winner = round.winningNumber;
  const allPlayerIds = new Set();
  const winners = new Map();
  let totalStakedVC = 0, winningEntries = 0, winningStakedVC = 0;
  let expectedPayoutVC = 0, creditedPayoutVC = 0;
  let pendingEntries = 0, winningPendingEntries = 0, inconsistencies = 0;

  for (const entry of all) {
    const stake = entry.stakeVc;
    if (!Number.isSafeInteger(stake) || stake < 1 ||
        !Number.isInteger(entry.selectNumber) ||
        entry.selectNumber < 1 || entry.selectNumber > 9 ||
        typeof entry.userId !== "string" || !entry.userId)
      return { ok: false, error: "Invalid entry data; report needs review" };

    totalStakedVC += stake;
    allPlayerIds.add(entry.userId);
    if (entry.status === "pending") pendingEntries++;
    const won = entry.selectNumber === winner;
    if (!won) {
      if (entry.status !== "lost" && entry.status !== "pending") inconsistencies++;
      continue;
    }

    winningEntries++;
    winningStakedVC += stake;
    const payout = stake * 8;
    expectedPayoutVC += payout;
    if (!winners.has(entry.userId)) winners.set(entry.userId, {
      userId: entry.userId, entries: 0, stakedVC: 0,
      expectedPayoutVC: 0, creditedPayoutVC: 0,
      pendingEntries: 0, issues: 0
    });
    const player = winners.get(entry.userId);
    player.entries++;
    player.stakedVC += stake;
    player.expectedPayoutVC += payout;
    if (entry.status === "won" && entry.payoutVc === payout) {
      creditedPayoutVC += payout;
      player.creditedPayoutVC += payout;
    } else if (entry.status === "pending") {
      winningPendingEntries++;
      player.pendingEntries++;
    } else {
      inconsistencies++;
      player.issues++;
    }
  }

  const players = [...winners.values()].sort((a, b) =>
    b.expectedPayoutVC - a.expectedPayoutVC || a.userId.localeCompare(b.userId));
  return {
    ok: true, roundId, winningNumber: winner, endsAt: round.endsAt,
    totalPlayers: allPlayerIds.size, totalEntries: all.length, totalStakedVC,
    winningPlayers: players.length, winningEntries, winningStakedVC,
    expectedPayoutVC, creditedPayoutVC,
    unpaidPayoutVC: expectedPayoutVC - creditedPayoutVC,
    pendingEntries, winningPendingEntries, inconsistencies,
    players: players.slice(0, 100), detailsTruncated: players.length > 100
  };
}

async function adminFindPlayer(user, b, key) {
  if (!dashboardIsAdmin(user))
    return { ok: false, error: 'Admin access denied' };
  const target = typeof b.userId === 'string' ? b.userId.trim() : '';
  if (!/^[a-zA-Z0-9._-]{1,36}$/.test(target))
    return { ok: false, error: 'Invalid Player ID' };
  const matching = await rows('user_profiles', [eq('userId', target), lim(2)], key);
  return {
    ok: true,
    players: matching.map(x => ({
      userId: x.userId, name: x.name, email: x.email, wallet: x.wallet,
      wins: x.wins, losses: x.losses, rounds: x.rounds
    }))
  };
}

async function grantCoins(admin, b, key) {
  const allowed = (process.env.ADMIN_USER_IDS || "")
    .split(",").map(x => x.trim()).filter(Boolean);

  if (!allowed.includes(admin))
    return { ok: false, error: "Admin access denied" };

  if (typeof b.targetUserId !== "string" ||
      !b.targetUserId.trim() ||
      !Number.isSafeInteger(b.amount) ||
      b.amount < 1 || b.amount > 100000)
    return {
      ok: false,
      error: "Invalid user or amount (1-100000)"
    };

  const p = await profile(b.targetUserId.trim(), key);
  await transact(key, [
    op("increment", "user_profiles", p.$id, {
      column: "wallet",
      value: b.amount,
      max: 900000000
    })
  ]);

  return {
    ok: true,
    message: "Virtual coins credited",
    targetUserId: b.targetUserId,
    amount: b.amount
  };
}


// SAMRAT UNIFIED VC REQUESTS V1
// Uses the same vc_requests table already used by the legacy VC approval function.
// Set VC_REQUESTS_TABLE_ID in game-wallet only if its actual Appwrite table ID differs.
const vcRequestTable = () => {
  const table = (process.env.VC_REQUESTS_TABLE_ID || 'vc_requests').trim();
  if (!/^[a-zA-Z0-9._-]{1,36}$/.test(table)) {
    throw Error('Invalid VC requests table configuration');
  }
  return table;
};

async function sendVCTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  const body = JSON.stringify({chat_id: chatId, text: message});
  try {
    return await new Promise((resolve, reject) => {
      const r = https.request('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST', timeout: 12000,
        headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}
      }, response => {
        let raw = '';
        response.on('data', chunk => { raw += chunk; if (raw.length > 64000) response.destroy(); });
        response.on('end', () => {
          try {
            const answer = JSON.parse(raw);
            resolve(response.statusCode >= 200 && response.statusCode < 300 && answer.ok === true);
          } catch { resolve(false); }
        });
      });
      r.on('timeout', () => r.destroy(new Error('Telegram timeout')));
      r.on('error', reject);
      r.end(body);
    });
  } catch { return false; }
}

const vcClean = value => String(value ?? '').replace(/[<>]/g, '').slice(0,160);

async function requestVC(user, b, key) {
  const amount = Number(b.amount);
  if (![20, 50, 100, 200].includes(amount))
    return {ok:false,error:'Choose 20, 50, 100 or 200 VC'};

  const table = vcRequestTable();
  const player = await profile(user, key);

  let latest;
  try {
    // Avoid requiring a new index in the existing table; latest 100 is sufficient for initial rollout.
    latest = await rows(table, [order('$createdAt','desc'), lim(100)], key);
  } catch (e) {
    if ([400, 404].includes(e.status))
      return {ok:false,error:'VC requests table unavailable. Check game-wallet VC_REQUESTS_TABLE_ID.'};
    throw e;
  }
  const pending = latest.find(row => row.userId === user && row.status === 'pending');
  if (pending) return {
    ok:true, created:false, requestId:pending.$id, amount:pending.amount,
    status:'pending', telegramNotified:null,
    message:'Your earlier VC request is still pending admin review'
  };

  // Duplicate clicks in the same 20-minute window resolve to one deterministic request ID.
  const bucket = Math.floor((Date.now() + OFFSET) / ROUND_MS);
  const requestId = 'vcr_' + createHash('sha256').update(user+'|'+bucket).digest('hex').slice(0,30);
  let row;
  try {
    row = await request('POST', tablePath(table), key, {
      rowId:requestId,
      data:{userId:user,amount,status:'pending'}
    });
  } catch (e) {
    if (e.status === 409) {
      // The request may already have been created; do not accidentally generate another.
      const existing = await request('GET', tablePath(table) + '/' + requestId, key);
      return {ok:true,created:false,requestId,amount:existing.amount,
        status:existing.status,telegramNotified:null,message:'Request already recorded in this interval'};
    }
    if ([400,404].includes(e.status))
      return {ok:false,error:'VC requests table could not accept this request. Check table ID and columns.'};
    throw e;
  }

  const message = [
    'SAMRAT X-TREME | NEW VC REQUEST',
    'Request ID: '+vcClean(row.$id),
    'Player: '+vcClean(player.name),
    'Player ID: '+vcClean(user),
    'Email: '+vcClean(player.email),
    'Requested: '+amount+' VC',
    'Current wallet: '+player.wallet+' VC',
    'Status: PENDING',
    'Review (admin login): https://samratxtreme.online/admin-vc-requests.html',
    'Approve/reject only in the Admin Control Room. No auto-credit.'
  ].join('\n');

  const telegramNotified = await sendVCTelegram(message);
  return {ok:true,created:true,requestId:row.$id,amount,status:'pending',
    telegramNotified,message:'Request saved for admin approval'};
}

async function adminListVCRequests(user, key) {
  if (!dashboardIsAdmin(user))
    return {ok:false,error:'Admin access denied'};
  const table = vcRequestTable();
  const found = await rows(table, [order('$createdAt','desc'), lim(100)], key);
  const requests = found.map(row => ({
    requestId:row.$id, userId:row.userId, amount:row.amount,
    status:row.status, createdAt:row.$createdAt
  }));
  return {ok:true, requests, limit:100,
    pending:requests.filter(r=>r.status==='pending').length};
}

async function adminDecideVCRequest(user, b, key) {
  if (!dashboardIsAdmin(user))
    return {ok:false,error:'Admin access denied'};
  const requestId = typeof b.requestId === 'string' ? b.requestId.trim() : '';
  const decision = b.decision;
  if (!/^[a-zA-Z0-9._-]{1,36}$/.test(requestId) || !['approved','rejected'].includes(decision))
    return {ok:false,error:'Invalid request ID or decision'};

  const table = vcRequestTable();
  const entry = await request('GET', tablePath(table)+'/'+requestId, key);
  if (entry.status !== 'pending')
    return {ok:false,error:'Request already handled: '+entry.status};
  if (!Number.isSafeInteger(entry.amount) || entry.amount < 1 || entry.amount > 100000 ||
      typeof entry.userId !== 'string' || !/^[a-zA-Z0-9._-]{1,36}$/.test(entry.userId))
    return {ok:false,error:'Request details invalid; no credit made'};

  const operations = [op('update', table, entry.$id, {status:decision})];
  if (decision === 'approved') {
    const player = await profile(entry.userId, key);
    operations.push(op('increment','user_profiles',player.$id,{
      column:'wallet',value:entry.amount,max:900000000
    }));
  }

  try {
    // One atomic commit changes request status and wallet together.
    // Conflicting concurrent approval attempts must not double-credit.
    await transact(key, operations);
  } catch (e) {
    if (e.status === 409)
      return {ok:false,error:'Request was handled or wallet changed. Refresh before trying again.'};
    throw e;
  }

  const telegramNotified = await sendVCTelegram([
    'SAMRAT X-TREME | VC REQUEST '+decision.toUpperCase(),
    'Request ID: '+vcClean(requestId),
    'Player ID: '+vcClean(entry.userId),
    'Amount: '+entry.amount+' VC',
    decision === 'approved' ? 'Coins credited once in the same database transaction.' : 'No coins credited.'
  ].join('\n'));

  return {ok:true,requestId,userId:entry.userId,amount:entry.amount,
    status:decision,telegramNotified};
}

// Speed Tap and Memory X games

const GAME_IDS = ["speed_tap", "memory_x", "memory_x_24", "math_challenge"];

const SYMBOLS = [
  "🌟", "⚡", "💎", "🔥", "🚀", "👑",
  "🎯", "🦁", "🌈", "🍀", "🌙", "🪐"
];

const speedLevels = {
  easy: 1400,
  medium: 900,
  extreme: 550
};

const scoreId = sessionId => "s_" +
  createHash("sha256")
    .update(sessionId).digest("hex").slice(0, 30);

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeMathQuestion() {
  const a = randomInt(1, 16), b = randomInt(1, 13), kind = randomInt(3);
  const answer = kind === 0 ? a + b : kind === 1 ? a * b : Math.abs(a - b);
  const label = kind === 0 ? a + ' + ' + b + ' = ?' :
    kind === 1 ? a + ' × ' + b + ' = ?' :
      Math.max(a, b) + ' − ' + Math.min(a, b) + ' = ?';
  const options = new Set([answer]);
  while (options.size < 4) options.add(Math.max(0, answer + randomInt(17) - 8));
  return { label, options: shuffle([...options]), answer };
}

function verifyMath(questions, events, elapsedMs) {
  if (!Array.isArray(questions) || questions.length !== 10 ||
      !Array.isArray(events) || events.length > 10 ||
      !Number.isInteger(elapsedMs) || elapsedMs < 1000 || elapsedMs > 90000)
    return null;
  let score = 0, previous = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i], q = questions[i];
    if (!q || !Array.isArray(q.options) || q.options.length !== 4 ||
        !Number.isInteger(q.answer) ||
        !Array.isArray(e) || e.length !== 2 ||
        !Number.isInteger(e[0]) || e[0] < 0 || e[0] >= 4 ||
        !Number.isInteger(e[1]) || e[1] < 0 || e[1] > elapsedMs ||
        e[1] < previous) return null;
    previous = e[1];
    if (q.options[e[0]] === q.answer) score++;
  }
  return { score, durationMs: elapsedMs };
}

async function startGame(user, b, key) {
  if (!GAME_IDS.includes(b.gameId))
    return { ok: false, error: "Invalid game" };

  if (b.gameId === "speed_tap" &&
      !Object.hasOwn(speedLevels, b.level))
    return { ok: false, error: "Invalid difficulty" };

  const now = Date.now();
  const gameId = b.gameId;
  const level = gameId === "speed_tap" ? b.level : "standard";

  let challenge;

  if (gameId === "memory_x_24") {
    challenge = {
      deck: shuffle([...SYMBOLS, ...SYMBOLS])
    };
  } else if (gameId === "memory_x") {
    const oldSymbols = SYMBOLS.slice(0, 8);
    challenge = {
      deck: shuffle([...oldSymbols, ...oldSymbols])
    };
  } else if (gameId === 'math_challenge') {
    challenge = { questions: Array.from({ length: 10 }, makeMathQuestion) };
  } else {
    challenge = {
      targets: Array.from(
        { length: 500 }, () => randomInt(9)
      ),
      interval: speedLevels[level]
    };
  }

  const sessionId = "g_" + randomBytes(15).toString("hex");
  const startedAt = new Date(now).toISOString();
  const expiresAt = new Date(
    now + (gameId === "speed_tap" ? 40000 : gameId === "math_challenge" ? 120000 : 70000)
  ).toISOString();

  await request("POST", tablePath("game_sessions"), key, {
    rowId: sessionId,
    data: {
      userId: user,
      gameid: gameId,
      challenge: JSON.stringify({ ...challenge, level }),
      startedAt,
      expiresAt,
      completed: false
    }
  });

  return {
    ok: true,
    sessionId,
    gameId,
    level,
    challenge: gameId === 'math_challenge' ? {
      questions: challenge.questions.map(({label, options}) => ({label, options}))
    } : challenge,
    startedAt,
    expiresAt
  };
}

function verifyMemory(deck, events, elapsedMs) {
  if (!Array.isArray(deck) ||
      ![16, 24].includes(deck.length) ||
      !Array.isArray(events) ||
      events.length > 500) return null;

  if (!Number.isInteger(elapsedMs) ||
      elapsedMs < 1000 || elapsedMs > 60000) return null;

  const matched = new Set();
  let open = null;
  let lockedUntil = -1;
  let previousTime = -1;

  for (const e of events) {
    if (!Array.isArray(e) || e.length !== 2)
      return null;

    const [i, t] = e;
    if (!Number.isInteger(i) || i < 0 || i >= deck.length ||
        !Number.isInteger(t) || t < 0 || t > elapsedMs ||
        t < previousTime || t < lockedUntil ||
        matched.has(i) || i === open) return null;

    previousTime = t;

    if (open === null) {
      open = i;
      continue;
    }

    if (deck[open] === deck[i]) {
      matched.add(open);
      matched.add(i);
    } else {
      lockedUntil = t + 700;
    }
    open = null;
  }

  return {
    score: matched.size / 2,
    durationMs: elapsedMs
  };
}

function verifySpeed(challenge, events, elapsedMs) {
  if (!Array.isArray(events) ||
      events.length > 1500 ||
      !Number.isInteger(elapsedMs) ||
      elapsedMs < 29500 ||
      elapsedMs > 30500) return null;

  let score = 0, hits = 0, misses = 0;
  let cursor = 0;
  let target = challenge.targets[0];
  let last = -1;
  let targetAt = 0;
  const interval = challenge.interval;

  for (const e of events) {
    if (!Array.isArray(e) || e.length !== 2)
      return null;

    const [tile, t] = e;
    if (!Number.isInteger(tile) || tile < 0 || tile > 8 ||
        !Number.isInteger(t) || t < last ||
        t < 0 || t >= 30000) return null;

    last = t;

    while (t - targetAt >= interval) {
      score = Math.max(0, score - 2);
      misses++;
      targetAt += interval;
      cursor++;
      target = challenge.targets[cursor];
      if (target === undefined) return null;
    }

    if (tile === target) {
      score += 10;
      hits++;
      targetAt = t;
      cursor++;
      target = challenge.targets[cursor];
      if (target === undefined) return null;
    } else {
      score = Math.max(0, score - 5);
      misses++;
    }
  }

  while (30000 - targetAt >= interval) {
    score = Math.max(0, score - 2);
    misses++;
    targetAt += interval;
  }

  return { score, durationMs: 30000, hits, misses };
}

async function finishGame(user, b, key) {
  if (typeof b.sessionId !== "string" ||
      !/^g_[a-f0-9]{30}$/.test(b.sessionId))
    return { ok: false, error: "Invalid session" };

  const session = await request(
    "GET",
    tablePath("game_sessions") + "/" + b.sessionId,
    key
  );

  if (session.userId !== user || session.completed)
    return {
      ok: false,
      error: "Session unavailable or already submitted"
    };

  const started = Date.parse(session.startedAt);
  const now = Date.now();

  if (!Number.isFinite(started) ||
      now > Date.parse(session.expiresAt) ||
      now < started)
    return { ok: false, error: "Session expired" };

  let challenge;
  try {
    challenge = JSON.parse(session.challenge);
  } catch {
    return { ok: false, error: "Invalid challenge" };
  }

  const elapsedMs = b.elapsedMs;
  const actual = now - started;

  if (!Number.isInteger(elapsedMs) ||
      Math.abs(actual - elapsedMs) > 3000)
    return { ok: false, error: "Game timing mismatch" };

  let verified = null;

  if (session.gameid === "memory_x" ||
      session.gameid === "memory_x_24") {
    const expectedLength =
      session.gameid === "memory_x_24" ? 24 : 16;

    if (Array.isArray(challenge.deck) &&
        challenge.deck.length === expectedLength)
      verified = verifyMemory(
        challenge.deck, b.events, elapsedMs
      );
  } else if (session.gameid === "speed_tap" &&
             Object.hasOwn(speedLevels, challenge.level)) {
    verified = verifySpeed(
      challenge, b.events, elapsedMs
    );
  } else if (session.gameid === "math_challenge") {
    verified = verifyMath(challenge.questions, b.events, elapsedMs);
  }

  if (!verified)
    return { ok: false, error: "Invalid game replay" };

  try {
    await transact(key, [
      op("update", "game_sessions", session.$id, {
        completed: true
      }),
      op("create", "game_scores", scoreId(session.$id), {
        userId: user,
        gameId: session.gameid,
        score: verified.score,
        durationMs: verified.durationMs,
        level: challenge.level,
        verified: true,
        playedAt: new Date().toISOString()
      })
    ]);
  } catch (e) {
    if (e.status === 409)
      return { ok: false, error: "Session already submitted" };
    throw e;
  }

  return {
    ok: true,
    verified: true,
    gameid: session.gameid,
    ...verified
  };
}

async function getLeaderboard(gameId, key) {
  if (!GAME_IDS.includes(gameId))
    return { ok: false, error: "Invalid game" };

  const result = await rows("game_scores", [
    eq("gameId", gameId),
    eq("verified", true),
    order("score", "desc"),
    lim(100)
  ], key);

  const bestByUser = new Map();

  for (const r of result) {
    if (typeof r.userId !== "string" ||
        !Number.isSafeInteger(r.score) ||
        r.score < 0) continue;

    const previous = bestByUser.get(r.userId);

    if (!previous ||
        r.score > previous.score ||
        (r.score === previous.score &&
         r.durationMs < previous.durationMs)) {
      bestByUser.set(r.userId, {
        score: r.score,
        durationMs: r.durationMs
      });
    }
  }

  const entries = [...bestByUser]
    .sort((a, b) =>
      b[1].score - a[1].score ||
      a[1].durationMs - b[1].durationMs
    )
    .slice(0, 10)
    .map(([userId, value], i) => ({
      rank: i + 1,
      player: "Player " + userId.slice(0, 6),
      score: value.score,
      durationMs: gameId.startsWith("memory_x") || gameId === "math_challenge"
        ? value.durationMs : null
    }));

  return {
    ok: true,
    gameId,
    verifiedOnly: true,
    entries
  };
}

export default async ({ req, res, error }) => {
  if (req.method !== "POST")
    return send(res, 405, {
      ok: false,
      error: "POST required"
    });

  let b;

  try {
    b = req.headers["x-appwrite-trigger"] === "schedule"
      ? { action: "get_last_result" }
      : typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    if (!b || typeof b !== "object" || Array.isArray(b))
      throw Error();
  } catch {
    return send(res, 400, {
      ok: false,
      error: "Invalid JSON"
    });
  }

  const action = b.action;
  const user = req.headers["x-appwrite-user-id"];
  const key = req.headers["x-appwrite-key"];

  if (![
    "get_wallet",
    "get_round",
    "get_last_result",
    "place_entry",
    "grant_coins",
    "request_vc",
    "admin_list_vc_requests",
    "admin_decide_vc_request",
    "redeem_voucher",
    "generate_vouchers",
    "admin_dashboard",
    "admin_round_report",
    "admin_find_player",
    "unused_vouchers",
    "my_entries",
    "my_history",
    "register_profile",
    "get_leaderboard",
    "start_game",
    "finish_game"
  ].includes(action))
    return send(res, 400, {
      ok: false,
      error: "Unsupported action"
    });

  if (!key)
    return send(res, 503, {
      ok: false,
      error: "Function API key missing"
    });

  if (!user && ![
    "get_round",
    "get_last_result",
    "get_leaderboard"
  ].includes(action))
    return send(res, 401, {
      ok: false,
      error: "Sign in required"
    });

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

    if (action === "get_last_result")
      return send(res, 200, await lastResult(key));

    if (action === "get_round") {
      const current = roundFor(Date.now());
      const r = await stored(current.roundId, key);
      return send(res, 200, {
        ok: true,
        ...current,
        serverTime: new Date().toISOString(),
        acceptingEntries:
          current.status === "open" &&
          (!r || r.status === "open"),
        mode: "free_virtual_coins"
      });
    }

    if (action === "register_profile") {
      const existing = await rows(
        "user_profiles",
        [eq("userId", user), lim(2)],
        key
      );

      if (existing.length)
        return send(res, 200, {
          ok: true,
          created: false
        });

      try {
        await request("POST", tablePath("user_profiles"), key, {
          rowId: user,
          data: {
            userId: user,
            name: typeof b.name === "string"
              ? b.name.slice(0, 80) : "",
            email: typeof b.email === "string"
              ? b.email.slice(0, 160) : "",
            wallet: 0,
            wins: 0,
            losses: 0,
            rounds: 0,
            referralPoints: 0,
            rewardPoints: 0,
            totalRewardsClaimed: 0
          }
        });
      } catch (e) {
        if (e.status !== 409) throw e;
      }

      return send(res, 200, {
        ok: true,
        created: true
      });
    }

    if (action === "get_wallet") {
      const p = await profile(user, key);
      return send(res, 200, {
        ok: true,
        userId: user,
        wallet: p.wallet,
        wins: p.wins || 0,
        losses: p.losses || 0,
        rounds: p.rounds || 0,
        isAdmin: (process.env.ADMIN_USER_IDS || "")
          .split(",")
          .map(x => x.trim())
          .includes(user)
      });
    }

    if (action === "place_entry") {
      const x = await placeEntry(user, b, key);
      return send(res, x.ok ? 200 : 409, x);
    }

    if (action === "request_vc") {
      const x = await requestVC(user, b, key);
      return send(res, x.ok ? 200 : 400, x);
    }

    if (action === "admin_list_vc_requests") {
      const x = await adminListVCRequests(user, key);
      return send(res, x.ok ? 200 : 403, x);
    }

    if (action === "admin_decide_vc_request") {
      const x = await adminDecideVCRequest(user, b, key);
      return send(res, x.ok ? 200 : 409, x);
    }

if (action === "admin_dashboard") {
  const d = await adminDashboard(user, key);
  return send(res, d.ok ? 200 : 403, d);
}
if (action === "admin_round_report") {
  const d = await adminRoundReport(user, b, key);
  return send(res, d.ok ? 200 : 403, d);
}
if (action === "admin_find_player") {
  const d = await adminFindPlayer(user, b, key);
  return send(res, d.ok ? 200 : 403, d);
}
if (action === "generate_vouchers") {
    const x=await makeVouchers(user,b,key);
    return send(res,x.ok?200:403,x);
  }
  if (action === "unused_vouchers") {
    const x=await unusedVouchers(user,key);
    return send(res,x.ok?200:403,x);
  }
  if (action === "redeem_voucher") {
      const result = await redeemVoucher(user, b, key);
      return send(res, result.ok ? 200 : 400, result);
    }

    if (action === "grant_coins") {
      const x = await grantCoins(user, b, key);
      return send(res, x.ok ? 200 : 403, x);
    }


    if (action === "my_history") {
      const data = await rows("game_entries", [
        eq("userId", user),
        order("$createdAt", "desc"),
        lim(100)
      ], key);

      const groups = new Map();

      for (const e of data) {
        if (!groups.has(e.roundId)) {
          if (groups.size >= 10) continue;
          groups.set(e.roundId, []);
        }

        groups.get(e.roundId).push({
          number: e.selectNumber,
          stakeVC: e.stakeVc,
          payoutVC: e.payoutVc || 0,
          status: e.status,
          createdAt: e.$createdAt
        });
      }

      const rounds = [...groups].map(([roundId, entries]) => ({
        roundId,
        entries,
        spentVC: entries.reduce((s, x) => s + x.stakeVC, 0),
        wonVC: entries.reduce((s, x) => s + x.payoutVC, 0)
      }));

      return send(res, 200, {
        ok: true,
        rounds,
        limitedTo: 100
      });
    }

    if (action === "my_entries") {
      const current = roundFor(Date.now());
      const x = await rows("game_entries", [
        eq("userId", user),
        eq("roundId", current.roundId),
        lim(10)
      ], key);

      return send(res, 200, {
        ok: true,
        entries: x.map(y => ({
          number: y.selectNumber,
          stakeVC: y.stakeVc,
          status: y.status,
          payoutVC: y.payoutVc
        }))
      });
    }
  } catch (e) {
    error("Game backend: " + e.message);
    return send(res, e.status === 409 ? 409 : 500, {
      ok: false,
      error: "Game service error. Check function logs.",
      code: e.status || 500
    });
  }
};
