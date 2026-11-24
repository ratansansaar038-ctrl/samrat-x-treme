import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';

const root = new URL('../../../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const phone = read('signup-phone.js');
const tracker = read('site-visitor.js');
const backend = read('functions/game-wallet/src/main.js');

test('Indian mobile uses E.164 and APITxT OTP stays on the server', async () => {
  const sandbox = createContext({ window: {} });
  new Script(phone).runInContext(sandbox);
  const helper = sandbox.window.SamratPhone;
  assert.equal(helper.normalizeMobile('9876543210'), '+919876543210');
  assert.equal(helper.normalizeMobile('+91 9876543210'), '+919876543210');
  assert.throws(() => helper.normalizeMobile('123'), /valid 10-digit/);
  let current = { $id: 'appwrite-user', phone: '' };
  let saved = 0, otpSent = 0, verified = false;
  const account = {
    get: async () => current,
    updatePhone: async ({phone, password}) => {
      assert.equal(password, 'test-password');
      saved++;
      current = {...current, phone};
      verified = false;
    }
  };
  const functions = {
    createExecution: async ({body}) => {
      const {action, otp} = JSON.parse(body);
      let result;
      if (action === 'sms_otp_status') result = {ok:true, verified};
      else if (action === 'start_sms_otp') {
        otpSent++;
        result = {ok:true, verified, phoneLast4:'3210'};
      } else if (action === 'verify_sms_otp') {
        if (otp !== '123456') result = {ok:false,error:'Incorrect OTP'};
        else {verified=true;result={ok:true,verified:true}}
      } else result={ok:false,error:'Unknown action'};
      return {responseStatusCode:result.ok?200:400,responseBody:JSON.stringify(result)};
    }
  };
  const begun = await helper.beginPhoneVerification(account, functions, 'test-password', '9876543210');
  assert.equal(begun.verified, false);
  assert.equal(saved, 1);
  assert.equal(otpSent, 1);
  await assert.rejects(helper.completePhoneVerification(account, functions, '000000'), /Incorrect OTP/);
  assert.equal(verified, false);
  const result = await helper.completePhoneVerification(account, functions, '123456');
  assert.equal(result.verified, true);
  assert.equal((await helper.getPhoneOtpStatus(functions)).verified, true);
  await helper.beginPhoneVerification(account, functions, 'test-password', '9876543210');
  assert.equal(saved, 1);
  await assert.rejects(helper.beginPhoneVerification(account, functions, 'test-password', '9876543211'), /verified mobile/);
});

test('public pages include the privacy-conscious visitor tracker', () => {
  for (const name of ['index.html','number-draw.html','signup.html','login.html',
    'speed-tap.html','memory-x.html','math-challenge.html','player-profile.html']) {
    assert.match(read(name), /site-visitor\.js/);
  }
  assert.match(read('admin-dashboard.html'), /id="mTodayVisitors"/);
  assert.match(read('admin-dashboard.html'), /id="mVisitors"/);
  assert.match(read('admin-dashboard.html'), /id="mPlayers"/);
});

test('browser visitor tracker sends one pseudonymous token per IST calendar day', async () => {
  const local = new Map(), session = new Map(), calls = [];
  const store = map => ({
    getItem: key => map.get(key) ?? null,
    setItem: (key,val) => map.set(key, String(val))
  });
  const browserId = '9d386735-79a8-45ba-8f85-f67a8d063b29';
  const ctx = createContext({
    window: {crypto: {randomUUID: () => browserId}},
    localStorage: store(local),
    sessionStorage: store(session),
    fetch: async (url, options) => {
      calls.push({url, body: JSON.parse(options.body)});
      return {ok: true, json: async () => ({
        responseStatusCode: 200,
        responseBody: JSON.stringify({ok:true,created:true})
      })};
    }
  });
  new Script(tracker).runInContext(ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length,1);
  assert.equal(JSON.parse(calls[0].body.body).action,'track_site_visit');
  assert.equal(JSON.parse(calls[0].body.body).browserId,browserId);
  const todayIST = new Date(Date.now() + 330 * 60000).toISOString().slice(0,10);
  assert.equal(session.get('samratSiteVisitRecordedISTDayV2'),todayIST);
  new Script(tracker).runInContext(ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length,1);
  // A returning browser from another India day reuses its token.
  session.set('samratSiteVisitRecordedISTDayV2','2000-01-01');
  new Script(tracker).runInContext(ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length,2);
  assert.equal(JSON.parse(calls[1].body.body).browserId,browserId);
  assert.equal(session.get('samratSiteVisitRecordedISTDayV2'),todayIST);
});

test('backend visitor table keeps all-time unique rows and counts daily returning browsers', () => {
  assert.match(backend, /async function trackSiteVisit\(body, key\)/);
  assert.match(backend, /rowId, data: \{ firstSeenAt: new Date\(\)\.toISOString\(\) \}/);
  assert.match(backend, /createHash\("sha256"\)/);
  assert.match(backend, /if \(e\.status !== 409\) throw e/);
  assert.match(backend, /request\("GET", rowPath, key\)/);
  assert.match(backend, /Date\.parse\(existing\.\$updatedAt\) >= istDayStartMs\(\)/);
  assert.match(backend, /request\("PATCH", rowPath, key/);
  assert.match(backend, /firstSeenAt: existing\.firstSeenAt \|\| existing\.\$createdAt/);
  assert.match(backend, /\["todayVisitors", "site_visitors", \[gte\("\$updatedAt", todayStartIST\), lim\(1\)\]\]/);
  assert.match(backend, /\["visitors", "site_visitors", \[lim\(1\)\]\]/);
  assert.match(backend, /todayVisitors: data\.todayVisitors\?\.total \?\? null/);
  assert.match(backend, /visitors: data\.visitors\?\.total \?\? null/);
  assert.match(backend, /"track_site_visit"/);
  assert.doesNotMatch(backend.match(/async function trackSiteVisit[\s\S]*?const dashboardIsAdmin/)[0], /remoteAddress|x-forwarded-for|req\.ip|phoneNumber|email/);
});

test('India day starts at 00:00 IST, not at midnight UTC', () => {
  const source = backend.match(/function istDayStartMs\(utcMs = Date\.now\(\)\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, 'IST day boundary helper must be present');
  const startOfDay = new Function('IST_OFFSET_MS', source + '\nreturn istDayStartMs;')(330 * 60000);
  assert.equal(new Date(startOfDay(Date.parse('2026-11-24T12:34:56Z'))).toISOString(), '2026-11-23T18:30:00.000Z');
  assert.equal(new Date(startOfDay(Date.parse('2026-11-23T18:29:59Z'))).toISOString(), '2026-11-22T18:30:00.000Z');
});
