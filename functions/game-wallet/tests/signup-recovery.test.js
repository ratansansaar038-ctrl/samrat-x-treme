import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';

const root = new URL('../../../', import.meta.url);
const homepage = readFileSync(new URL('index.html', root), 'utf8');
const signupPage = readFileSync(new URL('signup.html', root), 'utf8');

function inlineScript(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'inline signup JavaScript exists');
  return match[1];
}

function fakeHome({ createError, signInError, profile }) {
  const elements = new Map();
  const calls = [];
  let signedIn = false;
  const email = 'brand-new-player@example.com';
  const data = { email, password: 'Safe-Test-Pass-123', name: 'Player' };
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
      return { $id: 'new-id', email, name: 'Player' };
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
    sessionStorage: { getItem: () => null, removeItem() {} },
    setInterval() {}, console,
  });
  new Script(inlineScript(homepage), { filename: 'index.html' }).runInContext(context);
  return { elements, calls, clickSignup: () => getElement('signup').onclick() };
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
  assert.match(h.elements.get('signedMsg').textContent, /Sign Up Bonus.*1,000 VC/);
  assert.match(h.elements.get('walletSummary').textContent, /Wallet: 1000 VC/);
});

test('repeated signup signs in but does not credit another bonus when profile already exists', async () => {
  const h = fakeHome({
    createError: { type: 'user_already_exists', code: 409, message: 'User already exists' },
    profile: { ok: true, created: false, signupBonusVC: 0, wallet: 210 }
  });
  await h.clickSignup();
  assert.match(h.elements.get('signedMsg').textContent, /duplicate bonus nahi/);
  assert.match(h.elements.get('walletSummary').textContent, /Wallet: 210 VC/);
});

test('existing email with wrong password cannot get a bonus or bypass login', async () => {
  const h = fakeHome({
    createError: { type: 'user_already_exists', code: 409, message: 'User already exists' },
    signInError: Error('Invalid credentials'),
    profile: { ok: true, created: true, signupBonusVC: 1000 }
  });
  await h.clickSignup();
  assert.ok(!h.calls.includes('register_profile'));
  assert.match(h.elements.get('authMsg').textContent, /Email already registered/);
});

test('new signup still receives its original one-time bonus', async () => {
  const h = fakeHome({ profile: { ok: true, created: true, signupBonusVC: 1000, wallet: 1000 } });
  await h.clickSignup();
  assert.match(h.elements.get('signedMsg').textContent, /Sign Up Bonus.*1,000 VC/);
});

test('both homepage and referral signup scripts parse and implement recovery', () => {
  new Script(inlineScript(homepage));
  new Script(inlineScript(signupPage));
  assert.match(signupPage, /finishWalletProfile\(user,name,email,entered\)/);
  assert.match(signupPage, /WALLET_FUNCTION="6ae1bcc500208a5a7efb"/);
  assert.match(homepage, /if \(signupButton\.disabled\) return/);
});
