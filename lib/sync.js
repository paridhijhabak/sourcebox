'use strict';
/* Keeps the vault in step with what is actually on disk.
 *
 * Two triggers feed the same debounced re-index:
 *   - a recursive fs watcher on each project root (your own commits,
 *     checkouts, and plain Explorer drops)
 *   - a polling loop that fetches from the remote and fast-forwards when it
 *     safely can (pushes made from anywhere else)
 *
 * Anything that changes the index emits an event, which the browser is
 * listening to over SSE, so open tabs refresh themselves.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { getConfig, saveConfig, STORAGE_DIR } = require('./config');
const indexer = require('./indexer');
const git = require('./git');

const bus = new EventEmitter();
bus.setMaxListeners(50);

const REINDEX_DEBOUNCE_MS = 1500;
const DEFAULT_POLL_MINUTES = 5;

// Churn we must never re-index on: git's own bookkeeping writes constantly
// during a fetch, and our own caches are not part of any project.
const IGNORED_SEGMENTS = /(^|[\\/])(\.git|node_modules|_vtmp|\.cache|__pycache__)([\\/]|$)/i;
const IGNORED_LEAF = /(^~\$|\.tmp$|\.crdownload$|\.partial$|^\.DS_Store$|^Thumbs\.db$)/i;

const watchers = new Map();   // projectId -> fs.FSWatcher
const timers = new Map();     // projectId -> debounce timer
const gitState = new Map();   // projectId -> last known git status + sync info

let pollTimer = null;

/* ------------------------------------------------------------- indexing */

function projectById(id) {
  return getConfig().projects.find((p) => p.id === id) || null;
}

function gitSettings(project) {
  const g = project.git || {};
  return {
    autoPull: g.autoPull !== false,
    pollMinutes: Number(g.pollMinutes) > 0 ? Number(g.pollMinutes) : DEFAULT_POLL_MINUTES,
  };
}

function reindex(projectId, reason, extra) {
  const project = projectById(projectId);
  if (!project) return null;
  const before = (indexer.getIndex().projects[projectId] || {}).files || [];
  const index = indexer.rebuild([projectId]);
  const after = (index.projects[projectId] || {}).files || [];

  const delta = after.length - before.length;
  const payload = Object.assign({
    projectId,
    projectName: project.name,
    reason,
    fileCount: after.length,
    delta,
    at: Date.now(),
  }, extra || {});

  bus.emit('index', payload);
  return payload;
}

/** Collapses a burst of filesystem events into one rebuild. */
function scheduleReindex(projectId, reason) {
  clearTimeout(timers.get(projectId));
  timers.set(projectId, setTimeout(() => {
    timers.delete(projectId);
    try {
      reindex(projectId, reason);
    } catch (err) {
      console.error('[sync] reindex failed for ' + projectId + ':', err.message);
    }
  }, REINDEX_DEBOUNCE_MS));
}

/* -------------------------------------------------------------- watching */

function relevant(filename) {
  if (!filename) return true;   // Windows sometimes reports no name; be safe.
  if (IGNORED_SEGMENTS.test(filename)) return false;
  if (IGNORED_LEAF.test(path.basename(filename))) return false;
  return true;
}

/**
 * libuv compares the paths Windows reports against the path it was handed and
 * calls abort() when they do not share a prefix, which a DOS 8.3 short name
 * (C:\Users\PARIDH~1\...) or a junction reliably triggers. An abort cannot be
 * caught, so the only defence is to hand it the canonical long path.
 */
function watchableRoot(root) {
  try {
    const real = fs.realpathSync.native(root);
    // Belt and braces: if anything still looks like a short name, do not watch.
    if (/~\d(\\|\/|$)/.test(real)) return null;
    return real;
  } catch {
    return null;
  }
}

function watchProject(project) {
  unwatchProject(project.id);
  if (!fs.existsSync(project.root)) return;
  const target = watchableRoot(project.root);
  if (!target) {
    console.warn('[sync] not watching ' + project.root + ' (path cannot be canonicalised); use Rescan for this one');
    return;
  }
  try {
    const w = fs.watch(target, { recursive: true, persistent: false }, (event, filename) => {
      if (!relevant(filename)) return;
      scheduleReindex(project.id, 'disk');
    });
    w.on('error', (err) => {
      console.warn('[sync] watcher stopped for ' + project.id + ':', err.message);
      unwatchProject(project.id);
    });
    watchers.set(project.id, w);
  } catch (err) {
    console.warn('[sync] cannot watch ' + project.root + ':', err.message);
  }
}

function unwatchProject(id) {
  const w = watchers.get(id);
  if (w) { try { w.close(); } catch { /* already gone */ } }
  watchers.delete(id);
  clearTimeout(timers.get(id));
  timers.delete(id);
}

/* ------------------------------------------------------------ git polling */

