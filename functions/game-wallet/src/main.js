
import https from "node:https";

const ENDPOINT = "https://sgp.cloud.appwrite.io/v1";
const PROJECT_ID = "6a7f2add0011a7bfc21a";
const DATABASE_ID = "6a7f2d1d0035d9815939";
const PROFILES_TABLE = "user_profiles";
const ROUNDS_TABLE = "game_rounds";

const ROUND_MS = 20 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;
const ENTRY_CUTOFF_MS = 60 * 1000;
const ALLOWED_STAKES = [20, 50, 100];

function reply(res, status, data) {
  return res.json(data, status);
}

class GameError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function queryEqual(attribute, value) {
  return {
    method: "equal",
    attribute,
    values: [value]
  };
}

function queryLimit(value) {
  return {
    method: "limit",
    values: [value]
  };
}

function getRows(table, queries, apiKey) {
  const url = new URL(
    `${ENDPOINT}/tablesdb/${DATABASE_ID}/tables/${table}/rows`
  );

  for (const query of queries) {
    url.searchParams.append(
      "queries[]",
      JSON.stringify(query)
    );
  }

  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "X-Appwrite-Project": PROJECT_ID,
          "X-Appwrite-Key": apiKey,
          Accept: "application/json"
        },
        timeout: 10000
      },
      response => {
        let raw = "";

        response.on("data", chunk => {
          raw += chunk;
          if (raw.length > 1000000) {
            response.destroy(
              new Error("Response too large")
            );
          }
        });

        response.on("end", () => {
          try {
            const parsed = JSON.parse(raw);
            if (response.statusCode !== 200) {
              return reject(
                new Error(
                  `Database HTTP ${response.statusCode}`
                )
              );
            }
            resolve(parsed.rows || []);
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Database timeout"));
    });

    request.on("error", reject);
  });
}

function getCurrentRound(now = Date.now()) {
  const shifted = now + IST_OFFSET_MS;

  const start =
    Math.floor(shifted / ROUND_MS) * ROUND_MS -
    IST_OFFSET_MS;

  const end = start + ROUND_MS;
  const closesAt = end - ENTRY_CUTOFF_MS;

  const roundId =
    "r_" +
    new Date(start)
      .toISOString()
      .replace(/[-:.TZ]/g, "");

  return {
    roundId,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    entryClosesAt: new Date(closesAt).toISOString(),
    serverTime: new Date(now).toISOString(),
    status: now >= closesAt ? "locked" : "open"
  };
}

function validateSelections(selections) {
  if (
    !Array.isArray(selections) ||
    selections.length < 1 ||
    selections.length > 9
  ) {
    throw new GameError(
      400,
      "INVALID_SELECTIONS",
      "Select between 1 and 9 numbers"
    );
  }

  const seen = new Set();
  let totalStakeVC = 0;

  const normalized = selections.map(item => {
    if (
      !item ||
      !Number.isInteger(item.number) ||
      item.number < 1 ||
      item.number > 9
    ) {
      throw new GameError(
        400,
        "INVALID_NUMBER",
        "Number must be from 1 to 9"
      );
    }

    if (seen.has(item.number)) {
      throw new GameError(
        400,
        "DUPLICATE_NUMBER",
        "Same number selected twice"
      );
    }

    if (!ALLOWED_STAKES.includes(item.stakeVC)) {
      throw new GameError(
        400,
        "INVALID_STAKE",
        "Allowed stakes: 20, 50, 100 VC"
      );
    }

    seen.add(item.number);
    totalStakeVC += item.stakeVC;

    return {
      number: item.number,
      stakeVC: item.stakeVC,
      potentialPayoutVC: item.stakeVC * 8
    };
  });

  return {
    selections: normalized,
    totalStakeVC
  };
}

async function findProfile(userId, apiKey) {
  const rows = await getRows(
    PROFILES_TABLE,
    [
      queryEqual("userId", userId),
      queryLimit(2)
    ],
    apiKey
  );

  if (rows.length === 0) {
    throw new GameError(
      404,
      "PROFILE_NOT_FOUND",
      "No wallet profile exists for this account"
    );
  }

  if (rows.length > 1) {
    throw new GameError(
      409,
      "DUPLICATE_PROFILES",
      "Multiple wallet profiles found"
    );
  }

  const profile = rows[0];

  if (
    !Number.isSafeInteger(profile.wallet) ||
    profile.wallet < 0
  ) {
    throw new GameError(
      409,
      "INVALID_WALLET",
      "Wallet balance needs admin review"
    );
  }

  return profile;
}

