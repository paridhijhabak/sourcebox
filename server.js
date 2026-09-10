'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');

const cfgLib = require('./lib/config');
const { getConfig, saveConfig, setOwnerPasscode, checkOwnerPasscode, STORAGE_DIR, ROOT } = cfgLib;
const indexer = require('./lib/indexer');
const shares = require('./lib/shares');
const thumbs = require('./lib/thumbs');
const auth = require('./lib/auth');
const git = require('./lib/git');
const sync = require('./lib/sync');

const PORT = Number(process.env.PORT) || 4477;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(auth.middleware);

/* ---------------------------------------------------------------- helpers */

function projectById(id) {
  return getConfig().projects.find((p) => p.id === id) || null;
}

/** Resolve a project-relative path, refusing anything that escapes the root. */
function safeResolve(projectRoot, relPath) {
  const cleaned = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.split('/').some((seg) => seg === '..')) return null;
  const abs = path.resolve(projectRoot, cleaned.split('/').join(path.sep));
  const rootResolved = path.resolve(projectRoot);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return null;
  return abs;
}

function withinFolder(relPath, folderPath) {
  if (!folderPath) return true;
  return relPath === folderPath || relPath.startsWith(folderPath + '/');
}

/** The share the caller has unlocked for this request, if any. */
function activeShare(req) {
  const token = req.query.share || (req.body && req.body.share) || req.headers['x-share-token'];
  if (!token) return null;
  if (!req.session.shares.includes(token)) return null;
  const share = shares.get(token);
  if (!share || shares.isExpired(share)) return null;
  return share;
}

/** Grants read access, either as owner or through an unlocked share link. */
function authorize(req, projectId, relPath) {
  if (req.session.owner) return { ok: true, owner: true, share: null };
  const share = activeShare(req);
  if (!share) return { ok: false, status: 401, error: 'Locked' };
  if (share.projectId !== projectId) return { ok: false, status: 403, error: 'Not shared' };
  if (relPath != null && !withinFolder(relPath, share.folderPath)) {
    return { ok: false, status: 403, error: 'Not shared' };
  }
  return { ok: true, owner: false, share };
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'project';
}

function scopedProject(entry, share) {
  if (!share) return entry;
  const files = entry.files.filter((f) => withinFolder(f.p, share.folderPath));
  const folders = entry.folders.filter((d) => withinFolder(d, share.folderPath));
  return { files, folders, bytes: files.reduce((s, f) => s + f.s, 0) };
}

/* ------------------------------------------------------------------ auth */

app.get('/api/session', (req, res) => {
  const cfg = getConfig();
  const unlocked = req.session.shares
    .map((t) => shares.get(t))
    .filter((s) => s && !shares.isExpired(s))
    .map(shares.publicView);
  res.json({
    owner: req.session.owner,
    vaultName: cfg.vaultName,
    passcodeIsDefault: req.session.owner ? cfg.passcodeIsDefault : undefined,
    shares: unlocked,
  });
});

app.post('/api/login', (req, res) => {
  const passcode = req.body && req.body.passcode;
  if (!passcode || !checkOwnerPasscode(passcode)) {
    return res.status(401).json({ error: 'Galat passcode' });
  }
  res.setSession({ owner: true, shares: req.session.shares });
  res.json({ ok: true, passcodeIsDefault: getConfig().passcodeIsDefault });
});

app.post('/api/logout', (req, res) => {
  res.clearSession();
  res.json({ ok: true });
});

app.post('/api/passcode', auth.requireOwner, (req, res) => {
  const { current, next } = req.body || {};
  if (!checkOwnerPasscode(current)) return res.status(401).json({ error: 'Current passcode galat hai' });
  if (!next || String(next).length < 4) return res.status(400).json({ error: 'Naya passcode kam se kam 4 character ka ho' });
  setOwnerPasscode(String(next));
  res.json({ ok: true });
});

app.post('/api/vault-name', auth.requireOwner, (req, res) => {
  const cfg = getConfig();
  cfg.vaultName = String((req.body && req.body.name) || 'Asset Vault').slice(0, 60);
  saveConfig(cfg);
  res.json({ ok: true, vaultName: cfg.vaultName });
});

/* --------------------------------------------------------- share unlocking */

