'use strict';
/* Core API: auth, indexing, file serving, path safety, zip, share links. */
const H = require('./helpers');

const client = H.makeClient();
const { call } = client;
const { ok, finish } = H.reporter();

let PID = null;

(async () => {
  console.log('\n== auth ==');
  ok('wrong passcode rejected',
     (await call('/api/login', { method: 'POST', body: { passcode: 'definitely-not-it' } })).status === 401);
  ok('catalog locked before login', (await call('/api/catalog')).status === 401);
  await H.login(client);
  ok('login works', (await call('/api/session')).body.owner === true);

  console.log('\n== indexing ==');
  const fx = await H.ensureFixture(client);
  PID = fx.id;
  const scan = await call('/api/rescan', { method: 'POST', body: { ids: [PID] } });
  ok('rescan ok', scan.status === 200, scan.body);

  const cat = await call('/api/catalog');
  const proj = cat.body.projects.find((p) => p.id === PID);
  ok('project in catalog', !!proj);
  ok('all fixture files indexed', proj.files.length === H.fixture.FILES.length,
     { got: proj.files.length, want: H.fixture.FILES.length });
  ok('folders discovered', proj.folders.includes('logos') && proj.folders.includes('social/01_Instagram'),
     proj.folders.slice(0, 8));
  ok('kinds classified', ['image', 'vector', 'pdf', 'design', 'doc'].every((k) => proj.files.some((f) => f.k === k)),
     [...new Set(proj.files.map((f) => f.k))]);
  ok('sibling preview mapped onto its source',
     proj.files.some((f) => f.n === 'IG_reel_cover.svg') &&
     proj.files.some((f) => f.p.includes('previews/')));
  console.log('  ' + proj.files.length + ' files, ' + proj.folders.length + ' folders, ' +
              (JSON.stringify(cat.body).length / 1024).toFixed(0) + ' KB catalog');

  console.log('\n== junk exclusion ==');
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.join(fx.root, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(fx.root, 'node_modules', 'junk', 'index.js'), 'module.exports=1');
  fs.writeFileSync(path.join(fx.root, 'Thumbs.db'), 'x');
  fs.writeFileSync(path.join(fx.root, 'installer.exe'), 'MZ');
  await call('/api/rescan', { method: 'POST', body: { ids: [PID] } });
  const after = (await call('/api/catalog')).body.projects.find((p) => p.id === PID);
  ok('node_modules excluded', !after.files.some((f) => f.p.includes('node_modules')));
  ok('Thumbs.db excluded', !after.files.some((f) => f.n === 'Thumbs.db'));
  ok('exe excluded', !after.files.some((f) => f.e === 'exe'));

  console.log('\n== thumbnails ==');
  const png = after.files.find((f) => f.k === 'image');
  let r = await call('/api/thumb?p=' + PID + '&f=' + encodeURIComponent(png.p));
  ok('png thumb generated', r.status === 200 && (r.res.headers.get('content-type') || '').includes('image'),
     { s: r.status, f: png.p });
  const svg = after.files.find((f) => f.k === 'vector');
  r = await call('/api/thumb?p=' + PID + '&f=' + encodeURIComponent(svg.p));
  ok('svg rasterised', r.status === 200, { s: r.status, f: svg.p });
  const pdf = after.files.find((f) => f.k === 'pdf' && !f.th);
  r = await call('/api/thumb?p=' + PID + '&f=' + encodeURIComponent(pdf.p));
  const cold = r.status === 204 && !!r.res.headers.get('x-thumb-key');
  const warm = r.status === 200 && (r.res.headers.get('content-type') || '').includes('image');
  ok('pdf defers to the browser, or serves a cached render', cold || warm, { s: r.status });

  const batch = after.files.filter((f) => f.k === 'image').slice(0, 12);
  let t = Date.now();
  await Promise.all(batch.map((f) => call('/api/thumb?p=' + PID + '&f=' + encodeURIComponent(f.p))));
  const coldMs = Date.now() - t;
  t = Date.now();
  await Promise.all(batch.map((f) => call('/api/thumb?p=' + PID + '&f=' + encodeURIComponent(f.p))));
  console.log('  ' + batch.length + ' thumbs: ' + coldMs + 'ms cold, ' + (Date.now() - t) + 'ms cached');

  console.log('\n== path traversal ==');
  for (const evil of ['../../../Windows/win.ini', '..\\..\\..\\Windows\\win.ini', '/etc/passwd',
                      'a/../../../../secret.txt', './../package.json']) {
    const g = await call('/api/file?p=' + PID + '&f=' + encodeURIComponent(evil));
    ok('blocked: ' + evil, g.status === 404, { s: g.status });
  }

  console.log('\n== file serving ==');
  const plain = await call('/api/file?p=' + PID + '&f=' + encodeURIComponent(png.p));
  ok('owner can read a file', plain.status === 200, plain.status);
  const dl = await call('/api/file?p=' + PID + '&f=' + encodeURIComponent(png.p) + '&dl=1');
  ok('download returns 200 with an attachment header',
     dl.status === 200 && (dl.res.headers.get('content-disposition') || '').startsWith('attachment'),
     { s: dl.status, cd: dl.res.headers.get('content-disposition') });
  ok('unknown project 404s', (await call('/api/file?p=nope&f=x.png')).status === 404);

  console.log('\n== zip ==');
  const zip = await call('/api/zip', {
    method: 'POST',
    body: { projectId: PID, files: batch.slice(0, 5).map((f) => f.p), name: 'test' },
  });
  ok('zip returns a file', zip.status === 200 && (zip.res.headers.get('content-type') || '').includes('zip'), zip.status);
  ok('empty selection refused',
     (await call('/api/zip', { method: 'POST', body: { projectId: PID, files: [] } })).status === 400);

  console.log('\n== share links ==');
  const folder = 'stationery';
  const share = await call('/api/shares', {
    method: 'POST',
    body: { projectId: PID, folderPath: folder, label: 'Client test', passcode: 'abcd', expiresInDays: 7, allowDownload: false },
  });
  ok('share created', share.status === 200 && !!share.body.token, share.body);
  const token = share.body.token;
  ok('hash never leaves the server', !JSON.stringify((await call('/api/shares')).body).includes('passcodeHash'));

  const ownerCookie = client.cookie;
  client.cookie = '';   // become an anonymous visitor
  const meta = await call('/api/share/' + token);
  ok('visitor sees label and that a passcode is needed',
     meta.body.hasPasscode === true && meta.body.label === 'Client test', meta.body);
  ok('visitor catalog locked', (await call('/api/catalog?share=' + token)).status === 401);
  ok('wrong share passcode rejected',
     (await call('/api/share/' + token + '/unlock', { method: 'POST', body: { passcode: 'zzzz' } })).status === 401);
  ok('share unlock works',
     (await call('/api/share/' + token + '/unlock', { method: 'POST', body: { passcode: 'abcd' } })).status === 200);

  const scat = await call('/api/catalog?share=' + token);
  ok('scoped catalog holds only the shared folder',
     scat.status === 200 && scat.body.projects[0].files.every((f) => f.p.startsWith(folder + '/')),
     { n: scat.body.projects && scat.body.projects[0].files.length });
  console.log('  visitor sees ' + scat.body.projects[0].files.length + ' of ' + after.files.length + ' files');

  const outside = after.files.find((f) => !f.p.startsWith(folder + '/'));
  ok('file outside the share refused',
     (await call('/api/file?share=' + token + '&p=' + PID + '&f=' + encodeURIComponent(outside.p))).status === 403);
  const inside = scat.body.projects[0].files[0];
  ok('file inside the share served',
     (await call('/api/file?share=' + token + '&p=' + PID + '&f=' + encodeURIComponent(inside.p))).status === 200);
  ok('download blocked when the link says no download',
     (await call('/api/file?share=' + token + '&p=' + PID + '&f=' + encodeURIComponent(inside.p) + '&dl=1')).status === 403);
  ok('zip blocked too',
     (await call('/api/zip', { method: 'POST', body: { share: token, projectId: PID, files: [inside.p] } })).status === 403);
  ok('visitor cannot rescan', (await call('/api/rescan', { method: 'POST', body: {} })).status === 401);
  ok('visitor cannot list shares', (await call('/api/shares')).status === 401);
  ok('visitor cannot add a project', (await call('/api/projects', { method: 'POST', body: { name: 'evil' } })).status === 401);
  ok('visitor cannot clone', (await call('/api/projects/clone', { method: 'POST', body: { url: 'https://x/y.git' } })).status === 401);
  ok('visitor cannot delete files',
     (await call('/api/file?p=' + PID + '&f=' + encodeURIComponent(inside.p), { method: 'DELETE' })).status === 401);
  ok('visitor cannot read git state', (await call('/api/git')).status === 401);

  client.cookie = ownerCookie;
  await call('/api/shares/' + token, { method: 'DELETE' });
  ok('share revoked', (await call('/api/share/' + token)).status === 404);

  await H.removeFixture(client, PID);
  ok('fixture removed', !(await call('/api/catalog')).body.projects.some((p) => p.id === PID));

  finish('checks');
})().catch(async (e) => {
  console.error('CRASH', e);
  try { await H.removeFixture(client, PID); } catch { /* best effort */ }
  process.exit(1);
});
