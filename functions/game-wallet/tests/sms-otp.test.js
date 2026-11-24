import test from 'node:test';
import assert from 'node:assert/strict';
import { createOtpService, normalizeIndianMobile, otpRecordId } from '../src/otp.js';

function setup({smsFailure = false} = {}) {
  const clock = { ms: Date.parse('2026-11-23T11:00:00Z') };
  const auth = { $id: 'samrat-player-1', phone: '+919876543210' };
  const records = new Map();
  const sent = [];
  const service = createOtpService({
    secret: 'a'.repeat(64),
    now: () => clock.ms,
    makeCode: () => '123456',
    authUser: async id => {
      if (id !== auth.$id) throw Error('bad user');
      return {...auth};
    },
    readRecord: async id => records.has(id) ? {...records.get(id)} : null,
    writeRecord: async (id, data, exists) => {
      if (!exists && records.has(id)) throw Error('Conflicting OTP send');
      records.set(id, {...(records.get(id) || {}), ...data});
    },
    sendSms: async (phone, code) => {
      if (smsFailure) throw Error('Gateway rejected OTP');
      sent.push({phone, code});
    }
  });
  return { service, clock, auth, records, sent };
}

test('valid Indian E164 mobile and deterministic record IDs', () => {
  assert.equal(normalizeIndianMobile('9876543210'), '+919876543210');
  assert.equal(normalizeIndianMobile('91 9876543210'), '+919876543210');
  assert.throws(() => normalizeIndianMobile('1234567890'), /valid Indian mobile/);
  assert.match(otpRecordId('samrat-player-1'), /^otp_[0-9a-f]{28}$/);
});

test('generates a six digit OTP, stores only its HMAC, then dispatches SMS', async () => {
  const t = setup();
  const first = await t.service.begin(t.auth.$id);
  assert.equal(first.ok, true);
  assert.equal(first.verified, false);
  assert.equal(first.expiresInSeconds, 300);
  assert.equal(first.phoneLast4, '3210');
  assert.deepEqual(t.sent, [{phone: '+919876543210', code: '123456'}]);
  const stored = t.records.get(otpRecordId(t.auth.$id));
  assert.equal(stored.verified, false);
  assert.match(stored.otpDigest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(stored), /123456|9876543210/);
});

test('wrong code cannot verify, five failures lock challenge', async () => {
  const t = setup();
  await t.service.begin(t.auth.$id);
  for (let i = 0; i < 5; i++) {
    const result = await t.service.verify(t.auth.$id, '000000');
    assert.equal(result.ok, false);
    assert.equal(await t.service.isVerified(t.auth.$id), false);
  }
  assert.match((await t.service.verify(t.auth.$id, '123456')).error, /Too many/);
  assert.equal(t.records.get(otpRecordId(t.auth.$id)).failedAttempts, 5);
});

test('valid code verifies once; duplicate attempts do not resend or change the result', async () => {
  const t = setup();
  await t.service.begin(t.auth.$id);
  assert.equal((await t.service.verify(t.auth.$id, '123456')).verified, true);
  assert.equal((await t.service.status(t.auth.$id)).verified, true);
  assert.equal(t.records.get(otpRecordId(t.auth.$id)).otpDigest, '');
  assert.equal((await t.service.begin(t.auth.$id)).verified, true);
  assert.equal(t.sent.length, 1);
});

test('OTP expires after five minutes; resend requires cooldown and daily limits', async () => {
  const t = setup();
  await t.service.begin(t.auth.$id);
  assert.match((await t.service.begin(t.auth.$id)).error, /Wait 60 seconds/);
  t.clock.ms += 300001;
  assert.match((await t.service.verify(t.auth.$id, '123456')).error, /expired/);
  for (let i = 1; i < 6; i++) {
    await t.service.begin(t.auth.$id);
    t.clock.ms += 61000;
  }
  assert.equal(t.sent.length, 6);
  assert.match((await t.service.begin(t.auth.$id)).error, /Daily SMS OTP limit/);
});

test('verified OTP for a previous mobile number cannot authorize a changed phone', async () => {
  const t = setup();
  await t.service.begin(t.auth.$id);
  await t.service.verify(t.auth.$id, '123456');
  t.auth.phone = '+919876543211';
  assert.equal((await t.service.status(t.auth.$id)).verified, false);
  assert.equal(await t.service.isVerified(t.auth.$id), false);
  t.clock.ms += 61000;
  const result = await t.service.begin(t.auth.$id);
  assert.equal(result.verified, false);
  assert.equal(t.sent.at(-1).phone, '+919876543211');
});

test('gateway failures do not result in verified accounts and are rate-limited', async () => {
  const t = setup({smsFailure:true});
  await assert.rejects(t.service.begin(t.auth.$id), /Gateway rejected/);
  assert.equal(await t.service.isVerified(t.auth.$id), false);
  assert.match((await t.service.begin(t.auth.$id)).error, /Wait 60 seconds/);
});