app.get('/api/share/:token', (req, res) => {
  const share = shares.get(req.params.token);
  if (!share) return res.status(404).json({ error: 'Ye link exist nahi karta' });
  if (shares.isExpired(share)) return res.status(410).json({ error: 'Ye link expire ho chuka hai' });
  const project = projectById(share.projectId);
  res.json(Object.assign({}, shares.publicView(share), {
    projectName: project ? project.name : 'Project',
    unlocked: req.session.shares.includes(share.token),
  }));
});

app.post('/api/share/:token/unlock', (req, res) => {
  const share = shares.get(req.params.token);
  if (!share) return res.status(404).json({ error: 'Ye link exist nahi karta' });
  if (shares.isExpired(share)) return res.status(410).json({ error: 'Ye link expire ho chuka hai' });
  if (!shares.verify(share, req.body && req.body.passcode)) return res.status(401).json({ error: 'Galat passcode' });
  const next = [...new Set([...req.session.shares, share.token])];
  res.setSession({ owner: req.session.owner, shares: next });
  shares.touch(share.token);
  res.json(Object.assign({ ok: true }, shares.publicView(share)));
});

/* --------------------------------------------------------------- catalog */

app.get('/api/catalog', (req, res) => {
  const index = indexer.getIndex();
  const cfg = getConfig();

  if (req.session.owner) {
    const projects = cfg.projects.map((p) => {
      const entry = index.projects[p.id] || { files: [], folders: [], bytes: 0 };
      return {
        id: p.id, name: p.name, color: p.color, managed: !!p.managed,
        cloned: !!p.cloned, root: p.root, missing: !!entry.missing,
        files: entry.files, folders: entry.folders, bytes: entry.bytes,
        scannedAt: entry.scannedAt || null,
      };
    });
    return res.json({ owner: true, builtAt: index.builtAt, projects, git: sync.snapshot() });
  }

  const share = activeShare(req);
  if (!share) return res.status(401).json({ error: 'Locked' });
  const entry = index.projects[share.projectId];
  if (!entry) return res.status(404).json({ error: 'Project not indexed' });
  const project = projectById(share.projectId);
  const scoped = scopedProject(entry, share);
  res.json({
    owner: false,
    builtAt: index.builtAt,
    share: shares.publicView(share),
    projects: [{
      id: share.projectId,
      name: project ? project.name : 'Project',
      color: project ? project.color : '#d64545',
      files: scoped.files, folders: scoped.folders, bytes: scoped.bytes,
    }],
  });
});

/* ----------------------------------------------------------- file serving */

function resolveRequest(req, res) {
  const projectId = req.query.p;
  const relPath = req.query.f;
  const project = projectById(projectId);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return null; }
  const check = authorize(req, projectId, relPath);
  if (!check.ok) { res.status(check.status).json({ error: check.error }); return null; }
  const abs = safeResolve(project.root, relPath);
  if (!abs || !fs.existsSync(abs)) { res.status(404).json({ error: 'File not found' }); return null; }
  return { project, abs, relPath, check };
}

