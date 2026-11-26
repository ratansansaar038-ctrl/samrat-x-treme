import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';

const root = new URL('../../../', import.meta.url);
const homepage = readFileSync(new URL('index.html', root), 'utf8');
const signupPage = readFileSync(new URL('signup.html', root), 'utf8');
const loginPage = readFileSync(new URL('login.html', root), 'utf8');
const drawPage = readFileSync(new URL('number-draw.html', root), 'utf8');
const phoneHelper = readFileSync(new URL('signup-phone.js', root), 'utf8');
const otpPage = readFileSync(new URL('verify-phone.html', root), 'utf8');
const server = readFileSync(new URL('functions/game-wallet/src/main.js', root), 'utf8');
const admin = readFileSync(new URL('admin-dashboard.html', root), 'utf8');
const visitor = readFileSync(new URL('site-visitor.js', root), 'utf8');

function inlineScript(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'inline signup JavaScript exists');
  return match[1];
}

function fakeHome({ createError, signInError, profile, verifiedPhone = false, otpSendError, adminEmail = false }) {
  const elements = new Map();
  const calls = [];
  const redirects = [];
  const storage = new Map();
  let signedIn = false;
  let storedPhone = verifiedPhone ? '+919876543210' : '';
  let isPhoneVerified = verifiedPhone;
  const email = adminEmail ? 'gauravguptabjr@gmail.com' : 'brand-new-player@example.com';
  const data = { email, password: 'Safe-Test-Pass-123', name: 'Player', phone: '9876543210' };
  const getElement = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: data[id] || '', textContent: '', disabled: false,
        classList: { add() {}, remove() {}, toggle() {} }
      });
    }
    return elements.get(id);
  };
  class Client {
    setEndpoint() { return this; }
    setProject() { return this; }
  }
  class Account {
    async create() {
      calls.push('create');
      if (createError) throw createError;
      return { $id: 'new-id', email };
    }
    async createEmailPasswordSession({ email: input, password }) {
      calls.push('login');
      if (signInError) throw signInError;
      if (input !== email || password !== data.password) throw Error('Bad credentials');
      signedIn = true;
    }
    async get() {
      if (!signedIn) throw Error('Not signed in');
      return { $id: 'new-id', email, name: 'Player', phone: storedPhone, phoneVerification: isPhoneVerified };
    }
    async updatePhone({phone, password}) {
      if (!signedIn || password !== data.password) throw Error('Invalid credentials');
      storedPhone = phone;
      isPhoneVerified = false;
      calls.push('updatePhone');
    }

  }
  class Functions {
    async createExecution({ body }) {
      const { action, otp } = JSON.parse(body);
      calls.push(action);
      let result;
      if (action === 'register_profile') result = profile;
      else if (action === 'get_wallet')
        result = { ok: true, wallet: profile.wallet ?? 1000, spendableVC: profile.wallet ?? 1000 };
      else if (action === 'sms_otp_status')
        result = { ok: true, verified: isPhoneVerified, phoneLast4: storedPhone.slice(-4) };
      else if (action === 'start_sms_otp')
        result = otpSendError
          ? { ok: false, error: otpSendError.message }
          : { ok: true, verified: isPhoneVerified, phoneLast4: storedPhone.slice(-4) };
      else if (action === 'verify_sms_otp') {
        if (otp === '123456') { isPhoneVerified = true; result = { ok: true, verified: true }; }
        else result = { ok: false, error: 'Incorrect OTP' };
      } else result = { ok: true, items: [] };
      return { responseBody: JSON.stringify(result), responseStatusCode: result.ok ? 200 : 400 };
    }
  }
  const context = createContext({
    Appwrite: { Client, Account, Functions, ID: { unique: () => 'unique()' } },
    document: { getElementById: getElement },
    window: { location: { replace: (path) => redirects.push(path) } },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    setInterval() {}, console,
  });
  new Script(phoneHelper, { filename: 'signup-phone.js' }).runInContext(context);
  // Browser window properties also resolve as globals; vm context needs an explicit alias.
  context.SamratPhone = context.window.SamratPhone;
  new Script(inlineScript(homepage), { filename: 'index.html' }).runInContext(context);
  return { elements, getElement, calls, redirects, storage, account: new Account(), functions: new Functions(), phoneHelper: context.SamratPhone, clickSignup: () => getElement('signup').onclick(), clickLogin: () => getElement('login').onclick() };
}

