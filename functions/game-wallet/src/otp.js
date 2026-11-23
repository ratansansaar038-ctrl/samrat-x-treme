import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";

const TTL_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const MAX_DAILY_SENDS = 6;
const MAX_WRONG_ATTEMPTS = 5;

export function normalizeIndianMobile(input) {
  const digits = String(input || "").replace(/\D/g, "");
  const local = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  if (!/^[6-9]\d{9}$/.test(local)) throw Error("A valid Indian mobile number is required.");
  return "+91" + local;
}

export function otpRecordId(userId) {
  if (!/^[a-zA-Z0-9._-]{1,36}$/.test(userId || "")) throw Error("Invalid authenticated user");
  return "otp_" + createHash("sha256").update(userId).digest("hex").slice(0, 28);
}

export function createOtpService({ authUser, readRecord, writeRecord, sendSms, secret, now = () => Date.now(), makeCode = () => String(randomInt(100000, 1000000)) }) {
  function digest(label, value) {
    if (!secret || secret.length < 32) throw Error("OTP server secret not configured");
    return createHmac("sha256", secret).update(label + ":" + value).digest("hex");
  }
  function phoneDigest(phone) { return digest("phone", phone); }
  function codeDigest(userId, phone, code) { return digest("otp", [userId, phone, code].join(":")); }
  async function state(userId) {
    const user = await authUser(userId);
    if (user?.$id !== userId) throw Error("Account verification mismatch");
    const phone = normalizeIndianMobile(user.phone);
    const record = await readRecord(otpRecordId(userId));
    return { phone, record, currentPhoneDigest: phoneDigest(phone) };
  }
  const checked = (record, hash) => record?.phoneDigest === hash && record.verified === true;

  async function status(userId) {
    const { phone, record, currentPhoneDigest } = await state(userId);
    return {
      ok: true,
      verified: checked(record, currentPhoneDigest),
      phoneLast4: phone.slice(-4),
      pending: !!(record && record.phoneDigest === currentPhoneDigest && !record.verified && Date.parse(record.expiresAt) > now()),
    };
  }

  async function begin(userId) {
    const { phone, record, currentPhoneDigest } = await state(userId);
    if (checked(record, currentPhoneDigest)) {
      return { ok: true, verified: true, phoneLast4: phone.slice(-4) };
    }
    const instant = now();
    if (record && Number.isFinite(Date.parse(record.sentAt)) && instant - Date.parse(record.sentAt) < COOLDOWN_MS)
      return { ok: false, error: "Wait 60 seconds before requesting another SMS OTP." };

    const day = new Date(instant).toISOString().slice(0, 10);
    const sendsToday = record?.sentDay === day ? Number(record.sendsToday) || 0 : 0;
    if (sendsToday >= MAX_DAILY_SENDS)
      return { ok: false, error: "Daily SMS OTP limit reached. Try again tomorrow." };

    const code = String(makeCode());
    if (!/^\d{6}$/.test(code)) throw Error("Invalid OTP generator");
    const next = {
      phoneDigest: currentPhoneDigest,
      otpDigest: codeDigest(userId, phone, code),
      sentAt: new Date(instant).toISOString(),
      expiresAt: new Date(instant + TTL_MS).toISOString(),
      failedAttempts: 0,
      verified: false,
      verifiedAt: "",
      sentDay: day,
      sendsToday: sendsToday + 1,
    };
    // Persist a pending challenge FIRST. On a write conflict, never send a chargeable SMS.
    await writeRecord(otpRecordId(userId), next, !!record);
    // Provider key and plaintext code are passed only to server-side dispatch.
    await sendSms(phone, code);
    return { ok: true, verified: false, phoneLast4: phone.slice(-4), expiresInSeconds: 300 };
  }

  async function verify(userId, code) {
    if (!/^\d{6}$/.test(String(code || "")))
      return { ok: false, error: "Enter the 6-digit SMS OTP." };
    const { phone, record, currentPhoneDigest } = await state(userId);
    if (checked(record, currentPhoneDigest)) return { ok: true, verified: true };
    if (!record || record.phoneDigest !== currentPhoneDigest || !record.otpDigest ||
        Date.parse(record.expiresAt) <= now())
      return { ok: false, error: "OTP expired or missing. Request a new SMS OTP." };
    if (record.failedAttempts >= MAX_WRONG_ATTEMPTS)
      return { ok: false, error: "Too many incorrect attempts. Request a new OTP later." };

    const expected = Buffer.from(record.otpDigest, "hex");
    const actual = Buffer.from(codeDigest(userId, phone, String(code)), "hex");
    const valid = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!valid) {
      await writeRecord(otpRecordId(userId), { failedAttempts: (record.failedAttempts || 0) + 1 }, true);
      return { ok: false, error: "Incorrect OTP. Please try again." };
    }
    await writeRecord(otpRecordId(userId), {
      verified: true,
      verifiedAt: new Date(now()).toISOString(),
      otpDigest: "",
      failedAttempts: 0,
    }, true);
    return { ok: true, verified: true };
  }

  async function isVerified(userId) {
    const { record, currentPhoneDigest } = await state(userId);
    return checked(record, currentPhoneDigest);
  }

  return { begin, status, verify, isVerified };
}
