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

function inlineScript(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'inline signup JavaScript exists');
  return match[1];
}

function fakeHome({ createError, signInError, profile }) {
  const elements = new Map();
  const calls = [];
  const redirects = [];
  const storage = new Map();
  let signedIn = false;
  let storedPhone = '';
  const email = 'brand-new-player@example.com';
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
      return { $id: 'new-id', email, name: 'Player', phone: storedPhone };
    }
    async updatePhone({phone, password}) {
      if (!signedIn || password !== data.password) throw Error('Invalid credentials');
      storedPhone = phone;
      calls.push('updatePhone');
    }
  }
  class Functions {
    async createExecution({ body }) {
      const { action } = JSON.parse(body);
      calls.push(action);
      const result = action === 'register_profile'
        ? profile
        : action === 'get_wallet'
          ? { ok: true, wallet: profile.wallet ?? 1000, spendableVC: profile.wallet ?? 1000 }
          : { ok: true, items: [] };
      return { responseBody: JSON.stringify(result) };
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
  new Script(inlineScript(homepage), { filename: 'index.html' }).runInContext(context);
  return { elements, calls, redirects, storage, clickSignup: () => getElement('signup').onclick(), clickLogin: () => getElement('login').onclick() };
}

test('homepage signup resumes a partially created Auth account and awards missing profile bonus', async () => {
  const h = fakeHome({
    createError: { type: 'user_already_exists', code: 409, message: 'User already exists' },
    profile: { ok: true, created: true, signupBonusVC: 1000, wallet: 1000 }
  });
  await h.clickSignup();
  assert.equal(h.calls.filter(x => x === 'create').length, 1);
  assert.equal(h.calls.filter(x => x === 'login').length, 1);
  assert.equal(h.calls.filter(x => x === 'register_profile').length, 1);
  assert.equal(h.calls.filter(x => x === 'updatePhone').length, 1);
  assert.match(h.elements.get('signedMsg').textContent, /Sign Up Bonus.*1,000 VC/);
  assert.match(h.elements.get('walletSummary').textContent, /Wallet: 1000 VC/);
  assert.deepEqual(h.redirects, ['number-draw.html']);
  assert.equal(h.storage.get('samratSignupBonusVC'), '1000');
});

test('repeated signup signs in but does not credit another bonus when profile already exists', async () => {
  const h = fakeHome({
    createError: { type: 'user_already_exists', code: 409, message: 'User already exists' },
    profile: { ok: true, created: false, signupBonusVC: 0, wallet: 210 }
  });
  await h.clickSignup();
  assert.match(h.elements.get('signedMsg').textContent, /duplicate bonus nahi/);
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

test('new signup still receives its original one-time bonus', async () => {
  const h = fakeHome({ profile: { ok: true, created: true, signupBonusVC: 1000, wallet: 1000 } });
  await h.clickSignup();
  assert.match(h.elements.get('signedMsg').textContent, /Sign Up Bonus.*1,000 VC/);
  assert.deepEqual(h.redirects, ['number-draw.html']);
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
  const h = fakeHome({ profile: { ok: false, error: 'Wallet setup failed', wallet: 0 } });
  await h.clickSignup();
  assert.equal(h.redirects.length, 0);
  assert.match(h.elements.get('signedMsg').textContent, /wallet setup pending/);
});

test('main Lucky Draw card is promoted ahead of signup and free coins', () => {
  const card = homepage.indexOf('class="skill-card draw" href="number-draw.html"');
  assert.ok(card > 0);
  assert.ok(card < homepage.indexOf('id="authPanel"'));
  assert.ok(card < homepage.indexOf('id="freeVcPanel"'));
  assert.ok(homepage.indexOf('id="freeVcPanel"') < homepage.indexOf('class="skill-card speed"'));
  assert.match(loginPage, /: "number-draw\.html";/);
  assert.equal(signupPage.match(/location\.replace\('number-draw\.html'\)/g)?.length, 2);
  assert.match(drawPage, /id="signupBonusNotice"/);
});

test('signup mobile validation rejects invalid or missing numbers before new Auth account', async () => {
  const h = fakeHome({ profile: { ok: true, wallet: 1000 } });
  h.elements.get('phone').value = '000';
  await h.clickSignup();
  assert.equal(h.calls.includes('create'), false);
  assert.equal(h.calls.includes('register_profile'), false);
  assert.equal(h.redirects.length, 0);
  assert.match(h.elements.get('authMsg').textContent, /valid 10-digit Indian mobile/);
});

test('both homepage and referral signup scripts parse and implement recovery', () => {
  new Script(inlineScript(homepage));
  new Script(inlineScript(signupPage));
  new Script(inlineScript(loginPage));
  new Script(inlineScript(drawPage));
  assert.match(signupPage, /finishWalletProfile\(user,name,email,entered\)/);
  assert.match(signupPage, /SamratPhone\.saveSignupMobile\(account,password,phone\)/);
  assert.match(homepage, /SamratPhone\.saveSignupMobile\(account, password, phone\)/);
  assert.match(signupPage, /WALLET_FUNCTION="6ae1bcc500208a5a7efb"/);
  assert.match(homepage, /if \(signupButton\.disabled\) return/);
});
