'use strict';
/* Full browser pass over the fixture project: grid, search, list, preview,
 * pdf render, selection, zip, sharing, theme, mobile. */
const puppeteer = require('puppeteer-core');
const path = require('path');
const H = require('./helpers');

const BASE = H.BASE;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.env.SHOT_DIR || require('os').tmpdir();
const IMG_DIR = 'logos';

const client = H.makeClient();
const { ok, finish } = H.reporter();
const wait = H.wait;

const errors = [];
const badResponses = [];
let PID = null;

/** Walk into a folder the way a person does: click the cards. */
async function goInto(page, dir) {
  await page.evaluate(() => {
    const c = document.querySelector('#clearq');
    if (c && !c.classList.contains('hidden')) c.click();
    document.querySelectorAll('.crumb')[0].click();
  });
  await wait(700);
  let acc = '';
  for (const part of dir.split('/')) {
    acc = acc ? acc + '/' + part : part;
    const found = await page.evaluate((t) => {
      const el = [...document.querySelectorAll('[data-folder]')].find((e) => e.dataset.folder === t);
      if (el) { el.click(); return true; }
      return false;
    }, acc);
    if (!found) return false;
    await wait(800);
  }
  return true;
}

(async () => {
  await H.login(client);
  const fx = await H.ensureFixture(client);
  PID = fx.id;

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  let expectAuthFail = true;
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (expectAuthFail && /401/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().startsWith(BASE)) {
      if (expectAuthFail && r.status() === 401) return;
      badResponses.push(r.status() + ' ' + decodeURIComponent(r.url()).replace(BASE, ''));
    }
  });

  console.log('\n== lock screen ==');
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  ok('lock screen visible', await page.$eval('#lock', (el) => !el.classList.contains('hidden')));
  await page.screenshot({ path: path.join(OUT, 'shot-01-lock.png') });
  await page.type('#lock-pass', 'definitely-not-it');
  await page.click('#lock-go');
  await wait(600);
  ok('wrong passcode shows an error', (await page.$eval('#lock-msg', (el) => el.textContent)).length > 0);

  console.log('\n== login ==');
  expectAuthFail = false;
  await page.$eval('#lock-pass', (el) => { el.value = ''; });
  await page.type('#lock-pass', H.PASSCODE);
  await page.click('#lock-go');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
  await page.waitForSelector('.proj', { timeout: 15000 });

  // Select the fixture project explicitly; other projects may be registered.
  await page.evaluate((id) => {
    const el = [...document.querySelectorAll('[data-proj]')].find((e) => e.dataset.proj === id);
    if (el) el.click();
  }, PID);
  await wait(2500);
  ok('fixture project selected',
     (await page.$eval('.proj.on .proj-name', (el) => el.textContent)) === 'Vault Test Fixture',
     await page.$eval('.proj.on .proj-name', (el) => el.textContent));

  const rootCards = await page.$$eval('.grid .card', (els) => els.length);
  ok('root lists folders, not the whole tree', rootCards > 3 && rootCards < 20, rootCards);
  ok('type filter chips built', (await page.$$('.chip')).length > 3);

  console.log('\n== folder navigation + thumbnails ==');
  ok('navigated into ' + IMG_DIR, await goInto(page, IMG_DIR));
  await wait(4000);
  const withImg = await page.$$eval('.card-media img', (els) => els.filter((i) => i.naturalWidth > 0).length);
  ok('thumbnails loaded', withImg > 4, withImg);
  ok('breadcrumb reflects depth', (await page.$$('.crumb')).length >= 2);
  await page.screenshot({ path: path.join(OUT, 'shot-02-grid.png') });

  console.log('\n== search ==');
  await page.click('#q');
  await page.type('#q', 'red wala logo');
  await wait(3000);
  ok('search returns results', (await page.$$('.grid .card')).length > 0);
  ok('top hit is the red logo',
     /primary_logo_red/.test(await page.$eval('.card-name', (el) => el.textContent)),
     await page.$eval('.card-name', (el) => el.textContent));
  ok('count line names the scope', /match/.test(await page.$eval('#count', (el) => el.textContent)));
  ok('results show their folder', (await page.$$('.card-meta .row-sub')).length > 0);
  await page.screenshot({ path: path.join(OUT, 'shot-03-search.png') });

  await page.$eval('#q', (el) => { el.value = ''; });
  await page.type('#q', 'zzzzqqqxyz');
  await wait(900);
  ok('empty state for a nonsense query', (await page.$$('.empty')).length === 1);
  await page.click('#clearq');
  await wait(800);

  console.log('\n== list view ==');
  await goInto(page, IMG_DIR);
  await page.click('#v-list');
  await wait(4000);
  ok('list rendered rows', (await page.$$('.list .row')).length > 5);
  ok('list thumbnails loaded',
     (await page.$$eval('.row-thumb img', (e) => e.filter((i) => i.naturalWidth > 0).length)) > 4);
  await page.screenshot({ path: path.join(OUT, 'shot-04-list.png') });

  console.log('\n== preview ==');
  const opened = await page.$$eval('.list .row[data-file]', (els) => {
    const t = els.find((e) => /\.png$/i.test(e.dataset.file));
    if (t) { t.click(); return t.dataset.file; }
    return null;
  });
  ok('found an image row', !!opened, opened);
  await page.waitForSelector('#viewer:not(.hidden)', { timeout: 8000 });
  await wait(2200);
  ok('viewer image rendered', await page.$eval('#v-body img', (el) => el.naturalWidth > 0).catch(() => false));
  ok('dimensions filled in', /\d+ x \d+ px/.test(await page.$eval('.v-side', (el) => el.textContent)));
  ok('background swatches present', (await page.$$('.sw')).length === 5);
  await page.screenshot({ path: path.join(OUT, 'shot-05-viewer.png') });
  const before = (await page.$eval('.v-side', (el) => el.textContent)).match(/(\d+) of (\d+)/);
  await page.keyboard.press('ArrowRight');
  await wait(1500);
  const after = (await page.$eval('.v-side', (el) => el.textContent)).match(/(\d+) of (\d+)/);
  ok('arrow key advances', !!(before && after && +after[1] === +before[1] + 1),
     { before: before && before[0], after: after && after[0] });
  await page.click('.sw[data-bg="white"]');
  await wait(300);
  ok('background swatch switches', (await page.$eval('#v-stage', (el) => el.dataset.bg)) === 'white');
  await page.keyboard.press('Escape');
  await wait(500);
  ok('escape closes the viewer', await page.$eval('#viewer', (el) => el.classList.contains('hidden')));

  console.log('\n== pdf render ==');
  await page.click('#v-grid');
  await wait(500);
  await goInto(page, 'stationery');
  await wait(2500);
  const openedPdf = await page.$$eval('.card[data-file]', (els) => {
    const t = els.find((e) => /\.pdf$/i.test(e.dataset.file));
    if (t) { t.click(); return t.dataset.file; }
    return null;
  });
  ok('found a pdf', !!openedPdf, openedPdf);
  await page.waitForSelector('#viewer:not(.hidden)');
  await wait(6000);
  ok('pdf rendered to canvas',
     await page.$eval('#pdfc', (el) => el.width > 50 && el.height > 50).catch(() => false));
  await page.screenshot({ path: path.join(OUT, 'shot-06-pdf.png') });
  await page.keyboard.press('Escape');
  await wait(600);
  ok('pdf thumbnails appear in the grid after rendering',
     await page.evaluate(async () => {
       for (let i = 0; i < 40; i++) {
         const n = [...document.querySelectorAll('.card-media img')].filter((im) => im.naturalWidth > 0).length;
         if (n > 0) return true;
         await new Promise((r) => setTimeout(r, 250));
       }
       return false;
     }));

  console.log('\n== selection + zip ==');
  await page.$$eval('.card [data-pick]', (els) => { els[0].click(); els[1].click(); els[2].click(); });
  await wait(500);
  ok('selection bar shows 3', (await page.$eval('#sel-n', (el) => el.textContent)) === '3');
  await page.screenshot({ path: path.join(OUT, 'shot-07-selection.png') });
  const zipStatus = await page.evaluate(async (pid) => {
    const files = [...document.querySelectorAll('.card.sel')].map((e) => e.dataset.file);
    const r = await fetch('/api/zip', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, files, name: 'ui-test' }),
    });
    const blob = await r.blob();
    return r.status + ':' + blob.size + ':' + blob.type;
  }, PID);
  ok('zip returns real bytes', /^200:\d{3,}:application\/zip/.test(zipStatus), zipStatus);
  await page.click('#sel-clear');
  await wait(300);
  ok('clearing hides the bar', await page.$eval('#selbar', (el) => el.classList.contains('hidden')));

  console.log('\n== share ==');
  await page.click('#btn-share');
  await page.waitForSelector('.modal-back', { timeout: 5000 });
  ok('share defaults to the current folder',
     (await page.$eval('#sh-folder', (el) => el.value)) === 'stationery',
     await page.$eval('#sh-folder', (el) => el.value));
  await page.type('#sh-label', 'UI test link');
  await page.type('#sh-pass', 'test123');
  await page.screenshot({ path: path.join(OUT, 'shot-08-share.png') });
  await page.click('#sh-go');
  await page.waitForSelector('#sh-url', { timeout: 8000 });
  const shareUrl = await page.$eval('#sh-url', (el) => el.value);
  ok('share link produced', /\/s\/[A-Za-z0-9_-]+$/.test(shareUrl), shareUrl);
  await page.keyboard.press('Escape');
  await wait(500);
  ok('modal closes on Escape', (await page.$$('.modal-back')).length === 0);

  console.log('\n== visitor ==');
  const guest = await browser.createBrowserContext();
  const gp = await guest.newPage();
  const gErrors = [];
  gp.on('pageerror', (e) => gErrors.push(e.message));
  gp.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) gErrors.push(m.text()); });
  await gp.setViewport({ width: 1440, height: 900 });
  await gp.goto(shareUrl, { waitUntil: 'networkidle2' });
  ok('visitor gets the passcode gate', await gp.$eval('#lock', (el) => !el.classList.contains('hidden')));
  ok('gate names the link', (await gp.$eval('#lock-title', (el) => el.textContent)) === 'UI test link');
  await gp.screenshot({ path: path.join(OUT, 'shot-10-visitor-lock.png') });
  await gp.type('#lock-pass', 'wrong');
  await gp.click('#lock-go');
  await wait(800);
  ok('wrong share passcode refused', await gp.$eval('#app', (el) => el.classList.contains('hidden')));
  await gp.$eval('#lock-pass', (el) => { el.value = ''; });
  await gp.type('#lock-pass', 'test123');
  await gp.click('#lock-go');
  await gp.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
  await wait(4000);
  ok('visitor sees files', (await gp.$$('.grid .card')).length > 0);
  ok('owner-only controls hidden',
     await gp.$$eval('.owner-only', (els) => els.every((e) => e.classList.contains('hidden'))));
  ok('git strip hidden from visitors',
     await gp.$eval('#git-strip', (el) => el.classList.contains('hidden')));
  ok('visitor scoped to the shared folder',
     (await gp.$eval('.crumbs', (el) => el.textContent)).includes('stationery'),
     await gp.$eval('.crumbs', (el) => el.textContent));
  await gp.screenshot({ path: path.join(OUT, 'shot-11-visitor.png') });
  ok('no JS errors in the visitor view', gErrors.length === 0, gErrors.slice(0, 4));
  await guest.close();

  console.log('\n== theme + mobile ==');
  await page.click('#btn-theme');
  await wait(700);
  ok('theme flips to light', (await page.$eval('html', (el) => el.dataset.theme)) === 'light');
  await page.screenshot({ path: path.join(OUT, 'shot-12-light.png') });
  await page.click('#btn-theme');
  await wait(500);
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  await wait(2000);
  await page.screenshot({ path: path.join(OUT, 'shot-13-mobile.png') });
  ok('no horizontal overflow on mobile',
     (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 2);

  console.log('\n== clean run ==');
  ok('no JS errors', errors.length === 0, errors.slice(0, 5));
  ok('no failing requests', badResponses.length === 0, badResponses.slice(0, 6));

  await browser.close();
  await H.removeFixture(client, PID);
  finish('UI checks');
})().catch(async (e) => {
  console.error('CRASH', e);
  try { await H.removeFixture(client, PID); } catch { /* best effort */ }
  process.exit(1);
});
