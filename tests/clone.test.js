'use strict';
/* Adding a project straight from a git URL: probe, clone with progress,
 * index, watch, auto-pull, and remove. Runs against local bare repos so it
 * needs no network and no credentials.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = process.env.VAULT_URL || 'http://localhost:4477';
const PASSCODE = process.env.VAULT_PASSCODE || 'primetime';
let cookie = '';

async function call(p, o = {}) {
  const h = Object.assign({}, o.headers);
  if (cookie) h.Cookie = cookie;
  if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, Object.assign({}, o, { headers: h }));
  for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) cookie = c.split(';')[0];
  const t = r.headers.get('content-type') || '';
  return { status: r.status, body: t.includes('json') ? await r.json() : null };
}

let pass = 0, fail = 0;
const ok = (l, c, e) => { c ? (pass++, console.log('  PASS  ' + l))
  : (fail++, console.log('  FAIL  ' + l + (e !== undefined ? '  -> ' + JSON.stringify(e).slice(0, 300) : ''))); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const GIT_ENV = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function listen(onEvent) {
  const controller = new AbortController();
  (async () => {
    const res = await fetch(BASE + '/api/events', { headers: { Cookie: cookie }, signal: controller.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop();
      for (const f of frames) {
        const ev = (f.match(/^event: (.+)$/m) || [])[1];
        const data = (f.match(/^data: (.+)$/m) || [])[1];
        if (ev && data) onEvent(ev, JSON.parse(data));
      }
    }
  })().catch(() => {});
  return () => controller.abort();
}

let tmp;
(async () => {
  await call('/api/login', { method: 'POST', body: { passcode: PASSCODE } });

  console.log('\n== url validation ==');
  for (const bad of ['--upload-pack=calc.exe', 'not a url', '', 'ftp://x/y']) {
    const r = await call('/api/projects/clone', { method: 'POST', body: { url: bad } });
    ok('rejected: ' + JSON.stringify(bad), r.status === 400, { s: r.status, b: r.body });
  }
  const noAuth = await fetch(BASE + '/api/projects/clone', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://x/y.git' }),
  });
  ok('clone needs the owner passcode', noAuth.status === 401, noAuth.status);

  // Build a source repo to clone from.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-clone-'));
  const originDir = path.join(tmp, 'origin.git');
  const authorDir = path.join(tmp, 'author');
  fs.mkdirSync(originDir);
  git(originDir, 'init', '--bare', '-b', 'main');
  git(tmp, 'clone', originDir, 'author');
  git(authorDir, 'config', 'user.email', 'test@example.com');
  git(authorDir, 'config', 'user.name', 'Vault Test');
  fs.mkdirSync(path.join(authorDir, 'logos'), { recursive: true });
  fs.writeFileSync(path.join(authorDir, 'logos', 'mark.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#eb2127"/></svg>');
  fs.writeFileSync(path.join(authorDir, 'README.md'), '# Clone Me\n');
  git(authorDir, 'add', '-A');
  git(authorDir, 'commit', '-m', 'initial assets');
  git(authorDir, 'push', '-u', 'origin', 'main');
  git(authorDir, 'branch', 'design-wip');
  git(authorDir, 'push', 'origin', 'design-wip');

  console.log('\n== probe ==');
  const probe = await call('/api/git/probe', { method: 'POST', body: { url: originDir } });
  ok('probe reaches the repo', probe.status === 200, probe.body);
  ok('probe lists both branches',
     probe.body.branches.includes('main') && probe.body.branches.includes('design-wip'), probe.body.branches);
  ok('probe picks main as default', probe.body.defaultBranch === 'main', probe.body.defaultBranch);
  ok('probe suggests a name', typeof probe.body.suggestedName === 'string' && probe.body.suggestedName.length > 0,
     probe.body.suggestedName);
  const badProbe = await call('/api/git/probe', { method: 'POST', body: { url: path.join(tmp, 'nope.git') } });
  ok('probe fails fast on a bad repo', badProbe.status === 400, badProbe.body);

  console.log('\n== clone with progress ==');
  const events = [];
  const stop = listen((ev, data) => events.push({ ev, data }));
  await wait(500);

  const started = await call('/api/projects/clone', {
    method: 'POST', body: { name: 'Clone Test', url: originDir, branch: 'main' },
  });
  ok('clone job accepted', started.status === 200 && !!started.body.jobId, started.body);
  const pid = started.body.projectId;

  let job = null;
  for (let i = 0; i < 120; i++) {
    const r = await call('/api/jobs/' + started.body.jobId);
    job = r.body;
    if (job && job.done) break;
    await wait(500);
  }
  ok('clone finished', !!(job && job.done && !job.error), job);
  ok('clone reported a file count', job && job.fileCount >= 2, job && job.fileCount);
  await wait(1200);
  ok('progress events streamed', events.some(e => e.ev === 'clone'), events.map(e => e.ev).slice(0, 8));
  ok('an index event announced the new project',
     events.some(e => e.ev === 'index' && e.data.reason === 'clone' && e.data.projectId === pid));
  stop();

  console.log('\n== the cloned project behaves like any other ==');
  let cat = await call('/api/catalog');
  const proj = cat.body.projects.find(p => p.id === pid);
  ok('project is in the catalog', !!proj);
  ok('marked as cloned', proj && proj.cloned === true, proj && { cloned: proj.cloned, managed: proj.managed });
  ok('lives inside the vault storage', proj && /storage[\\/]repos[\\/]/.test(proj.root), proj && proj.root);
  ok('files indexed', proj && proj.files.some(f => f.n === 'mark.svg'), proj && proj.files.map(f => f.n));
  ok('.git internals excluded', proj && !proj.files.some(f => f.p.startsWith('.git/')));
  ok('git state detected', !!(cat.body.git[pid] && cat.body.git[pid].isRepo));
  ok('on the requested branch', cat.body.git[pid].branch === 'main', cat.body.git[pid].branch);
  ok('auto pull on by default', cat.body.git[pid].settings.autoPull === true);

  const thumb = await call('/api/thumb?p=' + pid + '&f=' + encodeURIComponent('logos/mark.svg'));
  ok('thumbnails work for cloned files', thumb.status === 200, thumb.status);

  console.log('\n== auto update after a push ==');
  fs.writeFileSync(path.join(authorDir, 'logos', 'wordmark.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="20"><rect width="80" height="20" fill="#111"/></svg>');
  git(authorDir, 'add', '-A');
  git(authorDir, 'commit', '-m', 'add wordmark');
  git(authorDir, 'push');

  const synced = await call('/api/git/sync/' + pid, { method: 'POST', body: {} });
  ok('sync pulled the new commit', synced.status === 200 && synced.body.changed === true, synced.body);
  cat = await call('/api/catalog');
  ok('new file appeared in the catalog',
     cat.body.projects.find(p => p.id === pid).files.some(f => f.n === 'wordmark.svg'));

  console.log('\n== share a cloned project ==');
  const share = await call('/api/shares', {
    method: 'POST', body: { projectId: pid, folderPath: 'logos', label: 'Cloned logos', passcode: 'pw12' },
  });
  ok('share link created for a cloned project', share.status === 200 && !!share.body.token, share.body);
  await call('/api/shares/' + share.body.token, { method: 'DELETE' });

  console.log('\n== duplicate + removal ==');
  const dupe = await call('/api/projects', { method: 'POST', body: { name: 'Dupe', root: proj.root } });
  ok('same folder cannot be added twice', dupe.status === 400, dupe.body);

  const clonePath = proj.root;
  const removed = await call('/api/projects/' + pid + '?files=1', { method: 'DELETE' });
  ok('cloned project removed', removed.status === 200 && removed.body.filesDeleted === true, removed.body);
  ok('clone deleted from disk', !fs.existsSync(clonePath), clonePath);
  cat = await call('/api/catalog');
  ok('gone from the catalog', !cat.body.projects.some(p => p.id === pid));

  console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' : 'ALL ') + (pass + fail) + ' clone checks\n');
  process.exit(fail ? 1 : 0);
})()
  .catch(e => { console.error('CRASH', e); process.exit(1); })
  .finally(() => { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows lock */ } } });
