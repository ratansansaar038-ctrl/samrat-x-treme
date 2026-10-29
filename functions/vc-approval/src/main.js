
import https from "node:https";

const respond = (res, status, data) => res.json(data, status);

const validId = value =>
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
    }, response => {
      let text = "";
      response.setEncoding("utf8");

      response.on("data", chunk => {
        text += chunk;
        if (text.length > 1048576) {
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
          const err = new Error(
            String(body?.message || body?.type || "API error")
              .slice(0, 160)
          );
          err.status = response.statusCode;
          return reject(err);
        }

        resolve(body);
      });
    });

    request.on("timeout", () =>
      request.destroy(new Error("API timeout"))
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
      error: "POST required"
    });
  }

  const env = process.env;
  const actorId = req.headers["x-appwrite-user-id"];

  if (!validId(actorId)) {
    return respond(res, 401, {
      ok: false,
      error: "Login required"
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

  if (!input || typeof input !== "object") {
    return respond(res, 400, {
      ok: false,
      error: "Invalid body"
    });
  }

  const dbPath =
    `/tablesdb/${encodeURIComponent(env.APPWRITE_DATABASE_ID)}/tables`;

  const profilePath =
    `${dbPath}/${encodeURIComponent(env.USERS_PROFILES_TABLE_ID)}/rows`;

  const findProfile = async userId => {
    const result = await apiRequest(
      "GET",
      profilePath,
      undefined,
      env,
      [
        {
          method: "equal",
          attribute: "userId",
          values: [userId]
        },
        {
          method: "limit",
          values: [2]
        }
      ]
    );

    return result.rows?.length === 1
      ? result.rows[0]
      : null;
  };

  // SECURE REFERRAL REGISTRATION
  // Referral row ID = authenticated user's ID.
  // Reward points are not granted yet.

  if (input.action === "register_referral") {
    try {
      const profile = await findProfile(actorId);

      if (!profile || profile.userId !== actorId) {
        return respond(res, 404, {
          ok: false,
          error: "Profile not found"
        });
      }

      const code = String(
        profile.referredBy || ""
      ).trim().toUpperCase();

      if (!/^[A-Z0-9]{2,32}$/.test(code)) {
        return respond(res, 400, {
          ok: false,
          error: "No valid signup referral code"
        });
      }

      const result = await apiRequest(
        "GET",
        profilePath,
        undefined,
        env,
        [
          {
            method: "equal",
            attribute: "referralCode",
            values: [code]
          },
          {
            method: "limit",
            values: [2]
          }
        ]
      );

      if (result.rows?.length !== 1) {
        return respond(res, 404, {
          ok: false,
          error: "Referrer not uniquely found"
        });
      }

      const referrer = result.rows[0];

      if (!validId(referrer.userId) ||
          referrer.userId === actorId) {
        return respond(res, 409, {
          ok: false,
          error: "Self referral or invalid referrer"
        });
      }

      const referralsPath =
        `${dbPath}/${encodeURIComponent(
          env.REFERRALS_TABLE_ID || "referrals"
        )}/rows`;

      try {
        const row = await apiRequest(
          "POST",
          referralsPath,
          {
            rowId: actorId,
            data: {
              refrrerUserId: referrer.userId,
              referredUserId: actorId,
              referralCode: code,
              createdAt: new Date().toISOString(),
              points: 0
            }
          },
          env
        );

        log(`Referral registered for ${actorId}`);

        return respond(res, 200, {
          ok: true,
          action: "register_referral",
          referralId: row.$id,
          status: "recorded",
          rewardStatus: "paused"
        });

      } catch (err) {
        if (err.status === 409) {
          return respond(res, 200, {
            ok: true,
            action: "register_referral",
            status: "already_recorded",
            rewardStatus: "paused"
          });
        }
        throw err;
      }

    } catch (err) {
      error(`Referral error: ${err.message}`);

      return respond(res, 500, {
        ok: false,
        error: "Referral registration failed"
      });
    }
  }

  // ADMIN AUTHORIZATION

  if (!env.ADMIN_USER_ID ||
      actorId !== env.ADMIN_USER_ID) {
    return respond(res, 403, {
      ok: false,
      error: "Admin access required"
    });
  }

  // ADMIN ADD VC

  if (input.action === "add_vc") {
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
        {
          data: {
            wallet: previous + amount
          }
        },
        env
      );

      log(`Admin granted ${amount} VC to ${profile.$id}`);

      return respond(res, 200, {
        ok: true,
        action: "add_vc",
        userId,
        added: amount,
        previous,
        balance: updated.wallet
      });

    } catch (err) {
      error(`VC grant error: ${err.message}`);

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

  const { claimId, decision } = input;

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

    if (String(claim.status || "").toLowerCase() !== "pending") {
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

    const currentStatus = String(claim.status || "");

    const nextStatus =
      currentStatus === currentStatus.toUpperCase()
        ? decision.toUpperCase()
        : decision;

    const updated = await apiRequest(
      "PATCH",
      `${claimsPath}/${encodeURIComponent(claimId)}`,
      {
        data: {
          status: nextStatus
        }
      },
      env
    );

    log(`Claim ${claimId} moved to ${nextStatus}`);

    return respond(res, 200, {
      ok: true,
      claimId: updated.$id,
      status: updated.status
    });

  } catch (err) {
    error(`Approval error: ${err.message}`);

    return respond(res, 500, {
      ok: false,
      error: "Approval failed; inspect function logs"
    });
  }
};
                       
