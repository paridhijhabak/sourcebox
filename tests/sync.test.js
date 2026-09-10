'use strict';
/* Live updating: the folder watcher, and git pulls from a remote.
 * The git half uses throwaway local repos, so no network and no credentials. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./helpers');

const client = H.makeClient();
const { call } = client;
const { ok, finish } = H.reporter();
const wait = H.wait;

const GIT_ENV = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' });
const git = (cwd, ...a) =>
  execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tmp = null;
let fixtureId = null;
let gitId = null;

(async () => {
  await H.login(client);

  console.log('\n== watcher: a file appearing on disk ==');
  const fx = await H.ensureFixture(client);
  fixtureId = fx.id;
  await wait(1200);

  const events = [];
  let stop = H.listen(client, (ev, data) => events.push({ ev, data }));
  await wait(600);

  const probeFile = path.join(fx.root, 'logos', '__watch_probe.svg');
  fs.writeFileSync(probeFile, H.fixture.svg(40, 40, '#eb2127', 'probe'));
  await wait(4000);

  ok('new file pushed an index event', events.some((e) => e.ev === 'index'), events.map((e) => e.ev));
  ok('event says the change came from disk',
     events.some((e) => e.ev === 'index' && e.data.reason === 'disk'),
     events.filter((e) => e.ev === 'index').map((e) => e.data.reason));
  let cat = await call('/api/catalog');
  ok('file is in the catalog with no manual rescan',
     cat.body.projects.find((p) => p.id === fixtureId).files.some((f) => f.n === '__watch_probe.svg'));

  events.length = 0;
  fs.unlinkSync(probeFile);
  await wait(4000);
  ok('deletion also pushed an event', events.some((e) => e.ev === 'index'));
  cat = await call('/api/catalog');
  ok('file left the catalog',
     !cat.body.projects.find((p) => p.id === fixtureId).files.some((f) => f.n === '__watch_probe.svg'));
  stop();

  console.log('\n== git: a commit arriving from a remote ==');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-sync-'));
  const originDir = path.join(tmp, 'origin.git');
  const authorDir = path.join(tmp, 'author');
  const cloneDir = path.join(tmp, 'clone');

  fs.mkdirSync(originDir);
  git(originDir, 'init', '--bare', '-b', 'main');
  git(tmp, 'clone', originDir, 'author');
  git(authorDir, 'config', 'user.email', 'test@example.com');
  git(authorDir, 'config', 'user.name', 'Vault Test');
  fs.mkdirSync(path.join(authorDir, 'logos'));
  fs.writeFileSync(path.join(authorDir, 'logos', 'first.svg'), H.fixture.svg(20, 20, '#111', 'a'));
  git(authorDir, 'add', '-A');
  git(authorDir, 'commit', '-m', 'first drop');
  git(authorDir, 'push', '-u', 'origin', 'main');
  git(tmp, 'clone', originDir, 'clone');

  const add = await call('/api/projects', { method: 'POST', body: { name: 'Git Sync Test', root: cloneDir } });
  ok('git project registered', add.status === 200 && add.body.isRepo === true, add.body);
  gitId = add.body.id;

  const gitEvents = [];
  stop = H.listen(client, (ev, data) => gitEvents.push({ ev, data }));
  await wait(600);

  fs.writeFileSync(path.join(authorDir, 'logos', 'second.svg'), H.fixture.svg(20, 20, '#eb2127', 'b'));
  fs.writeFileSync(path.join(authorDir, 'notes.md'), '# from the remote\n');
  git(authorDir, 'add', '-A');
  git(authorDir, 'commit', '-m', 'add second logo and notes');
  git(authorDir, 'push');

  const synced = await call('/api/git/sync/' + gitId, { method: 'POST', body: {} });
  ok('sync reports a change', synced.status === 200 && synced.body.changed === true, synced.body);
  await wait(2500);

  const pulled = gitEvents.filter((e) => e.ev === 'git' && e.data.kind === 'pulled');
  ok('pull pushed a git event', pulled.length > 0,
     gitEvents.map((e) => e.ev + ':' + (e.data.kind || '')));
  ok('event names the commit', pulled[0] && /second logo/.test(pulled[0].data.subject || ''),
     pulled[0] && pulled[0].data.subject);
  ok('pull pushed an index event', gitEvents.some((e) => e.ev === 'index' && e.data.reason === 'git'));

  cat = await call('/api/catalog');
  const names = cat.body.projects.find((p) => p.id === gitId).files.map((f) => f.n).sort();
  ok('pulled files are in the catalog', names.includes('second.svg') && names.includes('notes.md'), names);
  ok('git state says up to date', cat.body.git[gitId].behind === 0, cat.body.git[gitId]);
  ok('branch and remote detected',
     cat.body.git[gitId].branch === 'main' && !!cat.body.git[gitId].remote, cat.body.git[gitId]);

  console.log('\n== git: safety guards ==');
  fs.writeFileSync(path.join(cloneDir, 'logos', 'second.svg'), '<svg>LOCAL EDIT</svg>');
  fs.writeFileSync(path.join(authorDir, 'third.md'), '# third\n');
  git(authorDir, 'add', '-A');
  git(authorDir, 'commit', '-m', 'third');
  git(authorDir, 'push');

  const blocked = await call('/api/git/sync/' + gitId, { method: 'POST', body: {} });
  ok('dirty tree blocks the pull', blocked.status === 409 && blocked.body.skipped === true, blocked.body);
  ok('block message explains why', /local change/i.test((blocked.body && blocked.body.err) || ''),
     blocked.body && blocked.body.err);
  ok('local edit survived byte for byte',
     fs.readFileSync(path.join(cloneDir, 'logos', 'second.svg'), 'utf8') === '<svg>LOCAL EDIT</svg>');
  ok('third file was not pulled in', !fs.existsSync(path.join(cloneDir, 'third.md')));

  git(cloneDir, 'checkout', '--', '.');
  const unblocked = await call('/api/git/sync/' + gitId, { method: 'POST', body: {} });
  ok('clean tree pulls fine', unblocked.status === 200 && unblocked.body.changed === true, unblocked.body);
  ok('third file arrived', fs.existsSync(path.join(cloneDir, 'third.md')));

  console.log('\n== git: diverged branch is left alone ==');
  git(cloneDir, 'config', 'user.email', 'local@example.com');
  git(cloneDir, 'config', 'user.name', 'Local');
  fs.writeFileSync(path.join(cloneDir, 'local-only.md'), '# local\n');
  git(cloneDir, 'add', '-A');
  git(cloneDir, 'commit', '-m', 'local commit');
  fs.writeFileSync(path.join(authorDir, 'remote-only.md'), '# remote\n');
  git(authorDir, 'add', '-A');
  git(authorDir, 'commit', '-m', 'remote commit');
  git(authorDir, 'push');

  const diverged = await call('/api/git/sync/' + gitId, { method: 'POST', body: {} });
  ok('diverged branch is refused', diverged.status === 409 && diverged.body.skipped === true, diverged.body);
  ok('message mentions diverge', /diverge/i.test((diverged.body && diverged.body.err) || ''),
     diverged.body && diverged.body.err);
  ok('local commit still there', fs.existsSync(path.join(cloneDir, 'local-only.md')));
  ok('remote commit not merged in', !fs.existsSync(path.join(cloneDir, 'remote-only.md')));
  git(cloneDir, 'reset', '--hard', 'HEAD~1');

  console.log('\n== settings ==');
  const off = await call('/api/git/settings/' + gitId, { method: 'POST', body: { autoPull: false } });
  ok('auto pull can be turned off', off.status === 200 && off.body.git.autoPull === false, off.body);
  cat = await call('/api/catalog');
  ok('setting persists', cat.body.git[gitId].settings.autoPull === false, cat.body.git[gitId].settings);

  await call('/api/git/refresh/' + gitId + '?fetch=1', { method: 'POST', body: {} });
  cat = await call('/api/catalog');
  ok('behind count reported while auto pull is off', cat.body.git[gitId].behind >= 1, cat.body.git[gitId].behind);
  ok('nothing was pulled', !fs.existsSync(path.join(cloneDir, 'remote-only.md')));
  stop();

  console.log('\n== non-git project has no git state ==');
  ok('fixture is not reported as a repo',
     !cat.body.git[fixtureId] || cat.body.git[fixtureId].isRepo === false,
     cat.body.git[fixtureId]);
  ok('syncing a non-repo is refused',
     (await call('/api/git/sync/' + fixtureId, { method: 'POST', body: {} })).status === 409);

  console.log('\n== cleanup ==');
  await call('/api/projects/' + gitId, { method: 'DELETE' });
  await H.removeFixture(client, fixtureId);
  cat = await call('/api/catalog');
  ok('test projects removed',
     !cat.body.projects.some((p) => p.id === gitId || p.id === fixtureId));

  finish('sync checks');
})()
  .catch((e) => { console.error('CRASH', e); process.exit(1); })
  .finally(() => { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* lock */ } } });