app.get('/api/file', (req, res) => {
  const r = resolveRequest(req, res);
  if (!r) return;
  const wantsDownload = req.query.dl === '1';
  if (wantsDownload && r.check.share && !r.check.share.allowDownload) {
    return res.status(403).json({ error: 'Is link me download band hai' });
  }
  if (wantsDownload) {
    const safeName = path.basename(r.abs).replace(/"/g, '');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '"');
  }
  res.setHeader('Cache-Control', 'private, max-age=86400');
  // Send relative to the project root. Passing the absolute path would apply
  // the dotfile rule to the whole path, so any project living under a folder
  // like C:\Users\x\.design\brand would refuse to serve anything.
  res.sendFile(path.relative(r.project.root, r.abs), { root: r.project.root, dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(err.status === 403 ? 403 : 500).end();
  });
});

app.get('/api/thumb', async (req, res) => {
  const r = resolveRequest(req, res);
  if (!r) return;
  const index = indexer.getIndex();
  const entry = index.projects[r.project.id];
  const meta = entry && entry.files.find((f) => f.p === r.relPath);
  const width = Math.min(Number(req.query.w) || 480, 1200);

  // Prefer an already-rendered sibling preview over rasterising a source file.
  let targetAbs = r.abs;
  let kind = (meta && meta.k) || 'other';
  if (meta && meta.th) {
    const previewAbs = safeResolve(r.project.root, meta.th);
    if (previewAbs && fs.existsSync(previewAbs)) {
      targetAbs = previewAbs;
      kind = /\.(mp4|webm|mov)$/i.test(meta.th) ? 'video' : 'image';
    }
  }

  const result = await thumbs.thumbnail({ absPath: targetAbs, kind, width });
  if (result.missing) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=604800');
  if (result.file) return res.sendFile(path.basename(result.file), { root: path.dirname(result.file) });
  if (result.raw) {
    return res.sendFile(path.relative(r.project.root, result.raw), { root: r.project.root, dotfiles: 'deny' });
  }
  // Browser must render it (PDF/AI via pdf.js, video via canvas) then post it back.
  res.setHeader('X-Thumb-Key', result.key);
  res.status(204).end();
});

app.post('/api/thumb-cache', express.raw({ type: 'image/*', limit: '4mb' }), async (req, res) => {
  const r = resolveRequest(req, res);
  if (!r) return;
  try {
    await thumbs.storeClientThumb(req.query.key, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/zip', async (req, res) => {
  const { projectId, files, name } = req.body || {};
  const project = projectById(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const check = authorize(req, projectId, null);
  if (!check.ok) return res.status(check.status).json({ error: check.error });
  if (check.share && !check.share.allowDownload) return res.status(403).json({ error: 'Is link me download band hai' });
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'Koi file select nahi hui' });

  const picked = [];
  for (const rel of files.slice(0, 3000)) {
    if (check.share && !withinFolder(rel, check.share.folderPath)) continue;
    const abs = safeResolve(project.root, rel);
    if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) picked.push({ abs, rel });
  }
  if (!picked.length) return res.status(400).json({ error: 'Kuch bhi download karne layak nahi mila' });

  const zipName = slugify(name || project.name) + '.zip';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="' + zipName + '"');
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', () => res.destroy());
  archive.pipe(res);
  for (const f of picked) archive.file(f.abs, { name: f.rel });
  archive.finalize();
});

/* ------------------------------------------------------- owner: projects */

app.post('/api/projects', auth.requireOwner, (req, res) => {
  const { name, root, color } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Project ka naam chahiye' });
  const cfg = getConfig();
  let id = slugify(name);
  let n = 2;
  while (cfg.projects.some((p) => p.id === id)) id = slugify(name) + '-' + n++;

  let resolvedRoot;
  let managed = false;
  if (root) {
    resolvedRoot = path.resolve(String(root));
    if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
      return res.status(400).json({ error: 'Ye folder path exist nahi karta' });
    }
    // Store the canonical long path. A DOS 8.3 short name here would make the
    // recursive watcher abort the process from inside libuv.
    try { resolvedRoot = fs.realpathSync.native(resolvedRoot); } catch { /* keep resolved */ }
    if (getConfig().projects.some((p) => p.root.toLowerCase() === resolvedRoot.toLowerCase())) {
      return res.status(400).json({ error: 'Ye folder pehle se add hai' });
    }
  } else {
    resolvedRoot = path.join(STORAGE_DIR, id);
    fs.mkdirSync(resolvedRoot, { recursive: true });
    managed = true;
  }

  cfg.projects.push({
    id,
    name: String(name).slice(0, 80),
    root: resolvedRoot,
    managed,
    color: color || '#d64545',
    addedAt: Date.now(),
  });
  saveConfig(cfg);
  indexer.rebuild([id]);
  sync.resync();
  sync.refreshGit(id, { doFetch: true }).catch(() => {});
  res.json({ ok: true, id, isRepo: git.isRepo(resolvedRoot) });
});

app.delete('/api/projects/:id', auth.requireOwner, (req, res) => {
  const cfg = getConfig();
  const project = projectById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const deleteFiles = req.query.files === '1' && (project.managed || project.cloned);

  // Release the watcher before touching the directory: on Windows an open
  // recursive watch handle makes the removal fail with EPERM.
  sync.unwatchProject(project.id);
  cfg.projects = cfg.projects.filter((p) => p.id !== req.params.id);
  saveConfig(cfg);
  for (const s of shares.list()) if (s.projectId === req.params.id) shares.revoke(s.token);

  let removeError = null;
  if (deleteFiles) {
    const removed = sync.removeTree(project.root);
    if (!removed.ok) removeError = removed.err;
  }
  indexer.rebuild();
  sync.resync();
  res.json({ ok: true, filesDeleted: deleteFiles && !removeError, error: removeError || undefined });
});