async function getLastResult(apiKey) {
  const rows = await getRows(
    ROUNDS_TABLE,
    [
      queryEqual("status", "settled"),
      queryLimit(100)
    ],
    apiKey
  );

  const now = Date.now();

  const completed = rows.filter(row => {
    if (!/^r_\d{17}$/.test(row.roundId || "")) {
      return false;
    }

    if (
      !Number.isInteger(row.winningNumber) ||
      row.winningNumber < 1 ||
      row.winningNumber > 9
    ) {
      return false;
    }

    const digits = row.roundId.slice(2);
    const timestamp =
      digits.slice(0, 4) + "-" +
      digits.slice(4, 6) + "-" +
      digits.slice(6, 8) + "T" +
      digits.slice(8, 10) + ":" +
      digits.slice(10, 12) + ":" +
      digits.slice(12, 14) + "." +
      digits.slice(14, 17) + "Z";

    const start = Date.parse(timestamp);

    return Number.isFinite(start) &&
      start + ROUND_MS <= now;
  });

  completed.sort((a, b) =>
    b.roundId.localeCompare(a.roundId)
  );

  const latest = completed[0];

  return {
    ok: true,
    available: Boolean(latest),
    roundId: latest?.roundId ?? null,
    winningNumber: latest?.winningNumber ?? null,
    message: latest
      ? "Verified stored result"
      : "No verified result recorded yet"
  };
}

export default async ({ req, res, error }) => {
  if (req.method !== "POST") {
    return reply(res, 405, {
      ok: false,
      error: "POST required"
    });
  }

  let body;

  try {
    body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      throw new Error("Invalid body");
    }
  } catch {
    return reply(res, 400, {
      ok: false,
      error: "Invalid JSON"
    });
  }

  const action = body.action;

  if (
    [
      "play",
      "settle",
      "place_entries",
      "settle_round"
    ].includes(action)
  ) {
    return reply(res, 503, {
      ok: false,
      error: "Secure transactions not enabled",
      acceptingEntries: false
    });
  }

  if (
    ![
      "get_wallet",
      "get_round",
      "get_last_result",
      "preview_entries"
    ].includes(action)
  ) {
    return reply(res, 400, {
      ok: false,
      error: "Unsupported action"
    });
  }

  const userId = req.headers["x-appwrite-user-id"];
  const apiKey = req.headers["x-appwrite-key"];

  if (!userId) {
    return reply(res, 401, {
      ok: false,
      code: "LOGIN_REQUIRED",
      error: "Authenticated login required"
    });
  }

  if (!apiKey) {
    return reply(res, 503, {
      ok: false,
      code: "FUNCTION_KEY_MISSING",
      error: "Function API key unavailable"
    });
  }

  try {
    if (action === "get_wallet") {
      const profile = await findProfile(
        userId,
        apiKey
      );

      return reply(res, 200, {
        ok: true,
        userId,
        wallet: profile.wallet
      });
    }

    if (action === "get_last_result") {
      return reply(
        res,
        200,
        await getLastResult(apiKey)
      );
    }

    const round = getCurrentRound();

    const rounds = await getRows(
      ROUNDS_TABLE,
      [
        queryEqual("roundId", round.roundId),
        queryLimit(2)
      ],
      apiKey
    );

    if (rounds.length > 1) {
      throw new GameError(
        409,
        "DUPLICATE_ROUNDS",
        "Multiple round records found"
      );
    }

    const storedRound = rounds[0];

    if (action === "get_round") {
      const settled =
        storedRound?.status === "settled";

      return reply(res, 200, {
        ok: true,
        ...round,
        status: settled
          ? "settled"
          : storedRound?.status === "locked"
            ? "locked"
            : round.status,
        winningNumber: settled
          ? storedRound.winningNumber
          : null,
        acceptingEntries: false,
        mode: "read_only"
      });
    }

    if (round.status !== "open") {
      throw new GameError(
        409,
        "ENTRY_WINDOW_CLOSED",
        "Entry window is closed"
      );
    }

    if (
      storedRound &&
      storedRound.status !== "open"
    ) {
      throw new GameError(
        409,
        "ROUND_NOT_OPEN",
        "Round is not open"
      );
    }

    if (
      body.roundId &&
      body.roundId !== round.roundId
    ) {
      throw new GameError(
        409,
        "ROUND_MISMATCH",
        "Round ID mismatch"
      );
    }

    const selectionData = validateSelections(
      body.selections
    );

    const profile = await findProfile(
      userId,
      apiKey
    );

    const sufficientBalance =
      profile.wallet >= selectionData.totalStakeVC;

    return reply(res, 200, {
      ok: true,
      action: "preview_entries",
      roundId: round.roundId,
      selections: selectionData.selections,
      totalStakeVC: selectionData.totalStakeVC,
      walletVC: profile.wallet,
      sufficientBalance,
      walletAfterVC: sufficientBalance
        ? profile.wallet - selectionData.totalStakeVC
        : null,
      acceptingEntries: false,
      committed: false,
      message: "Preview only. No VC deducted."
    });

  } catch (err) {
    if (err instanceof GameError) {
      return reply(res, err.status, {
        ok: false,
        code: err.code,
        error: err.message
      });
    }

    error("Game backend error: " + err.message);

    return reply(res, 500, {
      ok: false,
      code: "BACKEND_ERROR",
      error: "Game service unavailable"
    });
  }
};