test('homepage signup resumes a partially created Auth account and awards missing profile bonus', async () => {
  const h = fakeHome({
    createError: { type: 'user_already_exists', code: 409, message: 'User already exists' },
    profile: { ok: true, created: true, signupBonusVC: 1000, wallet: 1000 },
    verifiedPhone: true
  });
  await h.clickSignup();
  assert.equal(h.calls.filter(x => x === 'create').length, 1);
  assert.equal(h.calls.filter(x => x === 'login').length, 1);
  assert.equal(h.calls.filter(x => x === 'register_profile').length, 1);
  assert.equal(h.calls.filter(x => x === 'updatePhone').length, 0);
  assert.match(h.elements.get('signedMsg').textContent, /Sign Up Bonus.*1,000 VC/);
  assert.match(h.elements.get('walletSummary').textContent, /Wallet: 1000 VC/);
  assert.deepEqual(h.redirects, ['number-draw.html']);
  assert.equal(h.storage.get('samratSignupBonusVC'), '1000');
});

test('repeated signup signs in but does not credit another bonus when profile already exists', async () => {
  const h = fakeHome({
    createError: { type: 'user_already_exists', code: 409, message: 'User already exists' },
    profile: { ok: true, created: false, signupBonusVC: 0, wallet: 210 },
    verifiedPhone: true
  });
  await h.clickSignup();
  assert.match(h.elements.get('signedMsg').textContent, /no duplicate bonus/);
  assert.match(h.elements.get('walletSummary').textContent, /Wallet: 210 VC/);
  assert.deepEqual(h.redirects, ['number-draw.html']);
  assert.equal(h.storage.get('samratSignupBonusVC'), undefined);
});

test('existing email with wrong password cannot get a bonus or bypass login', async () => {
  const h = fakeHome({
    createError: { type: 'user_already_exists', code: 409, message: 'User already exists' },
    signInError: Error('Invalid credentials'),
    profile: { ok: true, created: true, signupBonusVC: 1000 }
  });
  await h.clickSignup();
  assert.ok(!h.calls.includes('register_profile'));
  assert.ok(!h.calls.includes('updatePhone'));
  assert.match(h.elements.get('authMsg').textContent, /Email already registered/);
  assert.equal(h.redirects.length, 0);
});

test('disabled homepage OTP path does not send SMS, and blocks wallet on backend verification error', async () => {
  const h = fakeHome({ profile: { ok: false, error: 'Mobile verification required to create wallet.' } });
  await h.clickSignup();
  assert.ok(h.calls.includes('create'));
  assert.ok(h.calls.includes('register_profile'));
  assert.ok(!h.calls.includes('updatePhone'));
  assert.ok(!h.calls.includes('start_sms_otp'));
  assert.equal(h.redirects.length, 0);
  assert.match(h.elements.get('signedMsg').textContent, /wallet setup pending/i);
})

test('APITxT OTP must verify through the backend before the profile is created', async () => {
  const h = fakeHome({ profile: { ok: true, wallet: 1000 } });
  await h.clickLogin();
  await h.phoneHelper.beginPhoneVerification(h.account, h.functions, 'Safe-Test-Pass-123', '9876543210');
  await assert.rejects(() => h.phoneHelper.completePhoneVerification(h.account, h.functions, '000000'), /Incorrect OTP/);
  await h.phoneHelper.completePhoneVerification(h.account, h.functions, '123456');
  assert.equal((await h.phoneHelper.getPhoneOtpStatus(h.functions)).verified, true);
});

test('disabled homepage SMS flow never calls the SMS gateway', async () => {
  const h = fakeHome({
    profile: { ok: false, error: 'Phone verification required' },
    otpSendError: Error('SMS service is disabled')
  });
  await h.clickSignup();
  assert.ok(!h.calls.includes('start_sms_otp'));
  assert.ok(!h.calls.includes('verify_sms_otp'));
  assert.equal(h.redirects.length, 0);
})

