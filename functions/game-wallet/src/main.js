
import https from 'node:https';
import { randomInt } from 'node:crypto';

const ENDPOINT = 'https://sgp.cloud.appwrite.io/v1';
const PROJECT = '6a7f2add0011a7bfc21a';
const DB = '6a7f2d1d0035d9815939';
const PROFILES = 'user_profiles';
const ROUNDS = 'game_rounds';

const ROUND_MS = 20 * 60 * 1000;
const IST_OFFSET = 330 * 60 * 1000;
const CUTOFF_MS = 60 * 1000;
const STAKES = [20, 50, 100];

function response(res, status, data) {
  return res.json(data, status);
}

class GameError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function qEqual(attribute, value) {
  return {
    method: 'equal',
    attribute,
    values: [value]
  };
}

function qLimit(value) {
  return {
    method: 'limit',
    values: [value]
  };
}

function api(method, path, key, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined
      ? null
      : JSON.stringify(payload);

    const url = new URL(ENDPOINT + path);

    const req = https.request(url, {
      method,
      timeout: 12000,
      headers: {
        'X-Appwrite-Project': PROJECT,
        'X-Appwrite-Key': key,
        Accept: 'application/json',
        ...(body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        } : {})
      }
    }, r => {
      let raw = '';

      r.on('data', c => {
        raw += c;

        if (raw.length > 1000000) {
          r.destroy(new Error('Response too large'));
        }
      });

      r.on('end', () => {
        let data;

        try {
          data = JSON.parse(raw);
        } catch {
          return reject(
            new Error('Invalid database response')
          );
        }

        if (
          r.statusCode < 200 ||
          r.statusCode >= 300
        ) {
          const e = new Error(
            data.message ||
            `Database HTTP ${r.statusCode}`
          );

          e.status = r.statusCode;
          return reject(e);
        }

        resolve(data);
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Database timeout'));
    });

    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

function rowsPath(table, queries = []) {
  const p = new URLSearchParams();

  for (const q of queries) {
    p.append('queries[]', JSON.stringify(q));
  }

  return `/tablesdb/${DB}/tables/${table}/rows${
    p.size ? '?' + p.toString() : ''
  }`;
}

async function rows(table, queries, key) {
  const data = await api(
    'GET',
    rowsPath(table, queries),
    key
  );

  return data.rows || [];
}

function roundFor(time) {
  const start =
    Math.floor((time + IST_OFFSET) / ROUND_MS)
      * ROUND_MS - IST_OFFSET;

  const end = start + ROUND_MS;

  return {
    roundId: 'r_' +
      new Date(start)
        .toISOString()
        .replace(/[-:.TZ]/g, ''),

    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),

    entryClosesAt:
      new Date(end - CUTOFF_MS).toISOString(),

    status: time >= end - CUTOFF_MS
      ? 'locked'
      : 'open'
  };
}

async function profile(userId, key) {
  const found = await rows(
    PROFILES,
    [
      qEqual('userId', userId),
      qLimit(2)
    ],
    key
  );

  if (!found.length) {
    throw new GameError(
      404,
      'PROFILE_NOT_FOUND',
      'No wallet profile for this account'
    );
  }

  if (found.length > 1) {
    throw new GameError(
      409,
      'DUPLICATE_PROFILES',
      'Multiple wallet profiles found'
    );
  }

  const p = found[0];

  if (
    !Number.isSafeInteger(p.wallet) ||
    p.wallet < 0
  ) {
    throw new GameError(
      409,
      'INVALID_WALLET',
      'Wallet needs admin review'
    );
  }

  return p;
}

async function getStoredRound(roundId, key) {
  const found = await rows(
    ROUNDS,
    [
      qEqual('roundId', roundId),
      qLimit(2)
    ],
    key
  );

  if (found.length > 1) {
    throw new GameError(
      409,
      'DUPLICATE_ROUNDS',
      'Multiple records for round'
    );
  }

  return found[0] || null;
}

function validResult(row) {
  return row?.status === 'settled' &&
    Number.isInteger(row.winningNumber) &&
    row.winningNumber >= 1 &&
    row.winningNumber <= 9;
}

async function lastResult(key) {
  const last = roundFor(Date.now() - ROUND_MS);

  let stored = await getStoredRound(
    last.roundId,
    key
  );

  if (!stored) {
    const winningNumber = randomInt(1, 10);

    const startAt = last.startsAt;
    const endsAt = last.endsAt;
    const settleAt = new Date().toISOString();

    try {
      stored = await api(
        'POST',
        rowsPath(ROUNDS),
        key,
        {
          rowId: last.roundId,
          data: {
            roundId: last.roundId,
            startAt,
            endsAt,
            status: 'settled',
            winningNumber,
            settleAt
          }
        }
      );
    } catch (e) {
      if (e.status !== 409) {
        throw e;
      }

      stored = await getStoredRound(
        last.roundId,
        key
      );
    }
  }

  if (!validResult(stored)) {
    return {
      ok: true,
      available: false,
      roundId: last.roundId,
      winningNumber: null,
      message:
        'Round exists but no verified result is saved'
    };
  }

  return {
    ok: true,
    available: true,
    roundId: last.roundId,
    winningNumber: stored.winningNumber,
    message: 'Server-recorded demo draw result'
  };
}

function validateSelections(input) {
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > 9
  ) {
    throw new GameError(
      400,
      'INVALID_SELECTIONS',
      'Select 1 to 9 numbers'
    );
  }

  const seen = new Set();
  let total = 0;

  const selections = input.map(x => {
    if (
      !x ||
      !Number.isInteger(x.number) ||
      x.number < 1 ||
      x.number > 9
    ) {
      throw new GameError(
        400,
        'INVALID_NUMBER',
        'Numbers must be 1 to 9'
      );
    }

    if (seen.has(x.number)) {
      throw new GameError(
        400,
        'DUPLICATE_NUMBER',
        'Number selected twice'
      );
    }

    if (!STAKES.includes(x.stakeVC)) {
      throw new GameError(
        400,
        'INVALID_STAKE',
        'Allowed: 20, 50, 100 VC'
      );
    }

    seen.add(x.number);
    total += x.stakeVC;

    return {
      number: x.number,
      stakeVC: x.stakeVC,
      potentialPayoutVC: x.stakeVC * 8
    };
  });

  return { selections, total };
}

