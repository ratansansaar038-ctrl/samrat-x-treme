
import https from 'node:https';

const ENDPOINT = 'https://sgp.cloud.appwrite.io/v1';
const PROJECT = '6a7f2add0011a7bfc21a';
const DATABASE = '6a7f2d1d0035d9815939';
const TABLE = 'user_profiles';

function requestRows(userId, apiKey) {
  const url = new URL(
    `${ENDPOINT}/tablesdb/${DATABASE}/tables/${TABLE}/rows`
  );

  const queries = [
    { method: 'equal', attribute: 'userId', values: [userId] },
    { method: 'limit', values: [2] }
  ];

  for (const q of queries) {
    url.searchParams.append('queries[]', JSON.stringify(q));
  }

  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'X-Appwrite-Project': PROJECT,
        'X-Appwrite-Key': apiKey,
        Accept: 'application/json'
      },
      timeout: 10000
    }, response => {
      let body = '';

      response.on('data', chunk => {
        body += chunk;
        if (body.length > 1000000) {
          response.destroy(new Error('Response too large'));
        }
      });

      response.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (response.statusCode !== 200) {
            return reject(new Error(`Database HTTP ${response.statusCode}`));
          }
          resolve(result.rows || []);
        } catch (err) {
          reject(err);
        }
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('Timeout'));
    });

    request.on('error', reject);
  });
}

export default async ({ req, res, error }) => {
  if (req.method !== 'POST') {
    return res.json({ ok: false, error: 'POST required' }, 405);
  }

  const userId = req.headers['x-appwrite-user-id'];
  const apiKey =
    req.headers['x-appwrite-key'] ||
    process.env.APPWRITE_API_KEY;

  if (!userId) {
    return res.json({ ok: false, error: 'Login required' }, 401);
  }

  if (!apiKey) {
    return res.json({ ok: false, error: 'Backend key missing' }, 503);
  }

  let body;

  try {
    body = typeof req.body === 'string'
      ? JSON.parse(req.body)
      : req.body;
  } catch {
    return res.json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  if (body?.action === 'play' || body?.action === 'settle') {
    return res.json({
      ok: false,
      error: 'Game settlement disabled until secure migration'
    }, 503);
  }

  if (body?.action !== 'get_wallet') {
    return res.json({
      ok: false,
      error: 'Unsupported action'
    }, 400);
  }

  try {
    const rows = await requestRows(userId, apiKey);

    if (rows.length !== 1) {
      return res.json({
        ok: false,
        error: 'Profile not uniquely found'
      }, 404);
    }

    const wallet = rows[0].wallet;

    if (!Number.isSafeInteger(wallet) || wallet < 0) {
      return res.json({
        ok: false,
        error: 'Invalid wallet'
      }, 409);
    }

    return res.json({ ok: true, wallet }, 200);
  } catch (err) {
    error('Wallet read failed: ' + err.message);

    return res.json({
      ok: false,
      error: 'Wallet service unavailable'
    }, 500);
  }
};
    