async function refreshGit(projectId, { doFetch } = {}) {
  const project = projectById(projectId);
  if (!project || !git.isRepo(project.root)) {
    gitState.delete(projectId);
    return null;
  }
  const prev = gitState.get(projectId) || {};
  if (doFetch) {
    const f = await git.fetch(project.root);
    prev.lastFetchAt = Date.now();
    prev.lastError = f.ok ? null : f.err;
  }
  const st = await git.status(project.root);
  const next = Object.assign({}, prev, st, {
    settings: gitSettings(project),
    checkedAt: Date.now(),
  });
  gitState.set(projectId, next);
  return next;
}

/**
 * One sync pass for a repo: fetch, then fast-forward if it is safe and the
 * project is set to auto-pull. Re-indexes only when the tree actually moved.
 */
async function syncProject(projectId, { force } = {}) {
  const project = projectById(projectId);
  if (!project) return { ok: false, err: 'Project not found' };
  if (!git.isRepo(project.root)) return { ok: false, err: 'Ye project git repo nahi hai' };

  const settings = gitSettings(project);
  const headBefore = (await git.status(project.root)).lastCommit;

  if (!force && !settings.autoPull) {
    const st = await refreshGit(projectId, { doFetch: true });
    if (st && st.behind > 0) {
      bus.emit('git', { projectId, projectName: project.name, kind: 'behind', behind: st.behind });
    }
    return { ok: true, changed: false, status: st, autoPullOff: true };
  }

  const incoming = [];
  const fetched = await git.fetch(project.root);
  if (!fetched.ok) {
    const st = await refreshGit(projectId);
    if (st) { st.lastError = fetched.err; st.lastFetchAt = Date.now(); }
    return { ok: false, err: fetched.err, status: st };
  }
  const files = await git.incomingFiles(project.root);
  incoming.push(...files);

  const result = await git.pull(project.root);
  const st = await refreshGit(projectId);
  if (st) { st.lastFetchAt = Date.now(); st.lastError = result.ok ? null : result.err; }

  if (!result.ok) {
    if (result.skipped) {
      bus.emit('git', {
        projectId, projectName: project.name, kind: 'blocked',
        message: result.err, behind: st ? st.behind : 0,
      });
    }
    return { ok: false, err: result.err, skipped: result.skipped, status: st };
  }

  const headAfter = result.status && result.status.lastCommit;
  const moved = !!(headBefore && headAfter && headBefore.hash !== headAfter.hash);
  if (moved) {
    const payload = reindex(projectId, 'git', {
      pulled: result.pulled || incoming.length,
      commit: headAfter,
      files: incoming.slice(0, 20),
    });
    bus.emit('git', {
      projectId, projectName: project.name, kind: 'pulled',
      commits: result.pulled, fileCount: incoming.length,
      subject: headAfter ? headAfter.subject : null,
      delta: payload ? payload.delta : 0,
    });
  }
  return { ok: true, changed: moved, status: st, incoming };
}

async function pollOnce() {
  for (const project of getConfig().projects) {
    if (!git.isRepo(project.root)) continue;
    const state = gitState.get(project.id);
    const minutes = gitSettings(project).pollMinutes;
    if (state && state.lastFetchAt && Date.now() - state.lastFetchAt < minutes * 60000) continue;
    try {
      await syncProject(project.id);
    } catch (err) {
      console.warn('[sync] poll failed for ' + project.id + ':', err.message);
    }
  }
}

/* -------------------------------------------------------------- cloning */

const REPOS_DIR = path.join(STORAGE_DIR, 'repos');
const jobs = new Map();   // jobId -> last emitted state

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 48) || 'project';
}

