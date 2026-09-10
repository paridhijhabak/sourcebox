'use strict';
const fs = require('fs');
const path = require('path');
const { INDEX_FILE, readJSON, writeJSON, getConfig } = require('./config');

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '_vtmp', '__pycache__',
  '.cache', '.next', 'dist-cache', '.claude', '.idea', '.vscode',
]);
const IGNORE_FILES = new Set([
  '.ds_store', 'thumbs.db', 'desktop.ini', '.gitignore', '.npmignore',
]);
const IGNORE_EXT = new Set(['exe', 'dll', 'so', 'dylib', 'tmp', 'lock', 'map']);

const KIND_BY_EXT = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  bmp: 'image', tif: 'image', tiff: 'image', avif: 'image', ico: 'image',
  svg: 'vector',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', avi: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', aac: 'audio', m4a: 'audio', ogg: 'audio',
  pdf: 'pdf',
  ai: 'design', psd: 'design', eps: 'design', indd: 'design',
  sketch: 'design', fig: 'design', xd: 'design', afdesign: 'design', afphoto: 'design',
  doc: 'doc', docx: 'doc', ppt: 'doc', pptx: 'doc', xls: 'doc', xlsx: 'doc',
  md: 'doc', markdown: 'doc', txt: 'doc', rtf: 'doc', csv: 'doc',
  html: 'doc', htm: 'doc',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
  otf: 'font', ttf: 'font', woff: 'font', woff2: 'font',
  json: 'code', js: 'code', ts: 'code', css: 'code', py: 'code', sh: 'code', yml: 'code', yaml: 'code',
};

// Extensions a browser can preview with no help beyond what we ship.
const PREVIEWABLE = new Set(['image', 'vector', 'video', 'audio', 'pdf', 'doc', 'code']);

function kindOf(ext) {
  return KIND_BY_EXT[ext] || 'other';
}

function shouldSkipDir(name) {
  const lower = name.toLowerCase();
  return IGNORE_DIRS.has(lower) || lower.startsWith('.');
}

function shouldSkipFile(name) {
  const lower = name.toLowerCase();
  if (IGNORE_FILES.has(lower)) return true;
  if (lower.startsWith('.')) return true;
  if (lower.startsWith('~$')) return true;
  const ext = path.extname(lower).slice(1);
  return IGNORE_EXT.has(ext);
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * A sibling `previews/` folder (or the repo-level `_showcase_previews/`) often
 * holds a flat raster of a file we cannot rasterize cheaply. Index those up
 * front so the grid has a thumbnail for .svg/.ai/.pdf without any conversion.
 */
function buildPreviewLookup(files) {
  const byBase = new Map();
  for (const f of files) {
    const dir = path.posix.dirname(f.p).toLowerCase();
    const isPreviewDir = dir.endsWith('/previews') || dir.endsWith('_showcase_previews') || dir === 'previews';
    if (!isPreviewDir) continue;
    if (f.k !== 'image' && f.k !== 'video') continue;
    const base = f.n.replace(/\.[^.]+$/, '').toLowerCase().replace(/[_-]?preview$/, '');
    if (!byBase.has(base)) byBase.set(base, f.p);
  }
  return byBase;
}

function attachPreviews(files) {
  const lookup = buildPreviewLookup(files);
  for (const f of files) {
    if (f.k === 'image' || f.k === 'vector') continue; // rasterised directly by sharp
    const base = f.n.replace(/\.[^.]+$/, '').toLowerCase();
    const hit = lookup.get(base);
    if (hit && hit !== f.p) f.th = hit;
  }
}

function walk(rootAbs, projectId) {
  const files = [];
  const folders = new Set();
  const stack = [''];
  let skipped = 0;

  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(rootAbs, rel) : rootAbs;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) { skipped++; continue; }
        folders.add(childRel);
        stack.push(childRel);
      } else if (entry.isFile()) {
        if (shouldSkipFile(entry.name)) { skipped++; continue; }
        let stat;
        try {
          stat = fs.statSync(path.join(rootAbs, childRel.split('/').join(path.sep)));
        } catch {
          continue;
        }
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        const kind = kindOf(ext);
        files.push({
          id: `${projectId}:${childRel}`,
          p: childRel,
          n: entry.name,
          d: rel || '',
          e: ext,
          k: kind,
          s: stat.size,
          m: stat.mtimeMs,
          pv: PREVIEWABLE.has(kind),
          th: null,
        });
      }
    }
  }

  attachPreviews(files);
  files.sort((a, b) => a.p.localeCompare(b.p));
  return { files, folders: [...folders].sort(), skipped };
}

function buildProject(project) {
  if (!fs.existsSync(project.root)) {
    return { id: project.id, name: project.name, missing: true, files: [], folders: [], bytes: 0 };
  }
  const { files, folders, skipped } = walk(project.root, project.id);
  const bytes = files.reduce((sum, f) => sum + f.s, 0);
  return {
    id: project.id,
    name: project.name,
    root: project.root,
    managed: !!project.managed,
    color: project.color || '#d64545',
    files,
    folders,
    bytes,
    skipped,
    scannedAt: Date.now(),
  };
}

function rebuild(projectIds) {
  const cfg = getConfig();
  const existing = readJSON(INDEX_FILE, { projects: {} });
  const targets = projectIds && projectIds.length
    ? cfg.projects.filter((p) => projectIds.includes(p.id))
    : cfg.projects;

  const out = projectIds && projectIds.length ? existing.projects : {};
  for (const project of targets) {
    out[project.id] = buildProject(project);
  }
  // Drop projects that are no longer registered.
  const live = new Set(cfg.projects.map((p) => p.id));
  for (const id of Object.keys(out)) if (!live.has(id)) delete out[id];

  const index = { builtAt: Date.now(), projects: out };
  writeJSON(INDEX_FILE, index);
  return index;
}

function getIndex() {
  return readJSON(INDEX_FILE, { builtAt: 0, projects: {} });
}

module.exports = { rebuild, getIndex, buildProject, kindOf, toPosix, PREVIEWABLE };
