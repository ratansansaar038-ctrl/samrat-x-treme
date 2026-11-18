import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import {
  randomInt,
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

const ENDPOINT = "https://sgp.cloud.appwrite.io/v1";
const PROJECT = "6a7f2add0011a7bfc21a";
const DB = "6a7f2d1d0035d9815939";
const ROUND_MS = 1200000,
  OFFSET = 19800000;

const send = (res, code, obj) => res.json(obj, code);
const eq = (attribute, value) => ({
  method: "equal",
  attribute,
  values: [value],
});
const lim = (n) => ({ method: "limit", values: [n] });
const order = (attribute, direction) => ({
  method: direction === "asc" ? "orderAsc" : "orderDesc",
  attribute,
});

function request(method, path, key, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const req = https.request(
      new URL(ENDPOINT + path),
      {
        method,
        timeout: 15000,
        headers: {
          "X-Appwrite-Project": PROJECT,
          "X-Appwrite-Key": key,
          Accept: "application/json",
          ...(body
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (r) => {
        let raw = "";
        r.on("data", (x) => {
          raw += x;
          if (raw.length > 1000000) r.destroy(new Error("Response too large"));
        });
        r.on("end", () => {
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            return reject(new Error("Invalid JSON response"));
          }
          if (r.statusCode < 200 || r.statusCode >= 300) {
            const e = new Error(data.message || "Database error");
            e.status = r.statusCode;
            return reject(e);
          }
          resolve(data);
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function tablePath(table, queries = []) {
  const q = new URLSearchParams();
  for (const x of queries) q.append("queries[]", JSON.stringify(x));
  return `/tablesdb/${DB}/tables/${table}/rows` + (q.size ? "?" + q : "");
}

async function rows(table, queries, key) {
  return (await request("GET", tablePath(table, queries), key)).rows || [];
}

// Samrat Night Break is ALWAYS calculated on the Appwrite server in IST.
const IST_OFFSET_MS = 330 * 60 * 1000;
function nightBreakInfo(nowMs = Date.now()) {
  const local = new Date(nowMs + IST_OFFSET_MS);
  const hour = local.getUTCHours();
  const closed = hour >= 22 || hour < 9;
  if (!closed) return { closed: false, nextOpensAt: null };
  const localMidnightUTC =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
    IST_OFFSET_MS;
  const nextOpenMs =
    localMidnightUTC + (hour >= 22 ? 86400000 : 0) + 9 * 3600000;
  return { closed: true, nextOpensAt: new Date(nextOpenMs).toISOString() };
}
function roundIsDaytime(round) {
  const start = Date.parse(round.startsAt),
    end = Date.parse(round.endsAt);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start &&
    !nightBreakInfo(start).closed &&
    !nightBreakInfo(end - 1).closed
  );
}

function roundFor(t) {
  const start = Math.floor((t + OFFSET) / ROUND_MS) * ROUND_MS - OFFSET;
  const end = start + ROUND_MS;
  return {
    roundId: "r_" + new Date(start).toISOString().replace(/[-:.TZ]/g, ""),
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    entryClosesAt: new Date(end - 60000).toISOString(),
    status: t >= end - 60000 ? "locked" : "open",
  };
}

async function stored(id, key) {
  const x = await rows("game_rounds",