app.post('/api/rescan', auth.requireOwner, (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : null;
  const index = indexer.rebuild(ids);
  const counts = Object.fromEntries(Object.entries(index.projects).map(([k, v]) => [k, v.files.length]));
  res.json({ ok: true, builtAt: index.builtAt, counts });
});

/* --------------------------------------------------------- owner: uploads */

/**
 * Turns the client-supplied relative path into one that cannot leave the
 * project. Normalising separators has to happen BEFORE the traversal check,
 * otherwise `..\..\x` walks straight past a check that only splits on "/".
 * Bad segments are dropped rather than rejected, so one odd name in a big
 * folder upload cannot fail the whole request.
 */
function decodeRelName(fieldname) {
  let decoded;
  try {
    decoded = Buffer.from(String(fieldname), 'base64url').toString('utf8');
  } catch {
    return 'upload.bin';
  }
  if (!decoded) return 'upload.bin';

  const parts = decoded
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:/, '')       // drive letter
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..');

  if (!parts.length) return 'upload.bin';
  const name = parts[parts.length - 1];
  if (!/[\w.]/.test(name)) return 'upload.bin';
  return parts.join('/');
}

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const project = projectById(req.query.p);
      if (!project) return cb(new Error('Project not found'));
      const rel = decodeRelName(file.fieldname);
      const target = safeResolve(project.root, path.posix.join(req.query.folder || '', path.posix.dirname(rel)));
      if (!target) return cb(new Error('Bad path'));
      fs.mkdirSync(target, { recursive: true });
      cb(null, target);
    },
    filename(req, file, cb) {
      cb(null, path.posix.basename(decodeRelName(file.fieldname)));
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 4000 },
});

app.post('/api/upload', auth.requireOwner, upload.any(), (req, res) => {
  const project = projectById(req.query.p);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  indexer.rebuild([project.id]);
  res.json({ ok: true, count: (req.files || []).length });
});

