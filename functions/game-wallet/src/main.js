
import https from 'node:https';

const ENDPOINT = 'https://sgp.cloud.appwrite.io/v1';
const PROJECT_ID = '6a7f2add0011a7bfc21a';
const DATABASE_ID = '6a7f2d1d0035d9815939';
const PROFILES = 'user_profiles';
const ROUNDS = 'game_rounds';
const ROUND_MS = 20 * 60 * 1000;
const CUTOFF_MS = 60 * 1000;

function getRows(table, queries, apiKey) {
  const url = new URL(`${ENDPOINT}/tablesdb/${DATABASE_ID}/tables/${table}/rows`);
  for (const query of queries) url.searchParams.append('queries[]', JSON.stringify(query));
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'X-Appwrite-Project': PROJECT_ID,
        'X-Appwrite-Key': apiKey,
        Accept: 'application/json'
      }, timeout: 10000
    }, response => {
      let raw = '';
      response.on('data', chunk => {
        raw += chunk;
        if (raw.length > 1000000) response.destroy(new Error('Response too large'));
      });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (response.statusCode !== 200) return reject(new Error(`Database HTTP ${response.statusCode}`));
          resolve(parsed.rows || []);
        } catch (err) { reject(err); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Database timeout')));
    request.on('error', reject);
  });
}

const equal = (attribute, value) => ({ method: 'equal', attribute, values: [value] });
const limit = n => ({ method: 'limit', values: [n] });

export default async ({ req, res, error }) => {
  if (req.method !== 'POST') return res.json({ ok: false, error: 'POST required' }, 405);
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.json({ ok: false, error: 'Invalid JSON' }, 400); }
  const action = body?.action;
  if (action === 'play' || action === 'settle' || action === 'place_entries') {
    return res.json({ ok: false, error: 'Secure game settlement not enabled' }, 503);
  }
  if (!['get_wallet', 'get_round'].includes(action)) {
    return res.json({ ok: false, error: 'Unsupported action' }, 400);
  }
  const userId = req.headers['x-appwrite-user-id'];
  if (!userId) return res.json({ ok: false, error: 'Login required' }, 401);
  const apiKey = req.headers['x-appwrite-key'];
  if (!apiKey) return res.json({ ok: false, error: 'Function authentication unavailable' }, 503);

  try {
    if (action === 'get_wallet') {
      const profiles = await getRows(PROFILES, [equal('userId', userId), limit(2)], apiKey);
      if (profiles.length !== 1) return res.json({ ok: false, error: 'Profile not uniquely found' }, 404);
      const wallet = profiles[0].wallet;
      if (!Number.isSafeInteger(wallet) || wallet < 0) return res.json({ ok: false, error: 'Invalid wallet balance' }, 409);
      return res.json({ ok: true, userId, wallet }, 200);
    }

    // 20-minute slots aligned with IST :00/:20/:40.
    const now = Date.now();
    const istOffsetMs = 330 * 60 * 1000;
    const start = Math.floor((now + istOffsetMs) / ROUND_MS) * ROUND_MS - istOffsetMs;
    const end = start + ROUND_MS;
    const roundId = `r_${new Date(start).toISOString().replace(/[-:.TZ]/g, '')}`;
    const rounds = await getRows(ROUNDS, [equal('roundId', roundId), limit(2)], apiKey);
    if (rounds.length > 1) return res.json({ ok: false, error: 'Duplicate round records' }, 409);
    const row = rounds[0];
    const effectiveStatus = now >= end ? 'closed' : now >= end - CUTOFF_MS ? 'locked' : 'open';
    return res.json({
      ok: true, roundId,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      entryClosesAt: new Date(end - CUTOFF_MS).toISOString(),
      serverTime: new Date(now).toISOString(),
      status: row?.status || effectiveStatus,
      acceptingEntries: false,
      winningNumber: row?.status === 'settled' ? row.winningNumber : null,
      note: 'Read-only preview; entries and settlement are not yet enabled'
    }, 200);
  } catch (err) {
    error(`Game wallet read error: ${err.message}`);
    return res.json({ ok: false, error: 'Game service unavailable' }, 500);
  }
};
