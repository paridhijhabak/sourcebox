'use strict';
/* Accounts, end to end, against a vault booted on a throwaway data dir so the
 * real one is never touched: the first sign-up owns the vault, later sign-ups
 * need the owner passcode, a session actually unlocks the API, and the owner
 * passcode still works on its own.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.ACCOUNTS_PORT) || 4491;
const BASE = 'http://localhost:' + PORT;
const VAULT_ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient() {
  let cookie = '';
  async function call(p, o = {}) {
    const headers = Object.assign({}, o.headers);
    if (cookie) headers.Cookie = cookie;
    if (o.body && typeof o.body !== 'string') {
      o = Object.assign({}, o, { body: JSON.stringify(o.body) });
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(BASE + p, Object.assign({}, o, { headers }));
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) cookie = c.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : null };
  }
  return { call, drop() { cookie = ''; } };
}

let child = null;
let dataDir = null;

(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-accounts-'));
  let out = '';
  child = spawn(process.execPath, ['server.js'], {
    cwd: VAULT_ROOT,
    env: Object.assign({}, process.env, { VAULT_DATA_DIR: dataDir, PORT: String(PORT) }),
    windowsHide: true,
  });
  child.stdout.on('data', (c) => { out += c.toString(); });
  child.stderr.on('data', (c) => { out += c.toString(); });

  for (let i = 0; i < 60 && !/is running/.test(out); i++) await wait(250);
  if (!/is running/.test(out)) { console.error(out); throw new Error('server did not start'); }
  const passcode = (out.match(/Your passcode:\s+(\S+)/) || [])[1];
  ok('server printed a generated passcode', !!passcode, out.slice(0, 200));

  const owner = makeClient();

  console.log('\n== a vault with no account ==');
  let r = await owner.call('/api/auth/state');
  ok('state says the first account is needed', r.body.needsFirstAccount === true && r.body.accounts === 0, r.body);
  ok('catalog is locked', (await owner.call('/api/catalog')).status === 401);

  console.log('\n== sign up ==');
  r = await owner.call('/api/auth/signup', { method: 'POST', body: { name: 'Ada', email: 'ADA@Example.com', password: 'short' } });
  ok('short password rejected', r.status === 400, r.body);
  r = await owner.call('/api/auth/signup', { method: 'POST', body: { name: 'Ada', email: 'not-an-email', password: 'correct horse' } });
  ok('bad email rejected', r.status === 400, r.body);

  r = await owner.call('/api/auth/signup', { method: 'POST', body: { name: 'Ada', email: 'ADA@Example.com', password: 'correct horse' } });
  ok('first sign-up succeeds', r.status === 200, r.body);
  ok('first account owns the vault', r.body.user && r.body.user.role === 'owner', r.body);
  ok('email is stored lower-cased', r.body.user && r.body.user.email === 'ada@example.com', r.body);
  ok('signing up signs you in', (await owner.call('/api/catalog')).status === 200);
  r = await owner.call('/api/session');
  ok('session names the account', r.body.owner === true && r.body.user && r.body.user.name === 'Ada', r.body);
  ok('users.json written', fs.existsSync(path.join(dataDir, 'data', 'users.json')));
  ok('password is not stored in the clear',
     !fs.readFileSync(path.join(dataDir, 'data', 'users.json'), 'utf8').includes('correct horse'));

  console.log('\n== a stranger ==');
  const stranger = makeClient();
  r = await stranger.call('/api/auth/signup', { method: 'POST', body: { name: 'Mal', email: 'mal@example.com', password: 'let me in please' } });
  ok('second sign-up without the passcode is refused', r.status === 401 && r.body.needsPasscode === true, r.body);
  r = await stranger.call('/api/auth/signup', { method: 'POST', body: { name: 'Mal', email: 'mal@example.com', password: 'let me in please', passcode: 'wrong-code' } });
  ok('a wrong passcode does not get you in', r.status === 401, r.body);
  ok('stranger still locked out', (await stranger.call('/api/catalog')).status === 401);

  console.log('\n== invited member ==');
  const member = makeClient();
  r = await member.call('/api/auth/signup', { method: 'POST', body: { name: 'Lin', email: 'lin@example.com', password: 'another good one', passcode } });
  ok('the owner passcode invites a second account', r.status === 200, r.body);
  ok('later accounts are members', r.body.user && r.body.user.role === 'member', r.body);
  r = await member.call('/api/auth/signup', { method: 'POST', body: { name: 'Lin', email: 'lin@example.com', password: 'another good one', passcode } });
  ok('duplicate email refused', r.status === 409, r.body);

  console.log('\n== log in ==');
  const again = makeClient();
  r = await again.call('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'wrong password' } });
  ok('wrong password refused', r.status === 401, r.body);
  ok('a failed login leaves you locked out', (await again.call('/api/catalog')).status === 401);
  r = await again.call('/api/auth/login', { method: 'POST', body: { email: '  Ada@Example.com ', password: 'correct horse' } });
  ok('login works, email case and spacing forgiven', r.status === 200, r.body);
  ok('session unlocks the API', (await again.call('/api/catalog')).status === 200);

  console.log('\n== password change ==');
  r = await again.call('/api/auth/password', { method: 'POST', body: { current: 'nope', next: 'a whole new one' } });
  ok('wrong current password refused', r.status === 401, r.body);
  r = await again.call('/api/auth/password', { method: 'POST', body: { current: 'correct horse', next: 'a whole new one' } });
  ok('password changed', r.status === 200, r.body);
  const fresh = makeClient();
  ok('old password no longer works',
     (await fresh.call('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'correct horse' } })).status === 401);
  ok('new password works',
     (await fresh.call('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'a whole new one' } })).status === 200);

  console.log('\n== roles ==');
  const memberList = await member.call('/api/auth/users');
  ok('a member can see who else is here', memberList.status === 200 && memberList.body.users.length === 2, memberList.body);
  const memberId = memberList.body.users.find((u) => u.email === 'lin@example.com').id;
  ok('no password hash is ever sent to the browser',
     !JSON.stringify(memberList.body).includes('passwordHash'));
  ok('a member cannot remove accounts',
     (await member.call('/api/auth/users/' + memberId, { method: 'DELETE' })).status === 403);

  console.log('\n== the passcode still works on its own ==');
  const byCode = makeClient();
  ok('wrong passcode refused',
     (await byCode.call('/api/login', { method: 'POST', body: { passcode: 'definitely-not-it' } })).status === 401);
  ok('passcode login still works',
     (await byCode.call('/api/login', { method: 'POST', body: { passcode } })).status === 200);
  ok('passcode session unlocks the API', (await byCode.call('/api/catalog')).status === 200);
  r = await byCode.call('/api/session');
  ok('a passcode session carries no account', r.body.owner === true && !r.body.user, r.body);
  r = await byCode.call('/api/auth/password', { method: 'POST', body: { current: 'x', next: 'yyyyyyyy' } });
  ok('a passcode session has no password to change', r.status === 400, r.body);

  console.log('\n== sign out ==');
  await again.call('/api/auth/logout', { method: 'POST' });
  ok('logging out locks the API again', (await again.call('/api/catalog')).status === 401);

  console.log('\n== removing an account ==');
  const ownerNow = makeClient();
  await ownerNow.call('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'a whole new one' } });
  ok('owner removes the member', (await ownerNow.call('/api/auth/users/' + memberId, { method: 'DELETE' })).status === 200);
  ok('the removed account\'s session dies at once', (await member.call('/api/catalog')).status === 401);
  const ownerId = memberList.body.users.find((u) => u.email === 'ada@example.com').id;
  ok('the owner account cannot be removed',
     (await ownerNow.call('/api/auth/users/' + ownerId, { method: 'DELETE' })).status === 400);

  console.log('\n== the product page ==');
  const page = await fetch(BASE + '/product');
  const html = await page.text();
  ok('/product serves the product page', page.status === 200 && html.includes('id="auth-form"'));
  ok('/usp still serves it too', (await fetch(BASE + '/usp')).status === 200);
  ok('the page is readable without signing in', html.includes('id="account"'));
})()
  .catch((err) => { fail++; console.log('  FAIL  threw -> ' + err.message); })
  .finally(async () => {
    if (child) child.kill();
    await wait(300);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    const total = pass + fail;
    console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' : 'ALL ') + total + ' account checks\n');
    process.exit(fail ? 1 : 0);
  });
