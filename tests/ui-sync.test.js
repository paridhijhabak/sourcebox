'use strict';
/* The browser reacting on its own: live index updates, the git strip, and
 * adding a project from a git URL through the UI with live clone progress. */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./helpers');

const BASE = H.BASE;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.env.SHOT_DIR || os.tmpdir();

const client = H.makeClient();
const { ok, finish } = H.reporter();
const wait = H.wait;

const GIT_ENV = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' });
const git = (cwd, ...a) =>
  execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tmp = null;
let PID = null;
let clonedId = null;
const probes = [];

function drop(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  probes.push(p);
  return p;
}
function cleanupProbes() {
  for (const p of probes) { try { fs.unlinkSync(p); } catch { /* gone */ } }
}

async function selectProject(page, id) {
  await page.evaluate((pid) => {
    const el = [...document.querySelectorAll('[data-proj]')].find((e) => e.dataset.proj === pid);
    if (el) el.click();
  }, id);
  await wait(2000);
}

(async () => {
  await H.login(client);
  const fx = await H.ensureFixture(client);
  PID = fx.id;
  const watchDir = path.join(fx.root, 'logos');

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) errors.push(m.text()); });
  const bad = [];
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().startsWith(BASE)) bad.push(r.status() + ' ' + decodeURIComponent(r.url()).replace(BASE, ''));
  });

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.type('#lock-pass', H.PASSCODE);
  await page.click('#lock-go');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
  await page.waitForSelector('.proj', { timeout: 15000 });
  await selectProject(page, PID);

  console.log('\n== live update, no reload ==');
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-folder]')].find((e) => e.dataset.folder === 'logos');
    if (el) el.click();
  });
  await wait(2500);

  const navId = await page.evaluate(() => {
    window.__navMarker = Math.random();     // survives re-render, dies on reload
    window.__toasts = [];
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.classList && node.classList.contains('toast')) window.__toasts.push(node.textContent);
        }
      }
    }).observe(document.getElementById('toasts'), { childList: true });
    return window.__navMarker;
  });
  const before = await page.$$eval('.grid .card', (els) => els.length);
  ok('inside the logos folder', before > 3, before);

  drop(watchDir, '__live_probe_a.svg', H.fixture.svg(120, 80, '#eb2127', 'probe A'));
  await wait(5000);

  const after = await page.$$eval('.grid .card', (els) => els.length);
  ok('grid grew by itself', after === before + 1, { before, after });
  ok('the new file is on screen',
     await page.$$eval('.card-name', (els) => els.some((e) => e.textContent === '__live_probe_a.svg')));
  ok('page never reloaded', (await page.evaluate(() => window.__navMarker)) === navId);
  ok('a toast announced it',
     (await page.evaluate(() => window.__toasts)).some((t) => /nayi file/.test(t)),
     await page.evaluate(() => window.__toasts));
  await page.screenshot({ path: path.join(OUT, 'shot-live-update.png') });
  ok('new file got a thumbnail automatically', await page.evaluate(async () => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.dataset.file === 'logos/__live_probe_a.svg');
    if (!card) return false;
    for (let i = 0; i < 40; i++) {
      const img = card.querySelector('img');
      if (img && img.naturalWidth > 0) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }));

  const beforeDel = await page.$$eval('.grid .card', (els) => els.length);
  fs.unlinkSync(probes.pop());
  await wait(5000);
  ok('grid shrank by itself',
     (await page.$$eval('.grid .card', (els) => els.length)) === beforeDel - 1);

  console.log('\n== refresh waits for an open preview ==');
  await page.$$eval('.card[data-file]', (els) => els[0].click());
  await page.waitForSelector('#viewer:not(.hidden)', { timeout: 8000 });
  await wait(1200);
  const countDuring = await page.$eval('.v-side', (el) => (el.textContent.match(/of (\d+)/) || [])[1]);
  drop(watchDir, '__live_probe_b.svg', H.fixture.svg(60, 60, '#fcd404', 'probe B'));
  await wait(5000);
  ok('viewer stayed open while the index moved',
     await page.$eval('#viewer', (el) => !el.classList.contains('hidden')));
  ok('viewer total did not shift under the user',
     (await page.$eval('.v-side', (el) => (el.textContent.match(/of (\d+)/) || [])[1])) === countDuring,
     { countDuring });
  await page.keyboard.press('Escape');
  await wait(2500);
  ok('deferred refresh applied after closing',
     await page.$$eval('.card-name', (els) => els.some((e) => e.textContent === '__live_probe_b.svg')));
  cleanupProbes();
  await wait(3500);

  console.log('\n== add a project from a git URL, through the UI ==');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-uiclone-'));
  const originDir = path.join(tmp, 'origin.git');
  const authorDir = path.join(tmp, 'author');
  fs.mkdirSync(originDir);
  git(originDir, 'init', '--bare', '-b', 'main');
  git(tmp, 'clone', originDir, 'author');
  git(authorDir, 'config', 'user.email', 'test@example.com');
  git(authorDir, 'config', 'user.name', 'Vault Test');
  fs.mkdirSync(path.join(authorDir, 'brand'));
  fs.writeFileSync(path.join(authorDir, 'brand', 'mark.svg'), H.fixture.svg(60, 60, '#b82029', 'mark'));
  fs.writeFileSync(path.join(authorDir, 'brand', 'wordmark.svg'), H.fixture.svg(160, 40, '#141110', 'word'));
  fs.writeFileSync(path.join(authorDir, 'README.md'), '# UI Clone Test\n');
  git(authorDir, 'add', '-A');
  git(authorDir, 'commit', '-m', 'initial');
  git(authorDir, 'push', '-u', 'origin', 'main');

  await page.click('#btn-projects');
  await page.waitForSelector('.modal-back', { timeout: 5000 });
  ok('add-project dialog opens with three modes', (await page.$$('.tab[data-mode]')).length === 3);
  await page.click('.tab[data-mode="git"]');
  await wait(400);
  ok('git mode shows a URL field', !!(await page.$('#ap-url')));
  await page.type('#ap-url', originDir.replace(/\\/g, '/'));
  await page.click('#ap-check');
  await page.waitForFunction(() => {
    const el = document.querySelector('#ap-probe');
    return el && /Mil gaya|nahi|fail/i.test(el.textContent);
  }, { timeout: 20000 });
  ok('probe reports the repo was found',
     /Mil gaya/.test(await page.$eval('#ap-probe', (el) => el.textContent)),
     await page.$eval('#ap-probe', (el) => el.textContent));
  ok('branch dropdown filled',
     (await page.$eval('#ap-branch', (el) => el.value)) === 'main',
     await page.$eval('#ap-branch', (el) => el.value));
  await page.type('#ap-name', 'UI Cloned Brand');
  await page.screenshot({ path: path.join(OUT, 'shot-add-git.png') });

  await page.click('#ap-go');
  await page.waitForFunction(() => !document.querySelector('#ap-go'), { timeout: 60000 })
    .catch(() => {});
  await wait(2500);
  ok('clone dialog closed on success', (await page.$$('.modal-back')).length === 0);

  const cat = (await client.call('/api/catalog')).body;
  const cloned = cat.projects.find((p) => p.name === 'UI Cloned Brand');
  ok('cloned project registered', !!cloned, cat.projects.map((p) => p.name));
  clonedId = cloned && cloned.id;
  ok('cloned files indexed', cloned && cloned.files.some((f) => f.n === 'mark.svg'),
     cloned && cloned.files.map((f) => f.n));
  ok('marked as a clone', cloned && cloned.cloned === true);
  ok('UI switched to the new project',
     (await page.$eval('.proj.on .proj-name', (el) => el.textContent)) === 'UI Cloned Brand',
     await page.$eval('.proj.on .proj-name', (el) => el.textContent));

  console.log('\n== git strip on the cloned project ==');
  await wait(1500);
  ok('git strip is shown', await page.$eval('#git-strip', (el) => !el.classList.contains('hidden')));
  const strip = await page.$eval('#git-strip', (el) => el.textContent.replace(/\s+/g, ' ').trim());
  console.log('  strip: ' + strip.slice(0, 120));
  ok('branch shown', /main/.test(strip), strip.slice(0, 80));
  ok('last commit shown', /initial/.test(strip), strip.slice(0, 120));
  ok('pull control present', !!(await page.$('#git-pull')));
  ok('auto toggle on', await page.$eval('#git-auto', (el) => el.checked));
  await page.screenshot({ path: path.join(OUT, 'shot-git-strip.png') });

  console.log('\n== a push shows up in the browser ==');
  await page.evaluate(() => { window.__toasts = []; });
  fs.writeFileSync(path.join(authorDir, 'brand', 'icon.svg'), H.fixture.svg(40, 40, '#fcd404', 'icon'));
  git(authorDir, 'add', '-A');
  git(authorDir, 'commit', '-m', 'add icon');
  git(authorDir, 'push');
  await page.click('#git-pull');
  await wait(6000);
  const toasts = await page.evaluate(() => window.__toasts);
  ok('a toast reported the pull', toasts.some((t) => /GitHub|update/i.test(t)), toasts);
  const afterPull = (await client.call('/api/catalog')).body.projects.find((p) => p.id === clonedId);
  ok('pulled file is in the catalog', afterPull.files.some((f) => f.n === 'icon.svg'),
     afterPull.files.map((f) => f.n));
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-folder]')].find((e) => e.dataset.folder === 'brand');
    if (el) el.click();
  });
  await wait(2500);
  ok('pulled file is visible without a reload',
     await page.$$eval('.card-name', (els) => els.some((e) => e.textContent === 'icon.svg')),
     await page.$$eval('.card-name', (els) => els.map((e) => e.textContent)));

  ok('no JS errors', errors.length === 0, errors.slice(0, 4));
  ok('no failing requests', bad.length === 0, bad.slice(0, 6));
  await browser.close();

  console.log('\n== cleanup ==');
  if (clonedId) await client.call('/api/projects/' + clonedId + '?files=1', { method: 'DELETE' });
  await H.removeFixture(client, PID);
  ok('test projects removed',
     !(await client.call('/api/catalog')).body.projects.some((p) => p.id === clonedId || p.id === PID));

  finish('live-update checks');
})()
  .catch(async (e) => {
    cleanupProbes();
    console.error('CRASH', e);
    try {
      if (clonedId) await client.call('/api/projects/' + clonedId + '?files=1', { method: 'DELETE' });
      await H.removeFixture(client, PID);
    } catch { /* best effort */ }
    process.exit(1);
  })
  .finally(() => { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* lock */ } } });
