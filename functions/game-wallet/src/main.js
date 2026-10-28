
import https from "node:https";

const ENDPOINT = "https://sgp.cloud.appwrite.io/v1";
const PROJECT_ID = "6a7f2add0011a7bfc21a";
const DATABASE_ID = "6a7f2d1d0035d9815939";
const TABLE_ID = "user_profiles";

function getProfiles(userId, apiKey) {
  const url = new URL(
    `${ENDPOINT}/tablesdb/${DATABASE_ID}/tables/${TABLE_ID}/rows`
  );

  const queries = [
    { method: "equal", attribute: "userId", values: [userId] },
    { method: "limit", values: [2] }
  ];

  for (const query of queries) {
    url.searchParams.append(
      "queries[]",
      JSON.stringify(query)
    );
  }

  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        "X-Appwrite-Project": PROJECT_ID,
        "X-Appwrite-Key": apiKey,
        "Accept": "application/json"
      },
      timeout: 10000
    }, response => {
      let data = "";

      response.on("data", chunk => {
        data += chunk;
        if (data.length > 1000000) {
          response.destroy(new Error("Response too large"));
        }
      });

      response.on("end", () => {
        try {
          const result = JSON.parse(data);

          if (response.statusCode !== 200) {
            return reject(
              new Error(`Database HTTP ${response.statusCode}`)
            );
          }

          resolve(result.rows || []);
        } catch (err) {
          reject(err);
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("Database timeout"));
    });

    request.on("error", reject);
  });
}

export default async ({ req, res, error }) => {
  if (req.method !== "POST") {
    return res.json({
      ok: false,
      error: "Method not allowed"
    }, 405);
  }

  const userId = req.headers["x-appwrite-user-id"];
  const apiKey = req.headers["x-appwrite-key"];

  if (!userId) {
    return res.json({
      ok: false,
      error: "Login required"
    }, 401);
  }

  if (!apiKey) {
    return res.json({
      ok: false,
      error: "Function authentication unavailable"
    }, 503);
  }

  let body;

  try {
    body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;
  } catch {
    return res.json({
      ok: false,
      error: "Invalid JSON"
    }, 400);
  }

  if (body?.action !== "get_wallet") {
    return res.json({
      ok: false,
      error: "Unsupported action"
    }, 400);
  }

  try {
    const profiles = await getProfiles(userId, apiKey);

    if (profiles.length !== 1) {
      return res.json({
        ok: false,
        error: "Profile not uniquely found"
      }, 404);
    }

    const wallet = profiles[0].wallet;

    if (!Number.isSafeInteger(wallet) || wallet < 0) {
      return res.json({
        ok: false,
        error: "Invalid wallet balance"
      }, 409);
    }

    return res.json({
      ok: true,
      userId,
      wallet
    }, 200);

  } catch (err) {
    error("Wallet read error: " + err.message);

    return res.json({
      ok: false,
      error: "Wallet service unavailable"
    }, 500);
  }
};