export default async ({ req, res, error }) => {
  if (req.method !== 'POST') {
    return response(res, 405, {
      ok: false,
      error: 'POST required'
    });
  }

  let body;

  try {
    body = typeof req.body === 'string'
      ? JSON.parse(req.body)
      : req.body;

    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body)
    ) {
      throw Error();
    }
  } catch {
    return response(res, 400, {
      ok: false,
      error: 'Invalid JSON'
    });
  }

  const action = body.action;

  if ([
    'play',
    'settle',
    'place_entries',
    'settle_round'
  ].includes(action)) {
    return response(res, 503, {
      ok: false,
      acceptingEntries: false,
      error: 'Real entries and rewards disabled'
    });
  }

  if (![
    'get_wallet',
    'get_round',
    'get_last_result',
    'preview_entries'
  ].includes(action)) {
    return response(res, 400, {
      ok: false,
      error: 'Unsupported action'
    });
  }

  const userId =
    req.headers['x-appwrite-user-id'];

  const key =
    req.headers['x-appwrite-key'];

  if (!userId) {
    return response(res, 401, {
      ok: false,
      code: 'LOGIN_REQUIRED',
      error: 'Login required'
    });
  }

  if (!key) {
    return response(res, 503, {
      ok: false,
      code: 'FUNCTION_KEY_MISSING',
      error: 'Function key unavailable'
    });
  }

  try {
    if (action === 'get_wallet') {
      const p = await profile(userId, key);

      return response(res, 200, {
        ok: true,
        userId,
        wallet: p.wallet
      });
    }

    if (action === 'get_last_result') {
      return response(
        res,
        200,
        await lastResult(key)
      );
    }

    const current = roundFor(Date.now());

    const stored = await getStoredRound(
      current.roundId,
      key
    );

    if (action === 'get_round') {
      return response(res, 200, {
        ok: true,
        ...current,
        serverTime: new Date().toISOString(),

        status: validResult(stored)
          ? 'settled'
          : stored?.status === 'locked'
            ? 'locked'
            : current.status,

        winningNumber: validResult(stored)
          ? stored.winningNumber
          : null,

        acceptingEntries: false,
        mode: 'read_only'
      });
    }

    if (
      current.status !== 'open' ||
      (stored && stored.status !== 'open')
    ) {
      throw new GameError(
        409,
        'ENTRY_WINDOW_CLOSED',
        'Round is locked'
      );
    }

    if (
      body.roundId &&
      body.roundId !== current.roundId
    ) {
      throw new GameError(
        409,
        'ROUND_MISMATCH',
        'Round ID mismatch'
      );
    }

    const checked = validateSelections(
      body.selections
    );

    const p = await profile(userId, key);

    const sufficientBalance =
      p.wallet >= checked.total;

    return response(res, 200, {
      ok: true,
      action: 'preview_entries',
      roundId: current.roundId,
      selections: checked.selections,
      totalStakeVC: checked.total,
      walletVC: p.wallet,
      sufficientBalance,

      walletAfterVC: sufficientBalance
        ? p.wallet - checked.total
        : null,

      acceptingEntries: false,
      committed: false,
      message: 'Preview only. No VC deducted.'
    });

  } catch (e) {
    if (e instanceof GameError) {
      return response(res, e.status, {
        ok: false,
        code: e.code,
        error: e.message
      });
    }

    error('Game backend error: ' + e.message);

    return response(res, 500, {
      ok: false,
      code: 'BACKEND_ERROR',
      error:
        'Game service unavailable; check function errors'
    });
  }
};
