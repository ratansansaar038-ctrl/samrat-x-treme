
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
const MAX_SELECTIONS = 9;

function reply(res, status, data) {
  return res.json(data, status);
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
      request.destroy(
        new Error("Database timeout")
      );
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

  const status =
    now >= end
      ? "closed"
      : now >= closesAt
        ? "locked"
        : "open";

  return {
    roundId,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    entryClosesAt: new Date(closesAt).toISOString(),
    serverTime: new Date(now).toISOString(),
    status
  };
}

function validateSelections(selections) {
  if (
    !Array.isArray(selections) ||
    selections.length < 1 ||
    selections.length > MAX_SELECTIONS
  ) {
    throw new Error(
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
      throw new Error(
        "Each number must be from 1 to 9"
      );
    }

    if (seen.has(item.number)) {
      throw new Error(
        "Duplicate selected number"
      );
    }

    if (!ALLOWED_STAKES.includes(item.stakeVC)) {
      throw new Error(
        "Stake must be 20, 50 or 100 VC"
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

  if (rows.length !== 1) {
    throw new Error(
      "User profile not uniquely found"
    );
  }

  const profile = rows[0];

  if (
    !Number.isSafeInteger(profile.wallet) ||
    profile.wallet < 0
  ) {
    throw new Error(
      "Invalid wallet balance"
    );
  }

  return profile;
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
  } catch {
    return reply(res, 400, {
      ok: false,
      error: "Invalid JSON"
    });
  }

  const action = body?.action;

  // Real wallet mutations remain disabled.
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
      error:
        "Transactional game settlement not enabled"
    });
  }

  const supported = [
    "get_wallet",
    "get_round",
    "preview_entries"
  ];

  if (!supported.includes(action)) {
    return reply(res, 400, {
      ok: false,
      error: "Unsupported action"
    });
  }

  const userId =
    req.headers["x-appwrite-user-id"];

  const apiKey =
    req.headers["x-appwrite-key"];

  if (!userId) {
    return reply(res, 401, {
      ok: false,
      error: "Login required"
    });
  }

  if (!apiKey) {
    return reply(res, 503, {
      ok: false,
      error:
        "Function authentication unavailable"
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

    const round = getCurrentRound();

    const existingRounds = await getRows(
      ROUNDS_TABLE,
      [
        queryEqual(
          "roundId",
          round.roundId
        ),
        queryLimit(2)
      ],
      apiKey
    );

    if (existingRounds.length > 1) {
      return reply(res, 409, {
        ok: false,
        error: "Duplicate round records"
      });
    }

    const storedRound = existingRounds[0];

    if (action === "get_round") {
      return reply(res, 200, {
        ok: true,
        ...round,
        status:
          storedRound?.status || round.status,
        winningNumber:
          storedRound?.status === "settled"
            ? storedRound.winningNumber
            : null,
        acceptingEntries: false,
        mode: "read_only"
      });
    }

    // Preview only: no entry is created,
    // and no wallet balance is changed.
    if (action === "preview_entries") {
      if (round.status !== "open") {
        return reply(res, 409, {
          ok: false,
          error: "Entry window closed",
          round
        });
      }

      if (
        storedRound &&
        storedRound.status !== "open"
      ) {
        return reply(res, 409, {
          ok: false,
          error: "Round is not open"
        });
      }

      if (
        body.roundId &&
        body.roundId !== round.roundId
      ) {
        return reply(res, 409, {
          ok: false,
          error: "Round ID mismatch"
        });
      }

      let selectionData;

      try {
        selectionData = validateSelections(
          body.selections
        );
      } catch (validationError) {
        return reply(res, 400, {
          ok: false,
          error: validationError.message
        });
      }

      const profile = await findProfile(
        userId,
        apiKey
      );

      const sufficientBalance =
        profile.wallet >=
        selectionData.totalStakeVC;

      return reply(res, 200, {
        ok: true,
        action: "preview_entries",
        roundId: round.roundId,
        selections:
          selectionData.selections,
        totalStakeVC:
          selectionData.totalStakeVC,
        walletVC: profile.wallet,
        sufficientBalance,
        walletAfterVC:
          sufficientBalance
            ? profile.wallet -
              selectionData.totalStakeVC
            : null,
        acceptingEntries: false,
        committed: false,
        message:
          "Preview only. No VC deducted."
      });
    }
  } catch (err) {
    error(
      "Game backend error: " +
      err.message
    );

    return reply(res, 500, {
      ok: false,
      error: "Game service unavailable"
    });
  }
};
