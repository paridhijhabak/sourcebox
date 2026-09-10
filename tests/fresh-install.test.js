'use strict';
/* A clean install, end to end: boot with an empty data dir, read the
 * generated passcode off stdout, log in, see the first-run screen, add a
 * project, set a real passcode. This is the experience anyone gets when they
 * clone this repo, so it must work with no prior state at all.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const fixture = require('./fixture');

const PORT = Number(process.env.FRESH_PORT) || 4489;
const BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.env.SHOT_DIR || os.tmpdir();
const VAULT_ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (l, c, e) => { c ? (pass++, console.log('  PASS  ' + l))
  : (fail++, console.log('  FAIL  ' + l + (e !== undefined ? '  -> ' + JSON.stringify(e).slice(0, 300) : ''))); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function call(p, o = {}) {
  const headers = Object.assign({}, o.headers);
  if (cookie) headers.Cookie = cookie;
  if (o.body && typeof o.body !== 'string') { o = Object.assign({}, o, { body: JSON.stringify(o.body) }); headers['Content-Type'] = 'application/json'; }
  const res = await fetch(BASE + p, Object.assign({}, o, { headers }));
  for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) cookie = c.split(';')[0];
  const t = res.headers.get('content-type') || '';
  return { status: res.status, body: t.includes('json') ? await res.json() : null };
}

let child = null;
let dataDir = null;
let browser = null;

(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-fresh-'));
  console.log('\n  fresh data dir: ' + dataDir);

  let out = '';
  child = spawn(process.execPath, ['server.js'], {
    cwd: VAULT_ROOT,
    env: Object.assign({}, process.env, { VAULT_DATA_DIR: dataDir, PORT: String(PORT) }),
    windowsHide: true,
  });
  child.stdout.on('data', (c) => { out += c.toString(); });
  child.stderr.on('data', (c) => { out += c.toString(); });
  child.on('error', (err) => { out += '\n[spawn error] ' + err.message; });
  child.on('exit', (code, signal) => { out += '\n[exited ' + code + ' ' + signal + ']'; });

  // stdout arrives in chunks, so wait for the specific line we need rather
  // than the first one; otherwise this races the banner.
  const PASSCODE_LINE = /Aapka passcode:\s+([a-z0-9-]+)/;
  for (let i = 0; i < 80 && !PASSCODE_LINE.test(out); i++) await wait(250);

  console.log('\n== first boot ==');
  ok('server started on a clean data dir', /is running/.test(out), out.slice(0, 200));
  const match = PASSCODE_LINE.exec(out);
  ok('a passcode was generated and printed', !!match, out.slice(0, 400));
  const passcode = match && match[1];
  ok('passcode is not a hardcoded constant',
     passcode !== 'primetime' && /^[a-z0-9]{4}-[a-z0-9]{4}$/.test(passcode || ''), passcode);
  ok('data files created in the new dir', fs.existsSync(path.join(dataDir, 'data', 'config.json')));
  const bootCfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'config.json'), 'utf8'));
  ok('printed passcode matches the stored one', bootCfg.generatedPasscode === passcode,
     { printed: passcode, stored: bootCfg.generatedPasscode });
  ok('passcode is stored hashed, never in plain text as the credential',
     typeof bootCfg.ownerPasscodeHash === 'string' && bootCfg.ownerPasscodeHash.length === 64);
  ok('nothing written into the checkout',
     !fs.existsSync(path.join(VAULT_ROOT, 'data', 'config.json')) ||
     fs.readFileSync(path.join(VAULT_ROOT, 'data', 'config.json'), 'utf8') !== fs.readFileSync(path.join(dataDir, 'data', 'config.json'), 'utf8'));

  console.log('\n== empty vault ==');
  ok('wrong passcode rejected', (await call('/api/login', { method: 'POST', body: { passcode: 'nope' } })).status === 401);
  const login = await call('/api/login', { method: 'POST', body: { passcode } });
  ok('generated passcode works', login.status === 200, login.body);
  ok('server flags it as still-default', login.body.passcodeIsDefault === true);
  const cat = await call('/api/catalog');
  ok('catalog is empty', cat.status === 200 && cat.body.projects.length === 0, cat.body.projects);

  console.log('\n== first-run screen ==');
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 860 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  ok('default vault name shown', (await page.$eval('#lock-title', (el) => el.textContent)) === 'Asset Vault',
     await page.$eval('#lock-title', (el) => el.textContent));
  await page.type('#lock-pass', passcode);
  await page.click('#lock-go');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
  await wait(1500);
  ok('first-run cards rendered', (await page.$$('.start-card')).length === 3,
     await page.$$eval('.start-card', (els) => els.map((e) => e.textContent.slice(0, 20))));
  ok('warned about the default passcode',
     /passcode/i.test(await page.$eval('#toasts', (el) => el.textContent)),
     await page.$eval('#toasts', (el) => el.textContent));
  await page.screenshot({ path: path.join(OUT, 'shot-first-run.png') });

  console.log('\n== add the first project from the empty state ==');
  const root = fixture.build();
  await page.click('.start-card[data-start="folder"]');
  await page.waitForSelector('#ap-root', { timeout: 5000 });
  ok('folder mode opened from the card', !!(await page.$('#ap-root')));
  await page.type('#ap-root', root);
  await page.type('#ap-name', 'My First Project');
  await page.click('#ap-go');
  await page.waitForSelector('.grid .card', { timeout: 20000 });
  await wait(2500);
  ok('project appears in the sidebar',
     (await page.$eval('.proj.on .proj-name', (el) => el.textContent)) === 'My First Project',
     await page.$eval('.proj.on .proj-name', (el) => el.textContent));
  ok('files are browsable', (await page.$$('.grid .card')).length > 3);
  ok('thumbnails render', await page.evaluate(async () => {
    for (let i = 0; i < 40; i++) {
      const el = [...document.querySelectorAll('[data-folder]')].find((e) => e.dataset.folder === 'logos');
      if (el) { el.click(); break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    for (let i = 0; i < 60; i++) {
      const n = [...document.querySelectorAll('.card-media img')].filter((im) => im.naturalWidth > 0).length;
      if (n > 3) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }));
  await page.screenshot({ path: path.join(OUT, 'shot-first-project.png') });

  console.log('\n== set a real passcode ==');
  const changed = await call('/api/passcode', { method: 'POST', body: { current: passcode, next: 'my-real-pass' } });
  ok('passcode changed', changed.status === 200, changed.body);
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'config.json'), 'utf8'));
  ok('generated passcode wiped from config', cfg.generatedPasscode === undefined, Object.keys(cfg));
  ok('no longer flagged default', cfg.passcodeIsDefault === false);
  cookie = '';
  ok('old passcode stops working',
     (await call('/api/login', { method: 'POST', body: { passcode } })).status === 401);
  ok('new passcode works',
     (await call('/api/login', { method: 'POST', body: { passcode: 'my-real-pass' } })).status === 200);

  ok('no JS errors', errors.length === 0, errors.slice(0, 4));

  console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' : 'ALL ') + (pass + fail) + ' fresh-install checks\n');
  await cleanup();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('CRASH', e); await cleanup(); process.exit(1); });

async function cleanup() {
  try { if (browser) await browser.close(); } catch { /* closed */ }
  try { if (child) child.kill(); } catch { /* gone */ }
  await wait(600);
  fixture.destroy();
  try { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* lock */ }
}
