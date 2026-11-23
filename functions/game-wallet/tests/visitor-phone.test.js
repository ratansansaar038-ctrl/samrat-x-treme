import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';

const root = new URL('../../../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const phone = read('signup-phone.js');
const tracker = read('site-visitor.js');
const backend = read('functions/game-wallet/src/main.js');

test('required mobile format is +91 E.164 and mobile updates only once', async () => {
  const sandbox = createContext({ window: {} });
  new Script(phone).runInContext(sandbox);
  const helper = sandbox.window.SamratPhone;
  assert.equal(helper.normalizeMobile('9876543210'), '+919876543210');
  assert.equal(helper.normalizeMobile('+91 9876543210'), '+919876543210');
  assert.throws(() => helper.normalizeMobile('123'), /valid 10-digit/);
  assert.throws(() => helper.normalizeMobile('1234567890'), /valid 10-digit/);
  let current = {phone: ''}, saved = 0;
  const account = { get: async () => current, updatePhone: async ({phone, password}) => {
    assert.equal(password, 'test-password'); saved++; current = {phone};
  }};
  await helper.saveSignupMobile(account, 'test-password', '9876543210');
  await helper.saveSignupMobile(account, 'test-password', '+919876543210');
  assert.equal(saved, 1);
  await assert.rejects(helper.saveSignupMobile(account, 'test-password', '9876543211'), /different mobile/);
});

test('public pages include the privacy-conscious visitor tracker', () => {
  for (const name of ['index.html','number-draw.html','signup.html','login.html',
    'speed-tap.html','memory-x.html','math-challenge.html','player-profile.html']) {
    assert.match(read(name), /site-visitor\.js/);
  }
  assert.match(read('admin-dashboard.html'), /id="mVisitors"/);
});

test('browser visitor tracker sends one pseudonymous token per session', async () => {
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
  assert.equal(session.get('samratSiteVisitRecordedV1'),'1');
  new Script(tracker).runInContext(ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length,1);
});

test('backend visitor table uses hashed browser id and handles duplicate rows safely', () => {
  assert.match(backend, /async function trackSiteVisit\(body, key\)/);
  assert.match(backend, /createHash\("sha256"\)/);
  assert.match(backend, /if \(e\.status === 409\) return \{ ok: true, created: false \}/);
  assert.match(backend, /\["visitors", "site_visitors", \[lim\(1\)\]\]/);
  assert.match(backend, /visitors: data\.visitors\?\.total \?\? null/);
  assert.match(backend, /"track_site_visit"/);
  assert.doesNotMatch(backend.match(/async function trackSiteVisit[\s\S]*?const dashboardIsAdmin/)[0], /remoteAddress|x-forwarded-for|req\.ip|phoneNumber|email/);
});
