'use strict';
/* Browser uploads into a vault-managed project: nesting, path safety,
 * folder creation, deletion, and removing the project with its files. */
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const client = H.makeClient();
const { call } = client;
const { ok, finish } = H.reporter();

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const PROJECT_NAME = 'Upload Test';
const PROJECT_ID = 'upload-test';
const VAULT_ROOT = path.join(__dirname, '..');

(async () => {
  await H.login(client);
  await call('/api/projects/' + PROJECT_ID + '?files=1', { method: 'DELETE' });

  console.log('\n== managed project ==');
  const mk = await call('/api/projects', { method: 'POST', body: { name: PROJECT_NAME } });
  ok('empty project created', mk.status === 200 && mk.body.id === PROJECT_ID, mk.body);
  const storage = path.join(VAULT_ROOT, 'storage', PROJECT_ID);
  ok('lives in vault storage', fs.existsSync(storage), storage);

  console.log('\n== upload ==');
  const fd = new FormData();
  const png = H.fixture.png(8, 8, [235, 33, 39]);
  fd.append(b64('brand/logo.png'), new Blob([png], { type: 'image/png' }), 'logo.png');
  fd.append(b64('brand/nested/notes.md'), new Blob(['# hello'], { type: 'text/markdown' }), 'notes.md');
  fd.append(b64('top.txt'), new Blob(['plain'], { type: 'text/plain' }), 'top.txt');
  fd.append(b64('../../escaped.txt'), new Blob(['nope'], { type: 'text/plain' }), 'escaped.txt');
  fd.append(b64('..\\..\\escaped2.txt'), new Blob(['nope'], { type: 'text/plain' }), 'escaped2.txt');

  const up = await call('/api/upload?p=' + PROJECT_ID + '&folder=', { method: 'POST', body: fd });
  ok('upload accepted', up.status === 200, up.body);

  const proj = (await call('/api/catalog')).body.projects.find((p) => p.id === PROJECT_ID);
  const paths = proj.files.map((f) => f.p).sort();
  console.log('  stored: ' + JSON.stringify(paths));
  ok('nested structure preserved',
     paths.includes('brand/logo.png') && paths.includes('brand/nested/notes.md'), paths);
  ok('root file stored', paths.includes('top.txt'));
  ok('no traversal in the stored paths', !paths.some((p) => p.includes('..')));
  for (const escape of ['escaped.txt', 'escaped2.txt']) {
    ok('nothing escaped to the vault root: ' + escape, !fs.existsSync(path.join(VAULT_ROOT, escape)));
    ok('nothing escaped to storage root: ' + escape, !fs.existsSync(path.join(VAULT_ROOT, 'storage', escape)));
  }

  const thumb = await call('/api/thumb?p=' + PROJECT_ID + '&f=' + encodeURIComponent('brand/logo.png'));
  ok('uploaded image gets a thumbnail', thumb.status === 200, thumb.status);
  const read = await call('/api/file?p=' + PROJECT_ID + '&f=' + encodeURIComponent('brand/nested/notes.md'));
  ok('uploaded file can be read back', read.status === 200, read.status);

  console.log('\n== upload into a subfolder ==');
  const fd2 = new FormData();
  fd2.append(b64('extra.txt'), new Blob(['x'], { type: 'text/plain' }), 'extra.txt');
  const up2 = await call('/api/upload?p=' + PROJECT_ID + '&folder=' + encodeURIComponent('brand'), {
    method: 'POST', body: fd2,
  });
  ok('upload into a subfolder works', up2.status === 200, up2.body);
  ok('landed in the right place',
     (await call('/api/catalog')).body.projects.find((p) => p.id === PROJECT_ID)
       .files.some((f) => f.p === 'brand/extra.txt'));

  console.log('\n== folders and deletion ==');
  const mkdir = await call('/api/folder', {
    method: 'POST', body: { projectId: PROJECT_ID, parent: 'brand', name: 'exports' },
  });
  ok('create folder works', mkdir.status === 200, mkdir.body);
  ok('folder shows in the tree',
     (await call('/api/catalog')).body.projects.find((p) => p.id === PROJECT_ID)
       .folders.includes('brand/exports'));
  ok('folder name is required',
     (await call('/api/folder', { method: 'POST', body: { projectId: PROJECT_ID, name: '  ' } })).status === 400);

  ok('delete file works',
     (await call('/api/file?p=' + PROJECT_ID + '&f=' + encodeURIComponent('top.txt'), { method: 'DELETE' })).status === 200);
  ok('deleted file left the index',
     !(await call('/api/catalog')).body.projects.find((p) => p.id === PROJECT_ID)
       .files.some((f) => f.p === 'top.txt'));
  ok('deleting the project root is refused',
     (await call('/api/file?p=' + PROJECT_ID + '&f=', { method: 'DELETE' })).status === 404);

  console.log('\n== removal ==');
  const rm = await call('/api/projects/' + PROJECT_ID + '?files=1', { method: 'DELETE' });
  ok('project removed with its files', rm.status === 200 && rm.body.filesDeleted === true, rm.body);
  ok('storage folder gone', !fs.existsSync(storage));

  finish('upload checks');
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