test('homepage routes login and signup to Lucky Number Draw, not Speed Tap', () => {
  assert.equal(homepage.match(/window\.location\.replace\('number-draw\.html'\)/g)?.length, 2);
  assert.doesNotMatch(homepage, /window\.location\.replace\('speed-tap\.html'\)/);
  // The homepage does not activate the optional SMS phone verification helper.
  assert.doesNotMatch(homepage, /SamratPhone\.beginPhoneVerification/);
})

test('primary admin login opens dashboard directly without loading player wallet', async () => {
  const h = fakeHome({ profile: { ok: true, wallet: 999 }, adminEmail: true });
  await h.clickLogin();
  assert.deepEqual(h.redirects, ['admin-dashboard.html']);
  assert.equal(h.calls.includes('get_wallet'), false);
  assert.match(homepage, /PRIMARY_ADMIN_EMAIL = 'gauravguptabjr@gmail.com'/);
  assert.match(loginPage, /return "admin-dashboard.html"/);
  assert.match(loginPage, /loginDestination\(signedInUser\)/);
  assert.match(drawPage, /window\.location\.replace\('admin-dashboard\.html'\)/);
  assert.match(admin, /const snapshot=await api\('admin_dashboard'\)/);
  assert.doesNotMatch(admin, /const r=await api\('get_wallet'\)/);
  assert.match(server, /const dashboardIsAdmin = \(user\)/);
});

test('homepage login redirects only after successful authentication', async () => {
  const h = fakeHome({ profile: { ok: true, wallet: 800 } });
  await h.clickLogin();
  assert.deepEqual(h.redirects, ['number-draw.html']);
  const wrong = fakeHome({ signInError: Error('Invalid credentials'), profile: { ok: true, wallet: 800 } });
  await wrong.clickLogin();
  assert.equal(wrong.redirects.length, 0);
});

test('wallet setup failure does not redirect to a broken game session', async () => {
  const h = fakeHome({ profile: { ok: false, error: 'Wallet setup failed', wallet: 0 }, verifiedPhone: true });
  await h.clickSignup();
  assert.equal(h.redirects.length, 0);
  assert.match(h.elements.get('signedMsg').textContent, /wallet setup pending/);
});

test('Lucky Number Draw remains available and dedicated login defaults to it', () => {
  const card = homepage.indexOf('class="skill-card draw" href="number-draw.html"');
  assert.ok(card > 0);
  assert.ok(card > homepage.indexOf('id="authPanel"'));
  assert.ok(card < homepage.indexOf('id="freeVcPanel"'));
  assert.match(loginPage, /: "number-draw\.html";/);
  assert.match(signupPage, /s\.verified\?'number-draw\.html':'verify-phone\.html'/);
  assert.match(drawPage, /id="signupBonusNotice"/);
})

test('paid traffic sees Number Draw and signup before free skill games', () => {
  assert.ok(homepage.indexOf('class="skill-card draw"') < homepage.indexOf('class="skill-card speed"'));
  assert.match(homepage, /NEW PLAYER\? CREATE FREE ACCOUNT/);
  assert.match(homepage, /href="#authPanel"/);
  assert.match(drawPage, /CREATE FREE ACCOUNT/);
  assert.match(drawPage, /Preview only: no virtual coins/);
  assert.match(drawPage, /<details>/);
});

test('homepage existing-login path needs no SMS OTP when optional feature is disabled', async () => {
  const h = fakeHome({ profile: { ok: true, wallet: 1000 } });
  await h.clickLogin();
  assert.deepEqual(h.redirects, ['number-draw.html']);
  assert.ok(!h.calls.includes('start_sms_otp'));
  assert.ok(!h.calls.includes('updatePhone'));
  assert.doesNotMatch(homepage, /id="phone"/);
})