app.post('/api/folder', auth.requireOwner, (req, res) => {
  const project = projectById(req.body && req.body.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder ka naam chahiye' });
  const abs = safeResolve(project.root, path.posix.join(req.body.parent || '', name));
  if (!abs) return res.status(400).json({ error: 'Bad folder name' });
  fs.mkdirSync(abs, { recursive: true });
  indexer.rebuild([project.id]);
  res.json({ ok: true });
});

app.delete('/api/file', auth.requireOwner, (req, res) => {
  const project = projectById(req.query.p);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const abs = safeResolve(project.root, req.query.f);
  if (!abs || abs === path.resolve(project.root) || !fs.existsSync(abs)) {
    return res.status(404).json({ error: 'File not found' });
  }
  fs.rmSync(abs, { recursive: true, force: true });
  indexer.rebuild([project.id]);
  res.json({ ok: true });
});

/* ---------------------------------------------------------- owner: shares */

app.get('/api/shares', auth.requireOwner, (req, res) => {
  const cfg = getConfig();
  res.json(shares.list().map((s) => {
    const project = cfg.projects.find((p) => p.id === s.projectId);
    return {
      token: s.token, label: s.label, projectId: s.projectId,
      projectName: project ? project.name : '(deleted project)',
      folderPath: s.folderPath, hasPasscode: !!s.passcodeHash,
      expiresAt: s.expiresAt, allowDownload: s.allowDownload,
      createdAt: s.createdAt, views: s.views, lastViewedAt: s.lastViewedAt,
      expired: shares.isExpired(s),
    };
  }));
});

app.post('/api/shares', auth.requireOwner, (req, res) => {
  const projectId = req.body && req.body.projectId;
  if (!projectById(projectId)) return res.status(404).json({ error: 'Project not found' });
  res.json(shares.create(req.body));
});

app.patch('/api/shares/:token', auth.requireOwner, (req, res) => {
  const updated = shares.update(req.params.token, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Share not found' });
  res.json({ ok: true });
});

app.delete('/api/shares/:token', auth.requireOwner, (req, res) => {
  shares.revoke(req.params.token);
  res.json({ ok: true });
});

/* --------------------------------------------------------------- git sync */

app.get('/api/git', auth.requireOwner, (req, res) => {
  res.json({ projects: sync.snapshot(), watching: sync.watching() });
});

app.post('/api/git/refresh/:id', auth.requireOwner, async (req, res) => {
  const state = await sync.refreshGit(req.params.id, { doFetch: req.query.fetch === '1' });
  if (!state) return res.status(404).json({ error: 'Ye project git repo nahi hai' });
  res.json(state);
});

app.post('/api/git/sync/:id', auth.requireOwner, async (req, res) => {
  try {
    const result = await sync.syncProject(req.params.id, { force: true });
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Cheap reachability check so a wrong URL or a missing login fails in
 * seconds, before we commit to a multi-hundred-megabyte clone. */
app.post('/api/git/probe', auth.requireOwner, async (req, res) => {
  const { url, token } = req.body || {};
  const result = await git.probe(url, token);
  if (!result.ok) return res.status(400).json({ error: result.err });
  res.json({
    ok: true,
    branches: result.branches,
    defaultBranch: result.defaultBranch,
    suggestedName: sync.nameFromUrl(url),
  });
});

app.post('/api/projects/clone', auth.requireOwner, (req, res) => {
  const { name, url, branch, token, color } = req.body || {};
  const check = git.validateUrl(url);
  if (!check.ok) return res.status(400).json({ error: check.err });
  const jobId = crypto.randomBytes(8).toString('hex');
  const job = sync.cloneProject({ jobId, name, url: check.url, branch, token, color });
  res.json(Object.assign({ ok: true }, job));
});

app.get('/api/jobs/:jobId', auth.requireOwner, (req, res) => {
  const state = sync.jobState(req.params.jobId);
  if (!state) return res.status(404).json({ error: 'Job not found' });
  res.json(state);
});

app.post('/api/git/settings/:id', auth.requireOwner, (req, res) => {
  const next = sync.setGitSettings(req.params.id, req.body || {});
  if (!next) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true, git: next });
});

/* ---------------------------------------------------------- live updates */

/* One SSE stream per open tab. The server pushes whenever the index moves,
 * so a browser never has to poll and never shows a stale catalog. */
app.get('/api/events', (req, res) => {
  const share = req.session.owner ? null : activeShare(req);
  if (!req.session.owner && !share) return res.status(401).json({ error: 'Locked' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 4000\n\n');

  const send = (event, data) => {
    // A share visitor only ever hears about the project they were given.
    if (share && data.projectId && data.projectId !== share.projectId) return;
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  };
  const onIndex = (payload) => send('index', payload);
  const onGit = (payload) => send('git', payload);
  const onClone = (payload) => { if (req.session.owner) send('clone', payload); };

  sync.bus.on('index', onIndex);
  sync.bus.on('git', onGit);
  sync.bus.on('clone', onClone);

  const beat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(beat);
    sync.bus.off('index', onIndex);
    sync.bus.off('git', onGit);
    sync.bus.off('clone', onClone);
  });
});

/* ------------------------------------------------------------------ pages */

app.use(express.static(path.join(ROOT, 'public'), { index: false, maxAge: '1h' }));
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.get('/s/:token', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  if (!res.headersSent) res.status(500).json({ error: err.message });
});

/* ------------------------------------------------------------------ boot */

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

app.listen(PORT, '0.0.0.0', () => {
  const cfg = getConfig();
  console.log('');
  console.log('  ' + cfg.vaultName + ' is running');
  console.log('  Local:   http://localhost:' + PORT);
  for (const ip of localAddresses()) console.log('  Network: http://' + ip + ':' + PORT);
  if (cfg.passcodeIsDefault) {
    console.log('');
    if (cfg.generatedPasscode) {
      console.log('  First run. Aapka passcode:  ' + cfg.generatedPasscode);
    } else {
      // Config predates generated passcodes, so we cannot show it, but the
      // owner still has not chosen one.
      console.log('  Aapne abhi tak apna passcode set nahi kiya hai.');
    }
    console.log('  (Login karke Settings me apna passcode set kar lijiye)');
  }
  if (!cfg.projects.length) console.log('  Koi project register nahi hai. Login karke "Add project" use kijiye.');

  sync.start();
  const repos = cfg.projects.filter((p) => git.isRepo(p.root));
  console.log('  Watching ' + sync.watching().length + ' project folder(s) for changes' +
    (repos.length ? ', ' + repos.length + ' git-tracked (auto pull on)' : ''));
  console.log('');
});

process.on('SIGINT', () => { sync.stop(); process.exit(0); });
process.on('SIGTERM', () => { sync.stop(); process.exit(0); });
