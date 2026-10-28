
import https from "node:https";

const respond = (res, status, data) => res.json(data, status);

const validId = (value) =>
  typeof value === "string" &&
  /^[a-zA-Z0-9._-]{1,36}$/.test(value);

function apiRequest(method, path, data, env, queries = []) {
  const endpoint = new URL(
    env.APPWRITE_ENDPOINT || "https://sgp.cloud.appwrite.io/v1"
  );

  if (endpoint.protocol !== "https:") {
    throw new Error("HTTPS endpoint required");
  }

  const base = endpoint.pathname.replace(/\/$/, "");
  const url = new URL(endpoint.origin + base + path);

  for (const query of queries) {
    url.searchParams.append("queries[]", JSON.stringify(query));
  }

  const payload = data === undefined
    ? undefined
    : JSON.stringify(data);

  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method,
      headers: {
        "X-Appwrite-Project":
          env.APPWRITE_PROJECT_ID || "6a7f2add0011a7bfc21a",
        "X-Appwrite-Key": env.APPWRITE_API_KEY,
        "Content-Type": "application/json",
        ...(payload
          ? { "Content-Length": Buffer.byteLength(payload) }
          : {})
      },
      timeout: 12000
    }, (response) => {
      let text = "";

      response.setEncoding("utf8");

      response.on("data", (chunk) => {
        text += chunk;

        if (text.length > 1024 * 1024) {
          response.destroy(new Error("Response too large"));
        }
      });

      response.on("end", () => {
        let body;

        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          return reject(new Error("Invalid API response"));
        }

        if (response.statusCode < 200 ||
            response.statusCode >= 300) {
          return reject(new Error(
            `Appwrite API HTTP ${response.statusCode}: ` +
            String(body?.type || body?.message || "request failed")
              .slice(0, 160)
          ));
        }

        resolve(body);
      });
    });

    request.on("timeout", () =>
      request.destroy(new Error("API connection timed out"))
    );

    request.on("error", reject);

    if (payload) request.write(payload);

    request.end();
  });
}

export default async ({ req, res, log, error }) => {
  if (req.method !== "POST") {
    return respond(res, 405, {
      ok: false,
      error: "Method not allowed"
    });
  }

  const actorId = req.headers["x-appwrite-user-id"];
  
const env = {
  ...process.env,
  APPWRITE_API_KEY: req.headers["x-appwrite-key"]
};
  

  if (!actorId ||
      !env.ADMIN_USER_ID ||
      actorId !== env.ADMIN_USER_ID) {
    return respond(res, 403, {
      ok: false,
      error: "Admin access required"
    });
  }

  if (![
    env.APPWRITE_API_KEY,
    env.APPWRITE_DATABASE_ID,
    env.USERS_PROFILES_TABLE_ID
  ].every(Boolean)) {
    return respond(res, 503, {
      ok: false,
      error: "Backend configuration incomplete"
    });
  }

  let input;

  try {
    input = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;
  } catch {
    return respond(res, 400, {
      ok: false,
      error: "Invalid JSON"
    });
  }

  const dbPath =
    `/tablesdb/${encodeURIComponent(env.APPWRITE_DATABASE_ID)}/tables`;

  const profilePath =
    `${dbPath}/${encodeURIComponent(env.USERS_PROFILES_TABLE_ID)}/rows`;

  const findProfile = async (userId) => {
    const queries = [
      { method: "equal", attribute: "userId", values: [userId] },
      { method: "limit", values: [2] }
    ];

    const result = await apiRequest(
      "GET", profilePath, undefined, env, queries
    );

    return result.rows?.length === 1 ? result.rows[0] : null;
  };

  // ADMIN ADD VC
  if (input?.action === "add_vc") {
    const { userId, amount } = input;

    if (!validId(userId) ||
        !Number.isSafeInteger(amount) ||
        amount < 1 ||
        amount > 100000) {
      return respond(res, 400, {
        ok: false,
        error: "Invalid userId or amount"
      });
    }

    try {
      const profile = await findProfile(userId);

      if (!profile) {
        return respond(res, 404, {
          ok: false,
          error: "User profile not uniquely found"
        });
      }

      const previous = profile.wallet;

      if (!Number.isSafeInteger(previous) ||
          previous < 0 ||
          !Number.isSafeInteger(previous + amount)) {
        return respond(res, 409, {
          ok: false,
          error: "Invalid wallet balance"
        });
      }

      const updated = await apiRequest(
        "PATCH",
        `${profilePath}/${encodeURIComponent(profile.$id)}`,
        { data: { wallet: previous + amount } },
        env
      );

      log(`Admin granted ${amount} VC to profile ${profile.$id}`);

      return respond(res, 200, {
        ok: true,
        action: "add_vc",
        userId,
        added: amount,
        previous,
        balance: updated.wallet
      });
    } catch (e) {
      error(`VC grant error: ${e?.message || "unknown"}`);

      return respond(res, 500, {
        ok: false,
        error: "VC grant failed; inspect function logs"
      });
    }
  }

  // REWARD APPROVAL
  if (!env.REWARD_CLAIMS_TABLE_ID) {
    return respond(res, 503, {
      ok: false,
      error: "Backend configuration incomplete"
    });
  }

  const { claimId, decision } = input || {};

  if (!validId(claimId) ||
      !["approved", "rejected"].includes(decision)) {
    return respond(res, 400, {
      ok: false,
      error: "Use claimId and decision (approved/rejected)"
    });
  }

  const claimsPath =
    `${dbPath}/${encodeURIComponent(env.REWARD_CLAIMS_TABLE_ID)}/rows`;

  try {
    const claim = await apiRequest(
      "GET",
      `${claimsPath}/${encodeURIComponent(claimId)}`,
      undefined,
      env
    );

    if (!claim.userId ||
        !Number.isSafeInteger(claim.pointUsed) ||
        claim.pointUsed <= 0) {
      return respond(res, 409, {
        ok: false,
        error: "Claim data invalid"
      });
    }

    if (claim.status !== "pending") {
      return respond(res, 409, {
        ok: false,
        error: "Claim is not pending",
        status: claim.status
      });
    }

    const profile = await findProfile(claim.userId);

    if (!profile) {
      return respond(res, 409, {
        ok: false,
        error: "User profile not uniquely found"
      });
    }

    // Reward approval does not deduct wallet balance again.
    const updated = await apiRequest(
      "PATCH",
      `${claimsPath}/${encodeURIComponent(claimId)}`,
      { data: { status: decision } },
      env
    );

    log(`Claim ${claimId} moved to ${decision}`);

    return respond(res, 200, {
      ok: true,
      claimId: updated.$id,
      status: updated.status
    });
  } catch (e) {
    error(`Approval error: ${e?.message || "unknown"}`);

    return respond(res, 500, {
      ok: false,
      error: "Approval failed; inspect function logs"
    });
  }
};