test('both homepage and referral signup scripts parse and implement recovery', () => {
  new Script(inlineScript(homepage));
  new Script(inlineScript(signupPage));
  new Script(inlineScript(loginPage));
  new Script(inlineScript(drawPage));
  new Script(inlineScript(otpPage));
  new Script(phoneHelper);
  assert.match(signupPage, /finishWalletProfile\(user,name,email,entered\)/);
  assert.match(signupPage, /SamratPhone\.beginPhoneVerification\(account,functions,password,phone\)/);
  assert.doesNotMatch(homepage, /SamratPhone\.beginPhoneVerification/);
  assert.match(otpPage, /completePhoneVerification\(account/);
  assert.match(otpPage, /SamratPhone\.getPhoneOtpStatus\(functions\)/);
  assert.doesNotMatch(signupPage, /db\.createRow/);
  assert.match(server, /smsOtpService\(key\)\.isVerified\(user\)/);
  assert.match(server, /https:\/\/apitxt\.com\/api\/sendOTP/);
  assert.doesNotMatch(server, /await account\.createPhoneVerification\(/);
  assert.match(server, /track_site_visit/);
  assert.match(admin, /id="mVisitors"/);
  assert.match(visitor, /samratSiteVisitorIdV1/);
  assert.match(signupPage, /WALLET_FUNCTION="6ae1bcc500208a5a7efb"/);
  assert.match(homepage, /if \(signupButton\.disabled\) return/);
});

test('server respects deliberately disabled SMS OTP for real email accounts', () => {
  assert.match(server, /const requireSmsOtp = \/\^\(true\|1\|yes\)\$\/i\.test\(process\.env\.SAMRAT_REQUIRE_SMS_OTP \|\| ""\)/);
  assert.match(server, /if \(requireSmsOtp && !\(await smsOtpService\(key\)\.isVerified\(user\)\)\)/);
  assert.match(server, /const authUser = await request\("GET", "\/users\/" \+ encodeURIComponent\(user\), key\)/);
  assert.match(server, /!authUser\.email\.trim\(\)/);
  assert.match(server, /email: authUser\.email\.slice\(0, 160\)/);
  assert.match(server, /if \(existing\.length\)[\s\S]*?signupBonusVC: 0/);
});

test('stuck auth accounts resume missing player wallet without sending SMS OTP', () => {
  assert.match(homepage, /Profile missing or duplicated/i);
  assert.match(homepage, /const result = await api\('register_profile',/);
  assert.match(homepage, /w = await api\('get_wallet'\)/);
  assert.doesNotMatch(homepage, /SamratPhone\.beginPhoneVerification/);
  assert.match(loginPage, /href="index\.html#authPanel">CREATE ACCOUNT<\/a>/);
});

test('homepage Telegram ticker and backend activity use the same real handle', () => {
  assert.match(homepage, /Join @samratxtreme on Telegram/);
  assert.match(homepage, /href="https:\/\/t\.me\/samratxtreme"/);
  assert.doesNotMatch(homepage, /@samratxtremegame/);
  assert.match(homepage, /replace\(\/@samratxtremegame\\b\/gi, '@samratxtreme'\)/);
  assert.match(server, /Join @samratxtreme on Telegram for live draw results/);
  assert.doesNotMatch(server, /@samratxtremegame/);
});

test('homepage emphasizes free game engagement while keeping legal disclaimer in footer', () => {
  assert.match(homepage, /FREE SKILL & NUMBER ARENA • TOP RANKS • DAILY STREAKS • FREE VOUCHERS/);
  const beforeSignup = homepage.slice(homepage.indexOf('<header class="hero">'), homepage.indexOf('<input id="name"'));
  assert.doesNotMatch(beforeSignup, /have no cash value/);
  assert.match(homepage, /Free-to-play entertainment only • Virtual coins have no cash or monetary value/);
  assert.match(homepage, /No real-money deposits, paid purchases, or cash withdrawals/);
});

test('homepage public top players box uses server-verified leaderboards and never exposes wallets', () => {
  assert.match(homepage, /id="homeTopPlayers"/);
  assert.match(homepage, /id="homeBoardSpeed"/);
  assert.match(homepage, /id="homeBoardMemory"/);
  assert.match(homepage, /id="homeBoardMath"/);
  assert.match(homepage, /api\('get_leaderboard', \{ gameId: HOME_BOARD_GAMES\[buttonId\] \}\)/);
  assert.match(homepage, /entries\.slice\(0, 3\)/);
  assert.match(homepage, /Verified game scores only|server-verified skill-game scores/);
  assert.match(homepage, /rankings are not based on VC wallet balances/i);
  assert.match(server, /async function getLeaderboard\(gameId, key\)/);
  assert.match(server, /eq\("verified", true\)/);
  assert.match(homepage, /typeof IntersectionObserver === 'function'/);
  assert.ok(homepage.indexOf('id="homeTopPlayers"') < homepage.indexOf('class="skill-card speed"'));
});
