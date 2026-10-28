
import { Client, TablesDB, Query } from "node-appwrite";

const reply = (res, code, data) => res.json(data, code);

export default async ({ req, res, log, error }) => {
  if (req.method !== "POST") {
    return reply(res, 405, {
      ok: false,
      error: "POST required"
    });
  }

  const actorId = req.headers["x-appwrite-user-id"];
  const adminId = process.env.ADMIN_USER_ID;

  if (!actorId || !adminId || actorId !== adminId) {
    return reply(res, 403, {
      ok: false,
      error: "Admin access required"
    });
  }

  const {
    APPWRITE_API_KEY,
    APPWRITE_DATABASE_ID,
    USERS_PROFILES_TABLE_ID
  } = process.env;

  if (!APPWRITE_API_KEY ||
      !APPWRITE_DATABASE_ID ||
      !USERS_PROFILES_TABLE_ID) {
    return reply(res, 503, {
      ok: false,
      error: "Backend configuration incomplete"
    });
  }

  let body;

  try {
    body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;
  } catch {
    return reply(res, 400, {
      ok: false,
      error: "Invalid JSON"
    });
  }

  if (!body || body.action !== "add_vc") {
    return reply(res, 400, {
      ok: false,
      error: "Invalid action"
    });
  }

  const { userId, amount } = body;

  if (
    typeof userId !== "string" ||
    !/^[a-zA-Z0-9._-]{1,36}$/.test(userId) ||
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > 100000
  ) {
    return reply(res, 400, {
      ok: false,
      error: "Invalid User ID or VC amount"
    });
  }

  const client = new Client()
    .setEndpoint("https://sgp.cloud.appwrite.io/v1")
    .setProject("6a7f2add0011a7bfc21a")
    .setKey(APPWRITE_API_KEY);

  const db = new TablesDB(client);

  try {
    const result = await db.listRows({
      databaseId: APPWRITE_DATABASE_ID,
      tableId: USERS_PROFILES_TABLE_ID,
      queries: [
        Query.equal("userId", userId),
        Query.limit(2)
      ]
    });

    if (result.rows.length !== 1) {
      return reply(res, 404, {
        ok: false,
        error: "User profile not found or duplicated"
      });
    }

    const profile = result.rows[0];
    const previous = Number(profile.wallet);

    if (
      !Number.isSafeInteger(previous) ||
      previous < 0 ||
      !Number.isSafeInteger(previous + amount)
    ) {
      return reply(res, 409, {
        ok: false,
        error: "Invalid wallet balance"
      });
    }

    const updated = await db.updateRow({
      databaseId: APPWRITE_DATABASE_ID,
      tableId: USERS_PROFILES_TABLE_ID,
      rowId: profile.$id,
      data: {
        wallet: previous + amount
      }
    });

    log(`VC grant completed for user ${userId}`);

    return reply(res, 200, {
      ok: true,
      action: "add_vc",
      userId,
      added: amount,
      previous,
      balance: updated.wallet
    });

  } catch (e) {
    error(e.message);

    return reply(res, 500, {
      ok: false,
      error: "VC grant failed"
    });
  }
};