/** Derives a sensible project name from a repo URL when none was given. */
function nameFromUrl(url) {
  const cleaned = String(url).replace(/\.git\/?$/, '').replace(/[\\/]+$/, '');
  const last = cleaned.split(/[\\/:]/).filter(Boolean).pop() || 'project';
  return last.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function uniqueId(base) {
  const cfg = getConfig();
  let id = slug(base);
  let n = 2;
  while (cfg.projects.some((p) => p.id === id)) id = slug(base) + '-' + n++;
  return id;
}

function emitJob(jobId, patch) {
  const state = Object.assign({ jobId }, jobs.get(jobId), patch);
  jobs.set(jobId, state);
  bus.emit('clone', state);
  return state;
}

/**
 * Clones a repo into the vault's own storage and registers it as a project.
 * Runs in the background; callers follow it through 'clone' bus events.
 */
function cloneProject({ jobId, name, url, branch, token, color }) {
  const projectName = String(name || '').trim() || nameFromUrl(url);
  const id = uniqueId(projectName);
  const dest = path.join(REPOS_DIR, id);

  fs.mkdirSync(REPOS_DIR, { recursive: true });
  emitJob(jobId, {
    projectId: id, name: projectName, url: git.maskUrl(url),
    phase: 'start', percent: 0, done: false, error: null,
  });

  (async () => {
    if (fs.existsSync(dest)) {
      return emitJob(jobId, { done: true, error: 'Is naam ka folder pehle se hai' });
    }
    const result = await git.clone(url, dest, {
      branch,
      token,
      onProgress: ({ line, percent, phase }) => emitJob(jobId, { line, percent, phase }),
    });
    if (!result.ok) {
      return emitJob(jobId, { done: true, error: result.err, phase: 'failed' });
    }

    emitJob(jobId, { phase: 'indexing', percent: 100, line: 'Files index ho rahi hain...' });

    const cfg = getConfig();
    cfg.projects.push({
      id,
      name: projectName.slice(0, 80),
      root: watchableRoot(dest) || dest,
      managed: true,
      cloned: true,
      color: color || '#d64545',
      addedAt: Date.now(),
      git: { autoPull: true, pollMinutes: DEFAULT_POLL_MINUTES },
    });
    saveConfig(cfg);

    try {
      indexer.rebuild([id]);
    } catch (err) {
      return emitJob(jobId, { done: true, error: 'Index nahi ban paaya: ' + err.message });
    }
    resync();
    await refreshGit(id);

    const entry = indexer.getIndex().projects[id] || { files: [] };
    emitJob(jobId, {
      done: true, phase: 'ready', percent: 100,
      fileCount: entry.files.length,
      line: entry.files.length + ' files ready',
    });
    bus.emit('index', {
      projectId: id, projectName, reason: 'clone',
      fileCount: entry.files.length, delta: entry.files.length, at: Date.now(),
    });
  })().catch((err) => {
    try { fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
    emitJob(jobId, { done: true, error: err.message, phase: 'failed' });
  });

  return { jobId, projectId: id, name: projectName };
}

function jobState(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * Deleting a cloned or uploaded project on Windows fails two ways:
 * the recursive watcher still holds a handle on the directory, and git marks
 * everything under .git/objects read-only. Release the handle, clear the
 * read-only bits, then remove.
 */
function removeTree(root) {
  unwatchProjectByRoot(root);
  clearReadOnly(root);
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    return { ok: true };
  } catch (err) {
    return { ok: false, err: err.message };
  }
}

function unwatchProjectByRoot(root) {
  const target = path.resolve(root).toLowerCase();
  for (const project of getConfig().projects) {
    if (path.resolve(project.root).toLowerCase() === target) unwatchProject(project.id);
  }
  // The project may already be out of config by now, so drop every watcher
  // whose directory no longer resolves. Cheap: there are only a handful.
  for (const [id, w] of watchers) {
    const still = getConfig().projects.find((p) => p.id === id);
    if (!still) { try { w.close(); } catch { /* gone */ } watchers.delete(id); }
  }
}

function clearReadOnly(entry) {
  let stat;
  try {
    stat = fs.lstatSync(entry);
  } catch {
    return;
  }
  try { fs.chmodSync(entry, 0o666); } catch { /* best effort */ }
  if (!stat.isDirectory()) return;
  try { fs.chmodSync(entry, 0o777); } catch { /* best effort */ }
  let children;
  try {
    children = fs.readdirSync(entry);
  } catch {
    return;
  }
  for (const child of children) clearReadOnly(path.join(entry, child));
}

/* ------------------------------------------------------------------- api */

function start() {
  for (const project of getConfig().projects) watchProject(project);
  // First pass right after boot, then on a fixed heartbeat.
  setTimeout(() => { pollOnce().catch(() => {}); }, 4000);
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { pollOnce().catch(() => {}); }, 60000);
  if (pollTimer.unref) pollTimer.unref();
}

function stop() {
  clearInterval(pollTimer);
  for (const id of [...watchers.keys()]) unwatchProject(id);
}

/** Called whenever the project list changes so watchers track it. */
function resync() {
  const live = new Set(getConfig().projects.map((p) => p.id));
  for (const id of [...watchers.keys()]) if (!live.has(id)) unwatchProject(id);
  for (const project of getConfig().projects) {
    if (!watchers.has(project.id)) watchProject(project);
  }
  for (const id of [...gitState.keys()]) if (!live.has(id)) gitState.delete(id);
}

function setGitSettings(projectId, patch) {
  const cfg = getConfig();
  const project = cfg.projects.find((p) => p.id === projectId);
  if (!project) return null;
  project.git = Object.assign({}, project.git, {
    autoPull: patch.autoPull !== undefined ? !!patch.autoPull : gitSettings(project).autoPull,
    pollMinutes: patch.pollMinutes !== undefined
      ? Math.max(1, Math.min(1440, Number(patch.pollMinutes) || DEFAULT_POLL_MINUTES))
      : gitSettings(project).pollMinutes,
  });
  saveConfig(cfg);
  const state = gitState.get(projectId);
  if (state) state.settings = gitSettings(project);
  return project.git;
}

function snapshot() {
  const out = {};
  for (const project of getConfig().projects) {
    const state = gitState.get(project.id);
    out[project.id] = state
      ? state
      : { isRepo: git.isRepo(project.root), settings: gitSettings(project) };
  }
  return out;
}

module.exports = {
  bus, start, stop, resync, reindex, scheduleReindex,
  syncProject, refreshGit, setGitSettings, snapshot, watchableRoot,
  cloneProject, jobState, nameFromUrl, REPOS_DIR, removeTree, unwatchProject,
  watching: () => [...watchers.keys()],
};
