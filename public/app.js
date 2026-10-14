/* SourceBox client. Vanilla, no build step. */
(function () {
  'use strict';

  /* ================================================================ state */

  const S = {
    owner: false,
    vaultName: 'SourceBox',
    shareToken: null,
    share: null,
    projects: [],
    projectId: null,
    folder: '',
    query: '',
    view: localStorage.getItem('av.view') || 'grid',
    sort: 'relevance',
    kinds: new Set(),
    selection: new Set(),
    openDirs: new Set(),
    results: [],
    lastClickIndex: -1,
    git: {},
    pendingRefresh: false,
    // Starred lives on the server, keyed "projectId\0relPath" so one Set can
    // answer for every project at once.
    stars: new Set(),
    // Recents are per-browser on purpose: "what was I just looking at" is a
    // property of this session, not of the asset.
    recents: [],
    scope: 'all',        // all | starred | recent
    cursor: -1,          // keyboard focus, an index into the rendered cards
    // Projects whose folder list is folded away. Kept per project so closing
    // one does not close the others.
    collapsed: new Set(),
    theme: {},
    themeApplied: [],
  };

  const RECENTS_MAX = 40;
  const starKey = (projectId, rel) => projectId + '\u0000' + rel;
  const isStarred = (rel) => S.stars.has(starKey(S.projectId, rel));

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

  // Kinds that end up with an actual picture on the card, so they get the
  // checkerboard plate. Everything else gets a flat panel and an icon.
  const VISUAL = new Set(['image', 'vector', 'pdf', 'design', 'video']);

  /* Folder tiles show a few of their contents. Only kinds the server can
   * rasterise on its own qualify: a PDF or .ai peek would fire a browser
   * render for every folder on screen, which is far too much work for a
   * thumbnail the size of a stamp. A design file that has a sibling preview
   * (f.th) is fine, since that preview is already a plain image. */
  const PEEKABLE = new Set(['image', 'vector']);
  /* One preview per folder. A row of three read as a contact sheet; a single
   * larger image reads as the folder's cover. */
  const PEEK_MAX = 1;

  const KIND_LABEL = {
    image: 'Images', vector: 'Vectors', video: 'Videos', pdf: 'PDF',
    design: 'Source files', doc: 'Docs', font: 'Fonts', audio: 'Audio',
    archive: 'Zips', code: 'Code', other: 'Other',
  };

  /* =============================================================== utils */

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function bytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : n / Math.pow(1024, i) >= 10 ? 0 : 1) + ' ' + u[i];
  }

  function when(ms) {
    if (!ms) return '-';
    const d = new Date(ms);
    const days = (Date.now() - ms) / 86400000;
    if (days < 1) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (days < 340) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function icon(name, size) {
    return '<svg width="' + (size || 15) + '" height="' + (size || 15) + '"><use href="#i-' + name + '"/></svg>';
  }

  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; }, 3200);
    setTimeout(() => el.remove(), 3500);
  }

  async function api(path, opts) {
    const options = Object.assign({ headers: {} }, opts || {});
    if (options.body && typeof options.body !== 'string' && !(options.body instanceof FormData)) {
      options.body = JSON.stringify(options.body);
      options.headers['Content-Type'] = 'application/json';
    }
    if (S.shareToken) options.headers['X-Share-Token'] = S.shareToken;
    const res = await fetch(path, options);
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : null;
    if (!res.ok) throw new Error((data && data.error) || res.statusText || 'Request failed');
    return data;
  }

  /**
   * Every asset URL carries the share token so the server can scope it.
   * `projectId` is explicit because deferred work (a thumbnail the browser
   * renders seconds later) must stay bound to the project it started in,
   * not whichever one is selected by the time it runs.
   */
  function assetURL(base, file, extra, projectId) {
    const p = new URLSearchParams(Object.assign({ p: projectId || S.projectId, f: file.p }, extra || {}));
    if (S.shareToken) p.set('share', S.shareToken);
    return base + '?' + p.toString();
  }

  const project = () => S.projects.find((p) => p.id === S.projectId) || null;

  /* ============================================================== theming */

  /* The owner picks three colours; everything else is worked out from them.
   * Asking someone to hand-pick the tint behind a selected row, or the four
   * shades that make a folder look like a folder, is how palettes end up
   * unreadable. */

  function hexToRgb(hex) {
    const h = String(hex).replace('#', '');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }

  function rgbToHex({ r, g, b }) {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
  }

  /** amount > 0 lightens towards white, < 0 darkens towards black. */
  function shade(hex, amount) {
    const { r, g, b } = hexToRgb(hex);
    const t = amount > 0 ? 255 : 0;
    const k = Math.abs(amount);
    return rgbToHex({ r: r + (t - r) * k, g: g + (t - g) * k, b: b + (t - b) * k });
  }

  /** Perceived brightness, used only to decide black-or-white text on a fill. */
  function luminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function rgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }

  const THEME_KEYS = ['accent', 'folder', 'bg'];

  /** CSS variables for one choice. Returns {} when that choice is unset. */
  function themeVars(theme) {
    const out = {};
    if (!theme) return out;

    if (theme.accent) {
      out['--accent'] = theme.accent;
      out['--accent-soft'] = rgba(theme.accent, 0.13);
      // Text sitting on a filled accent has to survive both a pale pick and a
      // dark one, so it flips rather than staying white.
      out['--on-accent'] = luminance(theme.accent) > 0.62 ? '#17140f' : '#ffffff';
    }
    if (theme.folder) {
      out['--fold-back-hi'] = shade(theme.folder, 0.16);
      out['--fold-back-lo'] = shade(theme.folder, -0.10);
      out['--fold-front-hi'] = shade(theme.folder, 0.34);
      out['--fold-front-lo'] = shade(theme.folder, 0.06);
      out['--fold-lip'] = rgba(shade(theme.folder, 0.55), 0.75);
    }
    if (theme.bg) {
      out['--bg'] = theme.bg;
      // The rail and the hover wash follow the page, in the same direction as
      // the page's own brightness so they stay visible either way.
      const dir = luminance(theme.bg) > 0.5 ? -1 : 1;
      out['--bg-2'] = shade(theme.bg, dir * 0.04);
      out['--hover'] = shade(theme.bg, dir * 0.07);
    }
    return out;
  }

  function applyTheme(theme) {
    S.theme = theme || {};
    const root = document.documentElement;
    // Clear whatever the last apply set, so unsetting a colour really unsets it.
    for (const name of (S.themeApplied || [])) root.style.removeProperty(name);
    const vars = themeVars(S.theme);
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    S.themeApplied = Object.keys(vars);
  }

  async function saveTheme(patch) {
    const r = await api('/api/theme', { method: 'POST', body: patch });
    applyTheme(r.theme);
    return r.theme;
  }

  /* ========================================================= clipboard */

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast((label || 'Item') + ' copied', 'ok');
    } catch {
      toast('The browser blocked clipboard access', 'err');
    }
  }

  /**
   * Puts the picture itself on the clipboard, so it can be pasted straight
   * into a deck or a chat. Everything is re-encoded to PNG because that is
   * the only bitmap format browsers will accept on the clipboard.
   */
  async function copyImage(file) {
    if (!navigator.clipboard || !window.ClipboardItem) {
      return toast('This browser can’t copy images', 'err');
    }
    try {
      const res = await fetch(assetURL('/api/file', file));
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const png = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
      if (!png) throw new Error('encode failed');
      await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': png })]);
      toast('Image copied', 'ok');
    } catch {
      toast('Could not copy the image', 'err');
    }
  }

  /* ====================================================== stars & recents */

  async function loadStars() {
    if (!S.owner) return;
    try {
      const r = await api('/api/stars');
      const next = new Set();
      for (const [projectId, files] of Object.entries(r.stars || {})) {
        for (const rel of Object.keys(files)) next.add(starKey(projectId, rel));
      }
      S.stars = next;
    } catch {
      // A vault that cannot read its stars is still a usable vault.
    }
  }

  async function toggleStar(rel) {
    if (!S.owner) return;
    const key = starKey(S.projectId, rel);
    const was = S.stars.has(key);
    // Flip first so the click feels instant, then reconcile with the server.
    if (was) S.stars.delete(key); else S.stars.add(key);
    paintStars(rel);
    try {
      const r = await api('/api/stars', { method: 'POST', body: { projectId: S.projectId, path: rel } });
      if (r.starred) S.stars.add(key); else S.stars.delete(key);
    } catch (err) {
      if (was) S.stars.add(key); else S.stars.delete(key);
      toast(err.message, 'err');
    }
    paintStars(rel);
    renderSidebar();
    if (S.scope === 'starred') renderStage();
  }

  /** Repaints just the affected card and the viewer, not the whole grid. */
  function paintStars(rel) {
    const on = isStarred(rel);
    $$('[data-star="' + cssEscape(rel) + '"]').forEach((b) => b.classList.toggle('on', on));
    const card = $('[data-file="' + cssEscape(rel) + '"]');
    if (card) card.classList.toggle('starred', on);
  }

  /** CSS.escape is not everywhere yet, and asset names contain quotes. */
  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function loadRecents() {
    try {
      const raw = JSON.parse(localStorage.getItem('av.recents') || '[]');
      return Array.isArray(raw) ? raw.filter((r) => r && r.p && r.f) : [];
    } catch {
      return [];
    }
  }

  function noteRecent(rel) {
    S.recents = S.recents.filter((r) => !(r.p === S.projectId && r.f === rel));
    S.recents.unshift({ p: S.projectId, f: rel, at: Date.now() });
    if (S.recents.length > RECENTS_MAX) S.recents.length = RECENTS_MAX;
    try { localStorage.setItem('av.recents', JSON.stringify(S.recents)); } catch { /* quota */ }
  }

  /* ========================================================= back / history */

  /* The browser's back button should undo the last move, the same as the Back
   * control in the viewer. State is pushed without touching the URL: the app is
   * served from one path (and /s/<token> for a share), so rewriting it would
   * only create URLs that break on reload. */
  let applyingNav = false;

  function navState() {
    return {
      sb: true,
      projectId: S.projectId,
      folder: S.folder,
      scope: S.scope,
      file: viewerIndex >= 0 && S.results[viewerIndex] ? S.results[viewerIndex].p : null,
    };
  }

  function pushNav() {
    if (applyingNav) return;
    try { history.pushState(navState(), ''); } catch { /* private mode */ }
  }

  /** Replace the current entry, so the first Back has somewhere to land. */
  function seedNav() {
    try { history.replaceState(navState(), ''); } catch { /* private mode */ }
  }

  window.addEventListener('popstate', (e) => {
    const s = e.state;
    applyingNav = true;
    try {
      if (!s || !s.sb) {
        // Landed before the app pushed anything: the root of this project.
        if (viewerIndex >= 0) closeViewer();
        S.folder = '';
        S.scope = 'all';
        renderAll();
        return;
      }
      if (s.projectId && s.projectId !== S.projectId) S.projectId = s.projectId;
      S.folder = s.folder || '';
      S.scope = s.scope || 'all';
      S.selection.clear();
      for (const part of S.folder.split('/')) {
        if (!part) continue;
        const acc = S.folder.slice(0, S.folder.indexOf(part) + part.length);
        S.openDirs.add(acc);
      }
      renderAll();
      syncSelection();
      if (s.file) {
        const idx = S.results.findIndex((f) => f.p === s.file);
        if (idx >= 0) { viewerIndex = idx; drawViewer(); } else if (viewerIndex >= 0) closeViewer();
      } else if (viewerIndex >= 0) {
        closeViewer();
      }
    } finally {
      applyingNav = false;
    }
  });

  function setScope(next) {
    if (next === S.scope) return;
    S.scope = next;
    pushNav();
    S.selection.clear();
    S.cursor = -1;
    renderAll();
    syncSelection();
    const stage = $('#stage');
    if (stage) stage.scrollTop = 0;
  }

  /* ============================================================= boot */

  async function boot() {
    // Remembered choice wins; otherwise follow the operating system.
    document.documentElement.dataset.theme = localStorage.getItem('av.theme') ||
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const shareMatch = location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)/);

    // Paint the chosen colours before the lock screen is looked at, so the
    // vault does not change appearance the moment someone signs in.
    api('/api/session').then((s) => applyTheme(s && s.theme)).catch(() => {});

    if (shareMatch) {
      S.shareToken = shareMatch[1];
      // A share visitor has no account here; only the link's passcode matters.
      $('#lock-alt').classList.add('hidden');
      try {
        const info = await api('/api/share/' + S.shareToken);
        $('#lock-title').textContent = info.label || 'Shared folder';
        $('#lock-sub').innerHTML = 'From <strong>' + esc(info.projectName) + '</strong>' +
          (info.hasPasscode ? '. Enter the passcode.' : '. No passcode needed.');
        if (!info.hasPasscode || info.unlocked) {
          await unlockShare('');
          return;
        }
      } catch (err) {
        $('#lock-sub').textContent = err.message;
        $('#lock-pass').disabled = true;
        $('#lock-go').disabled = true;
        return;
      }
    } else {
      const sess = await api('/api/session').catch(() => null);
      if (sess && sess.owner) { S.owner = true; S.vaultName = sess.vaultName; return enter(sess); }
      if (sess) { $('#lock-title').textContent = sess.vaultName; }
    }
    $('#lock-pass').focus();
  }

  async function unlockShare(passcode) {
    const info = await api('/api/share/' + S.shareToken + '/unlock', { method: 'POST', body: { passcode } });
    S.share = info;
    S.owner = false;
    S.vaultName = info.label;
    await enter({ vaultName: info.label });
  }

  async function enter(sess) {
    S.user = sess.user || null;
    applyTheme(sess.theme);
    $('#lock').classList.add('hidden');
    $('#app').classList.remove('hidden');
    const vaultName = sess.vaultName || S.vaultName;
    $('#vault-name').textContent = vaultName;
    // The product name is also the default vault name, so only append it once
    // the owner has renamed their instance to something else.
    document.title = vaultName === 'SourceBox' ? vaultName : vaultName + ' - SourceBox';
    if (!S.owner) $$('.owner-only').forEach((el) => el.classList.add('hidden'));
    S.recents = loadRecents();
    await loadStars();
    await loadCatalog();
    seedNav();
    openStream();
    if (sess.passcodeIsDefault) {
      toast('This is an auto-generated passcode. Set your own in Settings.', 'err');
    }
  }

  async function loadCatalog(opts) {
    const data = await api('/api/catalog' + (S.shareToken ? '?share=' + S.shareToken : ''));
    S.projects = data.projects || [];
    S.git = data.git || {};
    for (const p of S.projects) p.files.forEach(VaultSearch.prepare);
    if (!S.projects.length) { renderAll(); return; }
    if (!S.projects.some((p) => p.id === S.projectId)) {
      S.projectId = S.projects[0].id;
      S.folder = (S.share && S.share.folderPath) || '';
    }
    // A folder can vanish under you when git moves things around.
    const p = project();
    if (S.folder && p && !p.folders.includes(S.folder)) S.folder = (S.share && S.share.folderPath) || '';
    const live = new Set((p ? p.files : []).map((f) => f.p));
    for (const sel of [...S.selection]) if (!live.has(sel)) S.selection.delete(sel);

    if (opts && opts.keepScroll) {
      const top = $('#stage').scrollTop;
      renderAll();
      $('#stage').scrollTop = top;
    } else {
      renderAll();
    }
    syncSelection();
  }

  /* ============================================================ derive */

  function visibleFiles() {
    const p = project();
    if (!p) return [];
    // A `previews/` folder holds renders of the file sitting next to it. That
    // is plumbing for the thumbnails, not something anyone searches for.
    return p.files.filter((f) => !/(^|\/)previews\//i.test(f.p));
  }

  /* Browsing shows only what sits directly in this folder, the way a drive
   * does. Searching or filtering by type widens to the whole subtree, since
   * that is what someone asking "where is the red logo" actually wants. */
  function inScope(files, deep) {
    if (!S.folder) return deep ? files : files.filter((f) => f.d === '');
    if (!deep) return files.filter((f) => f.d === S.folder);
    return files.filter((f) => f.p.startsWith(S.folder + '/'));
  }

  /* "Deep" means the stage stops behaving like a folder and starts behaving
   * like a result set: no folder tiles, and files are gathered from the whole
   * subtree. Searching, filtering by type, and the starred/recent views all
   * want exactly that. */
  const isDeep = () => !!(S.query.trim() || S.kinds.size || S.scope !== 'all');

  /**
   * Immediate subfolders of the current folder: how many files are inside,
   * what its own subfolders are called, and a few files to show in the tile.
   */
  function childFolders() {
    const p = project();
    if (!p || isDeep()) return [];
    const depth = S.folder ? S.folder.split('/').length : 0;
    const out = new Map();
    for (const dir of p.folders) {
      if (S.folder && !dir.startsWith(S.folder + '/')) continue;
      const parts = dir.split('/');
      if (parts.length !== depth + 1) continue;
      if (/^previews$/i.test(parts[parts.length - 1])) continue;
      out.set(dir, { n: 0, subs: new Set(), peek: [], exts: new Map() });
    }
    // Subfolder names come from the folder list rather than from the files, so
    // a folder that holds nothing but folders still shows its structure.
    for (const dir of p.folders) {
      for (const [parent, info] of out) {
        if (!dir.startsWith(parent + '/')) continue;
        const rest = dir.slice(parent.length + 1).split('/');
        if (rest.length === 1 && !/^previews$/i.test(rest[0])) info.subs.add(rest[0]);
      }
    }
    for (const f of visibleFiles()) {
      for (const [dir, info] of out) {
        if (!f.p.startsWith(dir + '/')) continue;
        info.n++;
        if (PEEKABLE.has(f.k) || f.th) info.peek.push(f);
        if (f.e) info.exts.set(f.e, (info.exts.get(f.e) || 0) + 1);
      }
    }
    return [...out.entries()]
      .map(([path, info]) => ({
        path,
        name: path.split('/').pop(),
        n: info.n,
        subs: [...info.subs].sort((a, b) => a.localeCompare(b)),
        // Shallowest first: what sits directly in the folder represents it
        // better than something buried three levels down.
        peek: info.peek
          .sort((a, b) => (a.p.split('/').length - b.p.split('/').length) || a.p.localeCompare(b.p))
          .slice(0, PEEK_MAX)
          .map((f) => f.p),
        // Fallback for folders holding nothing a thumbnail can show: name the
        // file types instead, commonest first.
        exts: [...info.exts.entries()]
          .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
          .slice(0, PEEK_MAX)
          .map(([ext]) => ext),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function compute() {
    // Starred and Recent ignore the current folder: they are answers about the
    // whole project, and being silently scoped to wherever you happen to be
    // standing would make them look empty for no visible reason.
    let files;
    let ownOrder = null;
    if (S.scope === 'starred') {
      files = visibleFiles().filter((f) => isStarred(f.p));
    } else if (S.scope === 'recent') {
      ownOrder = new Map();
      S.recents.filter((r) => r.p === S.projectId).forEach((r, i) => ownOrder.set(r.f, i));
      files = visibleFiles().filter((f) => ownOrder.has(f.p));
    } else {
      files = inScope(visibleFiles(), isDeep());
    }
    if (S.kinds.size) files = files.filter((f) => S.kinds.has(f.k));

    let ranked;
    if (S.query.trim()) {
      ranked = VaultSearch.search(files, S.query);
    } else {
      ranked = files.map((f) => ({ file: f, score: 0 }));
    }

    const sorters = {
      name: (a, b) => a.file.n.localeCompare(b.file.n, undefined, { numeric: true }),
      date: (a, b) => b.file.m - a.file.m,
      size: (a, b) => b.file.s - a.file.s,
    };
    if (S.sort !== 'relevance') ranked.sort(sorters[S.sort]);
    // Recent is already in the only order that means anything: last opened
    // first. Only override it if the reader asked for something else.
    else if (ownOrder) ranked.sort((a, b) => ownOrder.get(a.file.p) - ownOrder.get(b.file.p));
    else if (!S.query.trim()) ranked.sort(sorters.name);

    S.results = ranked.map((r) => r.file);
    return S.results;
  }

  /** How many of this project's files are starred / recently opened. */
  function scopeCounts() {
    const live = visibleFiles();
    const recent = new Set(S.recents.filter((r) => r.p === S.projectId).map((r) => r.f));
    let starred = 0;
    let seen = 0;
    for (const f of live) {
      if (isStarred(f.p)) starred++;
      if (recent.has(f.p)) seen++;
    }
    return { all: live.length, starred, recent: seen };
  }

  // Chip counts always describe the whole subtree, so the sidebar tells you
  // what is down there rather than only what is on screen.
  function kindCounts() {
    const counts = {};
    for (const f of inScope(visibleFiles(), true)) counts[f.k] = (counts[f.k] || 0) + 1;
    return counts;
  }

  /* ============================================================ render */

  function renderAll() {
    renderSidebar();
    renderGitStrip();
    renderStage();
  }

  /* ------------------------------------------------------------ git strip */

  function ago(ms) {
    if (!ms) return '';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function renderGitStrip() {
    const box = $('#git-strip');
    if (!S.owner) { box.classList.add('hidden'); return; }
    const g = S.git[S.projectId];
    if (!g || !g.isRepo) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');

    const behind = g.behind || 0;
    const dirty = g.dirtyCount || 0;
    const blocked = behind > 0 && dirty > 0;

    // Straight after boot the server knows the folder is a repo but has not
    // read it yet, so there is no branch. Saying "detached · up to date" there
    // is two lies in one line; say nothing is known instead.
    const unread = !g.branch && !g.lastError;

    const cls = g.lastError || blocked ? 'problem' : behind > 0 ? 'behind' : '';
    const dot = g.lastError ? 'bad' : unread ? 'idle' : behind > 0 ? 'warn' : '';

    let state;
    if (unread) state = 'checking...';
    else if (g.lastError) state = 'sync paused';
    else if (behind > 0) state = behind + ' new commit' + (behind === 1 ? '' : 's');
    else if (g.ahead > 0) state = g.ahead + ' to push';
    else state = 'up to date';

    const auto = (g.settings && g.settings.autoPull) !== false;

    // One quiet line. This is a design tool, and repo plumbing does not deserve
    // the best real estate in the sidebar — but it still has to be reachable,
    // so the whole row opens the detail sheet and only "Pull" is promoted, and
    // only when there is actually something to pull.
    box.innerHTML =
      '<div class="git-line ' + cls + '">' +
        '<button class="git-open" id="git-open" title="Repo details"' + (unread ? ' disabled' : '') + '>' +
          '<span class="git-dot ' + dot + '"></span>' +
          (unread ? '' : '<span class="git-branch">' + esc(g.branch) + '</span>') +
          '<span class="git-state' + (behind > 0 ? ' hot' : '') + '">' + esc(state) + '</span>' +
        '</button>' +
        (behind > 0
          ? '<button class="btn btn-sm btn-primary git-pull-btn" id="git-pull">Pull ' + behind + '</button>'
          : '<button class="btn btn-ghost btn-sm btn-icon" id="git-pull" title="Check for new commits">' +
            icon('refresh', 13) + '</button>') +
      '</div>';
  }

  /** The repo detail the sidebar line deliberately leaves out. */
  function gitModal() {
    const g = S.git[S.projectId];
    if (!g || !g.isRepo) return;
    const behind = g.behind || 0;
    const dirty = g.dirtyCount || 0;
    const auto = (g.settings && g.settings.autoPull) !== false;
    const blocked = behind > 0 && dirty > 0;

    const m = modal(head('Repository') +
      '<div class="modal-body">' +
      '<dl class="kv">' +
        '<dt>Branch</dt><dd><code>' + esc(g.branch || 'detached') + '</code></dd>' +
        (g.upstream ? '<dt>Tracking</dt><dd><code>' + esc(g.upstream) + '</code></dd>' : '') +
        '<dt>State</dt><dd>' + (behind > 0 ? behind + ' new commit' + (behind === 1 ? '' : 's') + ' waiting' : 'Up to date') + '</dd>' +
        '<dt>Local changes</dt><dd>' + (dirty ? dirty + ' uncommitted' : 'None') + '</dd>' +
        '<dt>Last checked</dt><dd>' + esc(ago(g.checkedAt || g.lastFetchAt)) + '</dd>' +
        (g.lastCommit ? '<dt>Last commit</dt><dd>' + esc(g.lastCommit.subject) + '</dd>' : '') +
      '</dl>' +
      (g.lastError ? '<p class="msg err">' + esc(g.lastError) + '</p>' : '') +
      (blocked ? '<p class="hint">Auto pull is paused because there are uncommitted changes. Commit or stash them first.</p>' : '') +
      '<label class="switch" style="margin-top:14px" title="Automatically pull new commits">' +
        '<input type="checkbox" id="git-auto"' + (auto ? ' checked' : '') + '>' +
        '<span class="track"></span><span>Automatically pull new commits</span></label>' +
      '</div>' +
      '<div class="modal-foot">' +
        '<button class="btn btn-sm" data-close>Close</button>' +
        '<button class="btn btn-sm btn-primary" id="git-sheet-pull">' + icon('cloud-down', 13) +
          (behind > 0 ? ' Pull ' + behind : ' Check now') + '</button>' +
      '</div>');

    // The sidebar's delegated handler does not reach into #modal-root, so the
    // sheet wires its own controls.
    $('#git-sheet-pull', m).addEventListener('click', () => { m.close(); gitSync(S.projectId); });
    $('#git-auto', m).addEventListener('change', (e) => {
      api('/api/git/settings/' + S.projectId, { method: 'POST', body: { autoPull: e.target.checked } })
        .then(() => refreshGitState())
        .then(() => toast(e.target.checked ? 'Auto pull on' : 'Auto pull off', 'ok'))
        .catch((err) => toast(err.message, 'err'));
    });
    return m;
  }

  async function gitSync(projectId) {
    const btn = $('#git-pull');
    if (btn) { btn.disabled = true; btn.innerHTML = icon('refresh', 13) + ' Checking'; }
    try {
      const r = await api('/api/git/sync/' + projectId, { method: 'POST', body: {} });
      if (r.changed) toast('Pulled the latest from the remote', 'ok');
      else toast('Already up to date', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
    await refreshGitState(projectId);
  }

  async function refreshGitState(projectId) {
    try {
      const data = await api('/api/git');
      S.git = data.projects || {};
    } catch { /* sidebar just keeps the old numbers */ }
    renderGitStrip();
    void projectId;
  }

  function renderSidebar() {
    const list = $('#proj-list');
    // With nothing registered, empty "Folders" and "File type" headers just
    // look broken. Show the project list only.
    const bare = !S.projects.length;
    $$('.side-head').forEach((h) => {
      if (h.textContent.trim().startsWith('Projects')) return;
      h.classList.toggle('hidden', bare);
    });
    $('#scopes').classList.toggle('hidden', bare);
    $('.side-foot').classList.toggle('hidden', bare && !S.owner);
    // One spine, not two. A project and its folders are the same tree, so the
    // open project's folders hang directly off its row instead of repeating
    // the project name under a separate "Folders" heading.
    $('#proj-section').classList.remove('hidden');
    list.innerHTML = S.projects.map((p) => {
      const active = p.id === S.projectId;
      const open = active && !S.collapsed.has(p.id);
      return '<button class="proj' + (active ? ' on' : '') + (p.missing ? ' missing' : '') +
        '" data-proj="' + esc(p.id) + '">' +
        '<span class="tree-caret' + (open ? ' open' : '') + '">' + icon('chev', 11) + '</span>' +
        '<span class="proj-dot" style="background:' + esc(p.color || '#fb6530') + '"></span>' +
        '<span class="proj-name">' + esc(p.name) + '</span>' +
        '<span class="proj-count">' + p.files.length + '</span></button>' +
        (open ? '<div class="tree">' + treeHTML() + '</div>' : '');
    }).join('');

    renderScopes();
    renderKinds();

    const p = project();
    $('#stats').textContent = p ? p.files.length + ' files  ·  ' + bytes(p.bytes) : '';
    $('#vault-sub').textContent = S.owner ? 'Owner access' : 'Shared with you';
  }

  /* Three ways into the same project: everything, the ones you marked, and the
   * ones you just had open.
   *
   * These are filters, not places. They used to be a full labelled section of
   * three wide rows, which made them look like a second folder tree and lit up
   * a "you are here" in two parts of the sidebar at once. As one compact row of
   * pills they read as what they are. Starred needs an owner session to
   * persist, so a share visitor is only offered All and Recent. */
  function renderScopes() {
    const box = $('#scopes');
    if (!box) return;
    const n = scopeCounts();
    const rows = [
      { id: 'all', icon: 'layers', label: 'All', count: n.all, title: 'Everything in this folder' },
      S.owner ? { id: 'starred', icon: 'star', label: 'Starred', count: n.starred, title: 'Files you starred, anywhere in the project' } : null,
      { id: 'recent', icon: 'clock', label: 'Recent', count: n.recent, title: 'Files you opened lately' },
    ].filter(Boolean);

    box.innerHTML = rows.map((r) => (
      '<button class="scope' + (S.scope === r.id ? ' on' : '') + '" data-scope="' + r.id +
      '" title="' + esc(r.title) + '">' +
      icon(r.icon, 13) +
      '<span class="scope-name">' + esc(r.label) + '</span>' +
      (r.count ? '<span class="scope-n">' + r.count + '</span>' : '') +
      '</button>'
    )).join('');
  }

  /** The open project's folders, as rows that nest under its own row. */
  function treeHTML() {
    const p = project();
    if (!p) return '';

    const base = (S.share && S.share.folderPath) || '';
    const baseDepth = base ? base.split('/').length : 0;
    const dirs = p.folders.filter((d) => {
      if (/(^|\/)previews$/i.test(d)) return false;
      if (base && !(d === base || d.startsWith(base + '/'))) return false;
      return true;
    });

    const counts = new Map();
    for (const f of p.files) {
      let dir = f.d;
      while (dir) {
        counts.set(dir, (counts.get(dir) || 0) + 1);
        const cut = dir.lastIndexOf('/');
        dir = cut < 0 ? '' : dir.slice(0, cut);
      }
    }

    const rows = [];
    // No root row: the project's own row above is the root now.
    for (const dir of dirs) {
      if (dir === base) continue;
      const parts = dir.split('/');
      const depth = parts.length - baseDepth;
      const parent = parts.slice(0, -1).join('/');
      if (parent && parent !== base && !S.openDirs.has(parent)) continue;
      const hasKids = dirs.some((d) => d.startsWith(dir + '/'));
      rows.push(row(dir, parts[parts.length - 1], counts.get(dir) || 0, depth, hasKids));
    }
    return rows.join('');

    function row(path, label, n, depth, hasKids) {
      const open = S.openDirs.has(path);
      return '<button class="tree-row' + (S.folder === path ? ' on' : '') + '" data-dir="' + esc(path) + '"' +
        ' style="padding-left:' + (14 + (depth - 1) * 12) + 'px">' +
        '<span class="tree-caret' + (hasKids ? (open ? ' open' : '') : ' leaf') + '"' +
        (hasKids ? ' data-toggle="' + esc(path) + '"' : '') + '>' + icon('chev', 11) + '</span>' +
        '<span class="tree-label">' + esc(label) + '</span>' +
        '<span class="tree-n">' + n + '</span></button>';
    }
  }

  /* File types moved out of the sidebar into a popover on the toolbar: it is a
   * filter you reach for occasionally, not a place you navigate to. */
  function renderKinds() {
    const counts = kindCounts();
    const order = ['image', 'vector', 'design', 'pdf', 'video', 'doc', 'font', 'audio', 'archive', 'code', 'other'];
    $('#kind-chips').innerHTML = order.filter((k) => counts[k]).map((k) => (
      '<button class="chip' + (S.kinds.has(k) ? ' on' : '') + '" data-kind="' + k + '">' +
      esc(KIND_LABEL[k]) + ' <span class="chip-n">' + counts[k] + '</span></button>'
    )).join('') || '<span class="pop-empty">This folder is empty</span>';

    const n = S.kinds.size;
    $('#kinds-n').textContent = n ? ' ' + n : '';
    $('#btn-kinds').classList.toggle('on', n > 0);
  }

  function crumbs() {
    const p = project();
    if (!p) return '';
    const base = (S.share && S.share.folderPath) || '';
    const rootLabel = base ? base.split('/').pop() : p.name;
    const parts = S.folder && S.folder !== base
      ? S.folder.slice(base ? base.length + 1 : 0).split('/')
      : [];
    let acc = base;
    const html = ['<button class="crumb' + (parts.length ? '' : ' last') + '" data-dir="' + esc(base) + '">' + esc(rootLabel) + '</button>'];
    parts.forEach((part, i) => {
      acc = acc ? acc + '/' + part : part;
      html.push('<span class="crumb-sep">' + icon('chev', 11) + '</span>');
      html.push('<button class="crumb' + (i === parts.length - 1 ? ' last' : '') + '" data-dir="' + esc(acc) + '">' + esc(part) + '</button>');
    });
    return html.join('');
  }

  function renderStage() {
    const files = compute();
    const stage = $('#stage');
    $('#crumbs').innerHTML = crumbs();

    const folders = childFolders();
    const scopeNote = S.folder ? ' in ' + S.folder.split('/').pop() : ' everywhere';
    $('#count').textContent = S.query.trim()
      ? files.length + ' match' + (files.length === 1 ? '' : 'es') + scopeNote
      : S.kinds.size
        ? files.length + ' file' + (files.length === 1 ? '' : 's') + scopeNote
        : files.length + ' file' + (files.length === 1 ? '' : 's') +
          (folders.length ? '  ·  ' + folders.length + ' folder' + (folders.length === 1 ? '' : 's') : '');

    if (!S.projects.length) {
      stage.innerHTML =
        '<div class="empty" style="padding-top:60px">' + icon('folder', 34) +
          '<h3>Your vault is empty</h3>' +
          '<p>Add your first project. Keep as many as you like — ' +
            'each one gets its own share link.</p>' +
          '<div class="start-cards">' +
            startCard('folder', 'A folder on this computer', 'Register any folder. Nothing is copied, ' +
              'and changes show up on their own.') +
            startCard('git', 'Clone a git repo', 'Paste a repo URL. New commits are ' +
              'pulled automatically.') +
            startCard('empty', 'Empty project', 'Create it, then drag in files or a whole folder.') +
          '</div>' +
        '</div>';
      return;
    }
    if (!files.length && !folders.length) {
      const guesses = S.query.trim() ? VaultSearch.didYouMean(visibleFiles(), S.query, 5) : [];
      stage.innerHTML = emptyState('search',
        S.query.trim() ? 'No matches for this search' : 'This folder is empty',
        S.query.trim() ? 'Try different words, or clear the filters.' : 'There are no files here.') +
        (guesses.length ? '<div class="sugg">' + guesses.map((g) =>
          '<button class="chip" data-sugg="' + esc(g) + '">' + esc(g) + '</button>').join('') + '</div>' : '');
      return;
    }

    stage.innerHTML = S.view === 'grid' ? gridHTML(folders, files) : listHTML(folders, files);
    hydrateThumbs(stage);
    // The cards are new elements, so the old cursor index means nothing. Keep
    // the position if it still exists, otherwise park it.
    if (S.cursor >= 0) setCursor(S.cursor);
  }

  function emptyState(ic, title, text) {
    return '<div class="empty">' + icon(ic, 30) + '<h3>' + esc(title) + '</h3><p>' + esc(text) + '</p></div>';
  }

  const START_ICON = { folder: 'folder', git: 'git', empty: 'upload' };
  function startCard(mode, title, text) {
    return '<button class="start-card" data-start="' + mode + '">' +
      '<span class="start-ic">' + icon(START_ICON[mode], 20) + '</span>' +
      '<span class="start-t">' + esc(title) + '</span>' +
      '<span class="start-d">' + esc(text) + '</span></button>';
  }

  /* A folder you can see into. The contents sit between the folder's back
   * panel and its front flap, so they read as things inside it rather than as
   * a collage pasted on top. */
  function folderCard(f) {
    let inside = '';
    if (f.peek.length) {
      inside = '<div class="fold-peek">' +
        f.peek.map((rel) => '<span class="pk" data-thumb="' + esc(rel) + '"></span>').join('') +
        '</div>';
    } else if (f.exts.length) {
      inside = '<div class="fold-peek">' +
        f.exts.map((e) => '<span class="pk pk-ext">' + esc(e) + '</span>').join('') +
        '</div>';
    }
    // A folder with nothing in it gets no peek at all: a closed folder is the
    // honest picture, and the count underneath already says it is empty.

    // One meta line, same as a file card, so the grid keeps an even rhythm.
    // A "Folder" tag was dropped: the tile is already shaped like one. The
    // subfolder names moved into the tooltip, where they inform without
    // turning every tile into a four-line paragraph.
    const subCount = f.subs.length;
    const meta = f.n + ' file' + (f.n === 1 ? '' : 's') +
      (subCount ? '  ·  ' + subCount + ' folder' + (subCount === 1 ? '' : 's') : '');
    const tip = f.path + (subCount ? '\n' + f.subs.join(', ') : '');

    return '<div class="card card-folder" data-folder="' + esc(f.path) + '" title="' + esc(tip) + '">' +
      '<div class="fold"><div class="fold-shape">' +
        '<span class="fold-back"></span>' +
        inside +
        '<span class="fold-front"></span>' +
      '</div></div>' +
      '<div class="card-body"><div class="card-name">' + esc(f.name) + '</div>' +
      '<div class="card-meta"><span>' + esc(meta) + '</span></div></div></div>';
  }

  function gridHTML(folders, files) {
    const cards = folders.map(folderCard);
    files.forEach((f, i) => {
      const sel = S.selection.has(f.p);
      cards.push(
        '<div class="card' + (sel ? ' sel' : '') + (isStarred(f.p) ? ' starred' : '') +
          '" data-file="' + esc(f.p) + '" data-i="' + i + '">' +
        '<div class="card-media' + (VISUAL.has(f.k) ? '' : ' plain') + '" data-thumb="' + esc(f.p) + '">' +
          placeholder(f) + '</div>' +
        '<div class="card-pick"><button class="mini' + (sel ? ' on' : '') + '" data-pick="' + esc(f.p) + '" title="Select">' +
          icon('check', 13) + '</button></div>' +
        '<div class="card-actions">' +
          (S.owner ? '<button class="mini' + (isStarred(f.p) ? ' on' : '') + '" data-star="' + esc(f.p) +
            '" title="Star (s)">' + icon('star', 13) + '</button>' : '') +
          '<button class="mini" data-dl="' + esc(f.p) + '" title="Download">' + icon('download', 13) + '</button>' +
        '</div>' +
        '<div class="card-body"><div class="card-name" title="' + esc(f.p) + '">' + esc(f.n) + '</div>' +
        '<div class="card-meta"><span class="tag k-' + f.k + '">' + esc(f.e || f.k) + '</span>' +
        '<span>' + bytes(f.s) + '</span>' +
        // While searching, results come from all over the tree, so the folder
        // is what tells two same-named files apart.
        (S.query && f.d ? '<span class="grow"></span><span class="row-sub" style="max-width:52%" title="' +
          esc(f.d) + '">' + esc(f.d.split('/').pop()) + '</span>' : '') +
        '</div></div></div>'
      );
    });
    return '<div class="grid">' + cards.join('') + '</div>';
  }

  /* A file with no thumbnail is drawn as a sheet of paper, at the same weight
   * as a folder. A 22px glyph adrift in a 216px tile read as an empty tile. */
  function placeholder(f) {
    return '<div class="ph">' + icon(f.k === 'video' ? 'play' : 'file', 30) +
      '<span class="ph-ext">' + esc(f.e || 'file') + '</span></div>';
  }

  function listHTML(folders, files) {
    const head = '<div class="list-head"><span></span><span></span><span>Name</span>' +
      '<span class="col-hide">Folder</span><span>Size</span><span class="col-hide">Modified</span><span></span></div>';
    const rows = folders.map((f) =>
      '<div class="row" data-folder="' + esc(f.path) + '"><span></span>' +
      '<span class="row-thumb" style="color:var(--accent)">' + icon('folder', 17) + '</span>' +
      '<span style="min-width:0"><div class="row-name">' + esc(f.name) + '</div>' +
      '<div class="row-sub">' + f.n + ' file' + (f.n === 1 ? '' : 's') +
        (f.subs.length ? ', ' + f.subs.length + ' folder' + (f.subs.length === 1 ? '' : 's') : '') +
        ' inside</div></span>' +
      '<span class="row-dim col-hide"></span><span class="row-dim"></span>' +
      '<span class="row-dim col-hide"></span><span></span></div>');

    files.forEach((f, i) => {
      const sel = S.selection.has(f.p);
      rows.push(
        '<div class="row' + (sel ? ' sel' : '') + (isStarred(f.p) ? ' starred' : '') +
          '" data-file="' + esc(f.p) + '" data-i="' + i + '">' +
        '<span><button class="tick' + (sel ? ' on' : '') + '" data-pick="' + esc(f.p) + '" aria-label="Select">' +
          icon('check', 11) + '</button></span>' +
        '<span class="row-thumb" data-thumb="' + esc(f.p) + '">' + icon('file', 15) + '</span>' +
        '<span style="min-width:0"><div class="row-name">' + esc(f.n) + '</div>' +
        (S.query ? '<div class="row-sub">' + esc(f.d || '/') + '</div>' : '') + '</span>' +
        '<span class="row-dim col-hide" title="' + esc(f.d) + '">' + esc((f.d || '/').split('/').pop()) + '</span>' +
        '<span class="row-dim">' + bytes(f.s) + '</span>' +
        '<span class="row-dim col-hide">' + when(f.m) + '</span>' +
        '<span class="row-acts">' +
        (S.owner ? '<button class="btn btn-ghost btn-sm btn-icon row-star' + (isStarred(f.p) ? ' on' : '') +
          '" data-star="' + esc(f.p) + '" title="Star (s)">' + icon('star', 14) + '</button>' : '') +
        '<button class="btn btn-ghost btn-sm btn-icon" data-dl="' + esc(f.p) + '">' +
        icon('download', 14) + '</button></span></div>'
      );
    });
    return '<div class="list">' + head + rows.join('') + '</div>';
  }

  /* ========================================================== thumbnails */

  const thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      loadThumb(e.target);
    }
  }, { rootMargin: '400px 0px' });

  function hydrateThumbs(root) {
    $$('[data-thumb]', root).forEach((el) => thumbObserver.observe(el));
  }

  function fileByPath(rel) {
    const p = project();
    return p ? p.files.find((f) => f.p === rel) : null;
  }

  function loadThumb(box) {
    const file = fileByPath(box.dataset.thumb);
    if (!file) return;
    // Ask for roughly what the box will actually show. A folder peek is a few
    // dozen pixels wide, so requesting a card-sized render wastes the work.
    const width = box.classList.contains('row-thumb') ? 96
      : box.classList.contains('pk') ? 160
      : 480;
    // No loading="lazy" here: on a detached <img> that defers the fetch
    // forever. The IntersectionObserver above is already the lazy loader.
    const img = new Image();
    img.decoding = 'async';
    img.alt = '';
    img.onload = () => { box.innerHTML = ''; box.appendChild(img); };
    // Bind to the project that owns this card, so a project switch mid-load
    // cannot send this file's path to a different project.
    const projectId = S.projectId;
    img.onerror = () => { clientThumb(file, box, img, projectId); };
    img.src = assetURL('/api/thumb', file, { w: width }, projectId);
  }

  /* Server could not rasterise it (PDF, .ai, video). Render in the browser,
   * show it, and post it back so nobody pays this cost twice. */
  let pdfLib = null;
  async function getPdfLib() {
    if (pdfLib) return pdfLib;
    pdfLib = await import('/vendor/pdf.min.mjs');
    pdfLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
    return pdfLib;
  }

  // Kinds the browser can actually rasterise. Anything else keeps its icon
  // instead of costing a wasted round trip per file.
  const CLIENT_RENDERABLE = (file) =>
    file.k === 'pdf' || file.k === 'video' || file.e === 'ai' || file.e === 'eps';

  const clientQueue = [];
  let clientBusy = 0;
  function clientThumb(file, box, img, projectId) {
    if (!CLIENT_RENDERABLE(file)) return;
    clientQueue.push({ file, box, img, projectId });
    pumpClientQueue();
  }
  function pumpClientQueue() {
    while (clientBusy < 2 && clientQueue.length) {
      const job = clientQueue.shift();
      clientBusy++;
      renderClientThumb(job).catch(() => {}).finally(() => { clientBusy--; pumpClientQueue(); });
    }
  }

  async function renderClientThumb({ file, box, img, projectId }) {
    const url = assetURL('/api/thumb', file, { w: 480 }, projectId);
    const head = await fetch(url, { headers: S.shareToken ? { 'X-Share-Token': S.shareToken } : {} });
    const key = head.headers.get('X-Thumb-Key');
    if (head.status !== 204 || !key) return;

    const src = assetURL('/api/file', file, null, projectId);
    let blob = null;
    if (file.k === 'pdf' || file.e === 'ai' || file.e === 'eps') blob = await pdfThumb(src);
    else if (file.k === 'video') blob = await videoThumb(src);
    if (!blob) return;

    const objectUrl = URL.createObjectURL(blob);
    img.onerror = null;
    img.onload = () => { box.innerHTML = ''; box.appendChild(img); URL.revokeObjectURL(objectUrl); };
    img.src = objectUrl;

    fetch('/api/thumb-cache?' + new URLSearchParams(Object.assign(
      { p: projectId, f: file.p, key }, S.shareToken ? { share: S.shareToken } : {})), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'image/webp' }, S.shareToken ? { 'X-Share-Token': S.shareToken } : {}),
      body: blob,
    }).catch(() => {});
  }

  async function pdfThumb(src) {
    const lib = await getPdfLib();
    const doc = await lib.getDocument({ url: src, withCredentials: true }).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(480 / base.width, 480 / base.height, 3) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    doc.destroy();
    return new Promise((r) => canvas.toBlob(r, 'image/webp', 0.8));
  }

  function videoThumb(src) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true; v.crossOrigin = 'use-credentials'; v.preload = 'metadata';
      const done = (blob) => { v.remove(); resolve(blob); };
      const fail = () => done(null);
      v.onerror = fail;
      v.onloadeddata = () => { try { v.currentTime = Math.min(1, (v.duration || 2) / 3); } catch { fail(); } };
      v.onseeked = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(480 / v.videoWidth, 480 / v.videoHeight, 1);
        canvas.width = Math.max(1, Math.round(v.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(v.videoHeight * scale));
        canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(done, 'image/webp', 0.8);
      };
      setTimeout(fail, 12000);
      v.src = src;
    });
  }

  /* ============================================================== viewer */

  let viewerIndex = -1;
  let viewerBg = localStorage.getItem('av.vbg') || 'checker';

  function openViewer(rel) {
    const idx = S.results.findIndex((f) => f.p === rel);
    if (idx < 0) return;
    viewerIndex = idx;
    pushNav();
    noteRecent(rel);
    // The Recent count in the sidebar just changed; without this it stays
    // stale until something else happens to trigger a render.
    renderSidebar();
    drawViewer();
  }

  function closeViewer() {
    viewerIndex = -1;
    const v = $('#viewer');
    v.classList.add('hidden');
    v.innerHTML = '';
    flushPendingRefresh();
  }

  function drawViewer() {
    const file = S.results[viewerIndex];
    if (!file) return closeViewer();
    const v = $('#viewer');
    v.classList.remove('hidden');
    const canDownload = S.owner || !S.share || S.share.allowDownload;
    const showSwatches = file.k === 'image' || file.k === 'vector';

    v.innerHTML =
      '<div class="v-stage" data-bg="' + esc(viewerBg) + '" id="v-stage">' +
        '<div class="v-top">' +
          '<button class="btn btn-sm v-back" id="v-back">' + icon('chev', 14) + ' Back</button>' +
          '<span class="v-title">' + esc(file.n) + '</span><span class="grow"></span>' +
          (showSwatches ? '<div class="bg-swatches">' + ['checker', 'white', 'cream', 'black', 'brand'].map((b) =>
            '<button class="sw' + (b === viewerBg ? ' on' : '') + '" data-bg="' + b + '" title="' + b + '" style="background:' +
            ({ checker: 'repeating-conic-gradient(#37373d 0% 25%,#27272b 0% 50%) 50%/8px 8px', white: '#fff', cream: '#dcd7cc', black: '#000', brand: '#eb2127' }[b]) +
            '"></button>').join('') + '</div>' : '') +
          (canDownload ? '<button class="btn btn-sm" id="v-dl">' + icon('download', 13) + ' Download</button>' : '') +
        '</div>' +
        (viewerIndex > 0 ? '<button class="v-nav prev" id="v-prev" style="transform:translateY(-50%) rotate(180deg)">' + icon('chev', 18) + '</button>' : '') +
        (viewerIndex < S.results.length - 1 ? '<button class="v-nav next" id="v-next">' + icon('chev', 18) + '</button>' : '') +
        '<div id="v-body" style="display:grid;place-items:center;width:100%">' + icon('refresh', 22) + '</div>' +
      '</div>' +
      '<aside class="v-side">' +
        '<div class="v-head">' +
          '<h3>' + esc(file.n) + '</h3>' +
          (S.owner ? '<button class="mini' + (isStarred(file.p) ? ' on' : '') + '" data-star="' + esc(file.p) +
            '" title="Star (s)">' + icon('star', 14) + '</button>' : '') +
          // Top-right corner of the whole viewer, where a close control belongs,
          // rather than floating in the middle of the layout.
          '<button class="btn btn-ghost btn-icon" id="v-close" title="Close (Esc)">' + icon('x', 16) + '</button>' +
        '</div>' +
        '<dl class="kv">' +
          '<dt>Type</dt><dd>' + esc(KIND_LABEL[file.k] || file.k) + ' (.' + esc(file.e) + ')</dd>' +
          '<dt>Size</dt><dd>' + bytes(file.s) + '</dd>' +
          '<dt id="v-dim-k" class="hidden">Dimensions</dt><dd id="v-dim-v" class="hidden"></dd>' +
          '<dt>Folder</dt><dd>' + esc(file.d || '/') + '</dd>' +
          '<dt>Modified</dt><dd>' + new Date(file.m).toLocaleString() + '</dd>' +
        '</dl>' +
        '<div class="v-acts">' +
          (canDownload ? '<button class="btn btn-primary btn-sm" id="v-dl2">' + icon('download', 13) + ' Download</button>' : '') +
          '<button class="btn btn-sm" id="v-open">' + icon('eye', 13) + ' New tab</button>' +
          (VISUAL.has(file.k) && file.k !== 'video'
            ? '<button class="btn btn-sm" id="v-copyimg">' + icon('copy', 13) + ' Copy image</button>' : '') +
          '<button class="btn btn-sm" id="v-copypath">' + icon('copy', 13) + ' Copy path</button>' +
          (S.owner ? '<button class="btn btn-sm btn-danger" id="v-del" title="Delete">' + icon('trash', 13) + '</button>' : '') +
        '</div>' +
        '<div id="v-palette" class="v-block hidden"></div>' +
        '<div id="v-history" class="v-block hidden"></div>' +
        '<div style="font-size:11.5px;color:var(--ink-3)">' + (viewerIndex + 1) + ' of ' + S.results.length + '</div>' +
      '</aside>';

    renderViewerBody(file);
    loadPalette(file);
    loadFileLog(file);
  }

  async function renderViewerBody(file) {
    const body = $('#v-body');
    if (!body) return;
    const src = assetURL('/api/file', file);

    if (file.k === 'image' || file.k === 'vector') {
      const img = new Image();
      img.src = src;
      img.alt = file.n;
      img.onload = () => {
        body.innerHTML = '';
        body.appendChild(img);
        showDimensions(img.naturalWidth, img.naturalHeight);
      };
      img.onerror = () => { body.innerHTML = fallbackBody(file); };
      return;
    }

    if (file.k === 'video') {
      body.innerHTML = '<video controls autoplay playsinline src="' + esc(src) + '"></video>';
      return;
    }
    if (file.k === 'audio') {
      body.innerHTML = '<audio controls autoplay style="width:min(520px,80vw)" src="' + esc(src) + '"></audio>';
      return;
    }
    if (file.k === 'pdf' || file.e === 'ai' || file.e === 'eps') {
      try { await pdfViewer(src, body); } catch { body.innerHTML = fallbackBody(file); }
      return;
    }
    if (file.e === 'html' || file.e === 'htm') {
      // Scripts on, same-origin off: the page renders the way it was built,
      // but lands in an opaque origin so it cannot reach the vault session.
      body.innerHTML = '<iframe sandbox="allow-scripts allow-popups allow-forms" src="' + esc(src) + '"></iframe>';
      return;
    }
    if (file.k === 'doc' || file.k === 'code') {
      try {
        const res = await fetch(src, { headers: S.shareToken ? { 'X-Share-Token': S.shareToken } : {} });
        const text = (await res.text()).slice(0, 400000);
        body.innerHTML = '<pre>' + esc(text) + '</pre>';
      } catch { body.innerHTML = fallbackBody(file); }
      return;
    }
    body.innerHTML = fallbackBody(file);
  }

  function showDimensions(w, h) {
    const dk = $('#v-dim-k');
    const dv = $('#v-dim-v');
    if (!dk || !dv || !w || !h) return;
    dv.textContent = w.toLocaleString() + ' x ' + h.toLocaleString() + ' px';
    dk.classList.remove('hidden');
    dv.classList.remove('hidden');
  }

  /**
   * The colours actually in the asset, as hex you can click and paste. This is
   * the question a brand folder gets asked most often, and answering it
   * otherwise means opening the file in a design tool and using a dropper.
   */
  async function loadPalette(file) {
    const box = $('#v-palette');
    if (!box) return;
    if (file.k !== 'image' && file.k !== 'vector') return;
    const forFile = file.p;
    let data;
    try {
      data = await api('/api/palette?' + new URLSearchParams({ p: S.projectId, f: file.p }));
    } catch {
      return;   // not readable as a picture; the panel simply stays away
    }
    // The reader may have moved on while sharp was working.
    if (!S.results[viewerIndex] || S.results[viewerIndex].p !== forFile) return;
    const target = $('#v-palette');
    if (!target) return;

    if (data.width && data.height) showDimensions(data.width, data.height);
    if (!data.colors || !data.colors.length) return;

    target.innerHTML = '<h4>Colours <span class="h4-note">exact pixel values</span></h4>' +
      '<div class="swatches">' +
      data.colors.map((c) => (
        '<button class="swatch" data-hex="' + esc(c.hex) + '" title="' + esc(c.hex) +
        ' — ' + c.share + '% of this image is exactly this colour. Click to copy.">' +
        '<span class="swatch-chip" style="background:' + esc(c.hex) + '"></span>' +
        '<span class="swatch-hex">' + esc(c.hex) + '</span>' +
        '<span class="swatch-share">' + c.share + '%</span></button>'
      )).join('') + '</div>';
    target.classList.remove('hidden');
  }

  /** What git knows about this one file, so "which version is this" has an answer. */
  async function loadFileLog(file) {
    const box = $('#v-history');
    if (!box || !S.owner) return;
    const forFile = file.p;
    let data;
    try {
      data = await api('/api/file-log?' + new URLSearchParams({ p: S.projectId, f: file.p }));
    } catch {
      return;
    }
    if (!data.ok || !data.commits || !data.commits.length) return;
    if (!S.results[viewerIndex] || S.results[viewerIndex].p !== forFile) return;
    const target = $('#v-history');
    if (!target) return;

    target.innerHTML = '<h4>History</h4>' + data.commits.map((c) => (
      '<div class="commit">' +
      '<button class="commit-hash" data-copy-hash="' + esc(c.hash) + '" title="Copy commit id">' + esc(c.hash) + '</button>' +
      '<div class="commit-body">' +
      '<div class="commit-subject">' + esc(c.subject || '(no message)') + '</div>' +
      '<div class="commit-meta">' + esc(c.author || '') + '  ·  ' +
      esc(new Date(c.date).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })) +
      '</div></div></div>'
    )).join('');
    target.classList.remove('hidden');
  }

  function fallbackBody(file) {
    return '<div class="empty">' + icon('file', 32) +
      '<h3>No preview available</h3>' +
      '<p>.' + esc(file.e) + ' can’t open in the browser. Download it to open in another app.</p></div>';
  }

  async function pdfViewer(src, body) {
    const lib = await getPdfLib();
    const doc = await lib.getDocument({ url: src, withCredentials: true }).promise;
    let page = 1;
    body.innerHTML = '<canvas id="pdfc"></canvas>' +
      (doc.numPages > 1 ? '<div class="pdf-pager" style="margin-top:12px">' +
        '<button class="btn btn-sm" id="pdf-prev">Prev</button>' +
        '<span id="pdf-lbl" style="font-size:12px"></span>' +
        '<button class="btn btn-sm" id="pdf-next">Next</button></div>' : '');

    async function draw() {
      const pg = await doc.getPage(page);
      const base = pg.getViewport({ scale: 1 });
      const maxW = Math.min(window.innerWidth - 400, 1100);
      const maxH = window.innerHeight - 160;
      const scale = Math.min(maxW / base.width, maxH / base.height, 2.5);
      const viewport = pg.getViewport({ scale });
      const canvas = $('#pdfc');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.maxWidth = '100%';
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pg.render({ canvasContext: ctx, viewport, canvas }).promise;
      const lbl = $('#pdf-lbl');
      if (lbl) lbl.textContent = page + ' / ' + doc.numPages;
    }
    await draw();
    const prev = $('#pdf-prev'); const next = $('#pdf-next');
    if (prev) prev.onclick = () => { if (page > 1) { page--; draw(); } };
    if (next) next.onclick = () => { if (page < doc.numPages) { page++; draw(); } };
  }

  /* =========================================================== selection */

  function toggleSelect(rel, index, shiftKey) {
    if (shiftKey && S.lastClickIndex >= 0 && index >= 0) {
      const [a, b] = [S.lastClickIndex, index].sort((x, y) => x - y);
      for (let i = a; i <= b; i++) S.selection.add(S.results[i].p);
    } else if (S.selection.has(rel)) {
      S.selection.delete(rel);
    } else {
      S.selection.add(rel);
    }
    if (index >= 0) S.lastClickIndex = index;
    syncSelection();
  }

  function syncSelection() {
    $$('[data-file]').forEach((el) => {
      const on = S.selection.has(el.dataset.file);
      el.classList.toggle('sel', on);
      const pick = $('[data-pick]', el);
      if (pick) pick.classList.toggle('on', on);
    });
    $('#sel-n').textContent = S.selection.size;
    $('#selbar').classList.toggle('hidden', S.selection.size === 0);
    $('#btn-selall').textContent = S.selection.size ? 'Clear' : 'Select all';
  }

  async function downloadSelection() {
    if (!S.selection.size) return;
    const body = { projectId: S.projectId, files: [...S.selection], name: (project() || {}).name };
    if (S.shareToken) body.share = S.shareToken;
    toast('Building the zip…');
    const res = await fetch('/api/zip', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, S.shareToken ? { 'X-Share-Token': S.shareToken } : {}),
      body: JSON.stringify(body),
    });
    if (!res.ok) { toast((await res.json().catch(() => ({}))).error || 'Zip fail hui', 'err'); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ((project() || {}).name || 'assets').replace(/\s+/g, '-').toLowerCase() + '.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ============================================================== modals */

  function modal(html, opts) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = '<div class="modal' + ((opts && opts.wide) ? ' wide' : '') + '">' + html + '</div>';
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    $('#modal-root').appendChild(back);
    function close() { back.remove(); document.removeEventListener('keydown', onKey); flushPendingRefresh(); }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKey);
    back.close = close;
    $$('[data-close]', back).forEach((b) => b.addEventListener('click', close));
    return back;
  }

  function head(title) {
    return '<div class="modal-head"><h2>' + esc(title) + '</h2><span class="grow"></span>' +
      '<button class="btn btn-ghost btn-icon" data-close>' + icon('x', 16) + '</button></div>';
  }

  /* ---- create share link */
  function shareModal(preFolder) {
    const p = project();
    if (!p) return;
    const folder = preFolder != null ? preFolder : S.folder;
    const folderOptions = ['', ...p.folders.filter((d) => !/(^|\/)previews$/i.test(d))]
      .map((d) => '<option value="' + esc(d) + '"' + (d === folder ? ' selected' : '') + '>' +
        (d ? esc(d) : 'Whole project (' + esc(p.name) + ')') + '</option>').join('');

    const m = modal(head('Create share link') +
      '<div class="modal-body">' +
        '<div class="field"><label>Project</label><select id="sh-proj">' +
          S.projects.map((x) => '<option value="' + esc(x.id) + '"' + (x.id === p.id ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') +
        '</select></div>' +
        '<div class="field"><label>Which folder to share</label><select id="sh-folder">' + folderOptions + '</select>' +
          '<span class="hint">The recipient sees only this folder, nothing else.</span></div>' +
        '<div class="field"><label>Link name</label><input type="text" id="sh-label" placeholder="e.g. Client review — brand assets"></div>' +
        '<div class="row2">' +
          '<div class="field"><label>Passcode</label><input type="text" id="sh-pass" placeholder="Blank = no passcode"></div>' +
          '<div class="field"><label>Expire (days)</label><input type="number" id="sh-exp" min="1" max="365" placeholder="Blank = never"></div>' +
        '</div>' +
        '<label class="switch"><input type="checkbox" id="sh-dl" checked><span class="track"></span>' +
          '<span>Allow downloads</span></label>' +
        '<div id="sh-out" class="hidden"></div>' +
      '</div>' +
      '<div class="modal-foot"><button class="btn" data-close>Cancel</button>' +
      '<button class="btn btn-primary" id="sh-go">Create link</button></div>');

    $('#sh-proj', m).addEventListener('change', (e) => {
      const np = S.projects.find((x) => x.id === e.target.value);
      $('#sh-folder', m).innerHTML = ['', ...np.folders.filter((d) => !/(^|\/)previews$/i.test(d))]
        .map((d) => '<option value="' + esc(d) + '">' + (d ? esc(d) : 'Whole project (' + esc(np.name) + ')') + '</option>').join('');
    });

    $('#sh-go', m).addEventListener('click', async () => {
      const folderPath = $('#sh-folder', m).value;
      try {
        const share = await api('/api/shares', { method: 'POST', body: {
          projectId: $('#sh-proj', m).value,
          folderPath,
          label: $('#sh-label', m).value || (folderPath ? folderPath.split('/').pop() : 'Shared project'),
          passcode: $('#sh-pass', m).value || null,
          expiresInDays: Number($('#sh-exp', m).value) || null,
          allowDownload: $('#sh-dl', m).checked,
        } });
        const url = location.origin + '/s/' + share.token;
        const out = $('#sh-out', m);
        out.className = 'field';
        out.innerHTML = '<label>Link taiyaar hai</label>' +
          '<div style="display:flex;gap:8px"><input type="text" id="sh-url" readonly value="' + esc(url) + '">' +
          '<button class="btn" id="sh-copy">' + icon('copy', 14) + ' Copy</button></div>' +
          '<span class="hint">This link works over the internet once a tunnel is running. It already works on your LAN.</span>';
        $('#sh-copy', m).addEventListener('click', () => {
          navigator.clipboard.writeText(url).then(() => toast('Link copied', 'ok'));
        });
        $('#sh-go', m).textContent = 'Create another';
        toast('Share link created', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  /* ---- manage share links */
  async function sharesModal() {
    let rows;
    try { rows = await api('/api/shares'); } catch (err) { return toast(err.message, 'err'); }
    const body = rows.length ? '<table class="tbl"><thead><tr><th>Link</th><th>Scope</th><th>Access</th><th>Views</th><th></th></tr></thead><tbody>' +
      rows.map((s) => {
        const url = location.origin + '/s/' + s.token;
        const state = s.expired ? '<span class="pill red">Expired</span>'
          : s.hasPasscode ? '<span class="pill green">Passcode</span>'
          : '<span class="pill grey">Open</span>';
        return '<tr><td><div style="font-weight:600">' + esc(s.label) + '</div>' +
          '<div class="link-cell"><code>' + esc(url) + '</code>' +
          '<button class="btn btn-ghost btn-sm btn-icon" data-copy="' + esc(url) + '">' + icon('copy', 13) + '</button></div></td>' +
          '<td><div>' + esc(s.projectName) + '</div><div style="color:var(--ink-3);font-size:11px">' +
          esc(s.folderPath || 'whole project') + '</div></td>' +
          '<td>' + state + (s.allowDownload ? '' : ' <span class="pill grey">No download</span>') +
          (s.expiresAt ? '<div style="color:var(--ink-3);font-size:11px">till ' + when(s.expiresAt) + '</div>' : '') + '</td>' +
          '<td>' + (s.views || 0) + '</td>' +
          '<td style="text-align:right"><button class="btn btn-ghost btn-sm btn-danger btn-icon" data-revoke="' + esc(s.token) + '">' +
          icon('trash', 14) + '</button></td></tr>';
      }).join('') + '</tbody></table>'
      : '<div class="empty">' + icon('share', 26) + '<h3>No links yet</h3>' +
        '<p>Open any folder and press “Share”.</p></div>';

    const m = modal(head('Share links') + '<div class="modal-body">' + body + '</div>' +
      '<div class="modal-foot"><button class="btn" data-close>Close</button>' +
      '<button class="btn btn-primary" id="sh-new">New link</button></div>', { wide: true });

    $('#sh-new', m).addEventListener('click', () => { m.close(); shareModal(); });
    m.addEventListener('click', async (e) => {
      const copy = e.target.closest('[data-copy]');
      if (copy) { navigator.clipboard.writeText(copy.dataset.copy); toast('Copied', 'ok'); return; }
      const rev = e.target.closest('[data-revoke]');
      if (rev && confirm('Revoke this link? Anyone you sent it to will lose access.')) {
        await api('/api/shares/' + rev.dataset.revoke, { method: 'DELETE' });
        m.close(); sharesModal();
      }
    });
  }

  /* ---- add a project: from disk, from a git URL, or empty for uploads */
  function addProjectModal(preset) {
    let mode = preset || 'folder';
    const m = modal(head('New project') +
      '<div class="tabs">' +
        '<button class="tab" data-mode="folder">Is PC ka folder</button>' +
        '<button class="tab" data-mode="git">Git repo</button>' +
        '<button class="tab" data-mode="empty">Empty (upload)</button>' +
      '</div>' +
      '<div class="modal-body" id="ap-body"></div>' +
      '<div class="modal-foot"><button class="btn" data-close>Cancel</button>' +
      '<button class="btn btn-primary" id="ap-go">Add</button></div>');

    const body = $('#ap-body', m);
    const go = $('#ap-go', m);

    function paint() {
      $$('.tab', m).forEach((t) => t.classList.toggle('on', t.dataset.mode === mode));
      if (mode === 'folder') {
        go.textContent = 'Add project';
        body.innerHTML =
          '<div class="field"><label>Full folder path</label>' +
            '<input type="text" id="ap-root" placeholder="C:\\Users\\You\\Desktop\\ClientProject" autofocus>' +
            '<span class="hint">Files aren’t copied. The vault reads straight from this folder, and ' +
            'picks up changes on its own. If it’s a git repo, git sync turns on too.</span></div>' +
          '<div class="field"><label>Project name (optional)</label>' +
            '<input type="text" id="ap-name" placeholder="defaults to the folder name"></div>';
      } else if (mode === 'git') {
        go.textContent = 'Clone';
        body.innerHTML =
          '<div class="field"><label>Repo URL</label>' +
            '<input type="text" id="ap-url" placeholder="https://github.com/user/repo.git" autofocus>' +
            '<span class="hint">The vault clones it into its own storage and keeps pulling new commits automatically.</span></div>' +
          '<div class="field"><label>Private repo ka token (optional)</label>' +
            '<input type="password" id="ap-token" placeholder="Leave blank for public repos">' +
            '<span class="hint">If your git is already signed in to GitHub, no token is needed. ' +
            'A token is saved into the clone’s remote URL (standard git behaviour) and never shown in the UI.</span></div>' +
          '<div class="row2">' +
            '<div class="field"><label>Branch</label><select id="ap-branch" disabled>' +
              '<option>URL check karne par bharenge</option></select></div>' +
            '<div class="field"><label>Project name</label><input type="text" id="ap-name" placeholder="defaults to the repo name"></div>' +
          '</div>' +
          '<button class="btn btn-sm" id="ap-check" style="align-self:flex-start">Check repo</button>' +
          '<div id="ap-probe" class="hint"></div>' +
          '<div id="ap-progress" class="hidden">' +
            '<div class="bar"><i style="width:0"></i></div>' +
            '<div class="hint" id="ap-plog" style="margin-top:6px;font-family:var(--mono);font-size:11px"></div>' +
          '</div>';
        $('#ap-check', m).addEventListener('click', probeRepo);
        $('#ap-url', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') probeRepo(); });
      } else {
        go.textContent = 'Create';
        body.innerHTML =
          '<div class="field"><label>Project name</label>' +
            '<input type="text" id="ap-name" placeholder="e.g. Acme Rebrand" autofocus></div>' +
          '<div class="hint">Creates an empty project. Then use Upload to add files or a whole folder ' +
            'by drag and drop. It lives in the vault’s own storage.</div>';
      }
    }

    async function probeRepo() {
      const url = ($('#ap-url', m).value || '').trim();
      const out = $('#ap-probe', m);
      if (!url) { out.textContent = 'Enter a URL first'; return null; }
      out.textContent = 'Checking…';
      try {
        const info = await api('/api/git/probe', { method: 'POST', body: { url, token: $('#ap-token', m).value || null } });
        const sel = $('#ap-branch', m);
        sel.disabled = false;
        sel.innerHTML = info.branches.map((b) =>
          '<option value="' + esc(b) + '"' + (b === info.defaultBranch ? ' selected' : '') + '>' + esc(b) + '</option>').join('');
        const nameField = $('#ap-name', m);
        if (!nameField.value) nameField.placeholder = info.suggestedName;
        out.style.color = 'var(--ok)';
        out.textContent = 'Found it. ' + info.branches.length + ' branch' + (info.branches.length === 1 ? '' : 'es') + '.';
        return info;
      } catch (err) {
        out.style.color = 'var(--danger)';
        out.textContent = err.message;
        return null;
      }
    }

    m.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-mode]');
      if (tab) { mode = tab.dataset.mode; paint(); }
    });

    go.addEventListener('click', async () => {
      const name = (($('#ap-name', m) || {}).value || '').trim();
      try {
        if (mode === 'git') return startClone(m, name);
        const root = mode === 'folder' ? (($('#ap-root', m).value || '').trim()) : null;
        if (mode === 'folder' && !root) return toast('Enter the folder path', 'err');
        if (mode === 'empty' && !name) return toast('Enter a name', 'err');
        const r = await api('/api/projects', {
          method: 'POST',
          body: { name: name || root.split(/[\\/]/).filter(Boolean).pop(), root },
        });
        m.close();
        await loadCatalog();
        S.projectId = r.id; S.folder = ''; S.openDirs.clear();
        renderAll();
        toast(r.isRepo ? 'Project added — git sync is on' : 'Project added', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });

    paint();
    return m;
  }

  /* Clone runs on the server; progress arrives over the same SSE stream. */
  let cloneJob = null;
  async function startClone(m, name) {
    const url = ($('#ap-url', m).value || '').trim();
    if (!url) return toast('Enter the repo URL', 'err');
    const branchSel = $('#ap-branch', m);
    const branch = branchSel && !branchSel.disabled ? branchSel.value : null;

    const progress = $('#ap-progress', m);
    const go = $('#ap-go', m);
    progress.classList.remove('hidden');
    go.disabled = true;
    go.textContent = 'Cloning';

    try {
      const job = await api('/api/projects/clone', {
        method: 'POST',
        body: { name, url, branch, token: $('#ap-token', m).value || null },
      });
      cloneJob = { id: job.jobId, modal: m };
    } catch (err) {
      progress.classList.add('hidden');
      go.disabled = false;
      go.textContent = 'Clone';
      toast(err.message, 'err');
    }
  }

  function onCloneProgress(data) {
    if (!cloneJob || data.jobId !== cloneJob.id) return;
    const m = cloneJob.modal;
    const bar = $('.bar > i', m);
    const log = $('#ap-plog', m);
    if (bar && data.percent != null) bar.style.width = data.percent + '%';
    if (log) log.textContent = data.line || data.phase || '';

    if (!data.done) return;
    const go = $('#ap-go', m);
    if (data.error) {
      if (go) { go.disabled = false; go.textContent = 'Try again'; }
      if (log) { log.style.color = 'var(--danger)'; log.textContent = data.error; }
      toast(data.error, 'err');
      cloneJob = null;
      return;
    }
    cloneJob = null;
    m.close();
    loadCatalog().then(() => {
      S.projectId = data.projectId; S.folder = ''; S.openDirs.clear();
      renderAll();
      toast('Cloned: ' + data.fileCount + ' files', 'ok');
    });
  }

  /* ---- projects */
  function projectsModal() {
    const rows = S.projects.map((p) =>
      '<tr><td><div style="display:flex;align-items:center;gap:8px">' +
      '<span class="proj-dot" style="background:' + esc(p.color) + '"></span><b>' + esc(p.name) + '</b>' +
      (p.missing ? ' <span class="pill red">folder missing</span>' : '') +
      (p.cloned ? ' <span class="pill green">git clone</span>' : p.managed ? ' <span class="pill grey">uploaded</span>' : '') + '</div>' +
      '<div style="color:var(--ink-3);font-size:11px;word-break:break-all">' + esc(p.root || '') + '</div></td>' +
      '<td>' + p.files.length + '</td><td>' + bytes(p.bytes) + '</td>' +
      '<td style="text-align:right"><button class="btn btn-ghost btn-sm btn-danger btn-icon" data-rmproj="' + esc(p.id) + '">' +
      icon('trash', 14) + '</button></td></tr>').join('');

    const m = modal(head('Projects') +
      '<div class="modal-body">' +
        (S.projects.length
          ? '<table class="tbl"><thead><tr><th>Project</th><th>Files</th><th>Size</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<div class="empty">' + icon('folder', 26) + '<h3>No projects yet</h3>' +
            '<p>Add a folder from your computer, or clone a git repo.</p></div>') +
      '</div>' +
      '<div class="modal-foot"><button class="btn" data-close>Close</button>' +
      '<button class="btn btn-primary" id="np-go">' + icon('plus', 14) + ' New project</button></div>', { wide: true });

    $('#np-go', m).addEventListener('click', () => { m.close(); addProjectModal(); });

    m.addEventListener('click', async (e) => {
      const rm = e.target.closest('[data-rmproj]');
      if (!rm) return;
      const p = S.projects.find((x) => x.id === rm.dataset.rmproj);
      const inVault = p.managed || p.cloned;
      const alsoFiles = inVault && confirm(
        p.cloned
          ? 'Also delete the cloned copy from disk? Cancel = remove from the list only.'
          : 'Also delete the uploaded files? Cancel = remove from the list only.');
      if (!inVault && !confirm('"' + p.name + '” from the vault? Your original folder is left untouched.')) return;
      await api('/api/projects/' + p.id + (alsoFiles ? '?files=1' : ''), { method: 'DELETE' });
      m.close();
      S.projectId = null;
      await loadCatalog();
      toast('Removed', 'ok');
    });
  }

  /* ---- upload */
  function uploadModal() {
    const p = project();
    if (!p) return toast('Create a project first', 'err');
    const m = modal(head('Upload to ' + p.name) +
      '<div class="modal-body">' +
        '<div class="field"><label>Kis folder me</label><select id="up-folder">' +
          ['', ...p.folders].map((d) => '<option value="' + esc(d) + '"' + (d === S.folder ? ' selected' : '') + '>' +
            (d ? esc(d) : '/ (root)') + '</option>').join('') + '</select></div>' +
        '<div class="drop" id="up-drop">' + icon('upload', 26) +
          '<div style="margin-top:8px">Drop files or a whole folder here</div>' +
          '<div style="margin-top:10px;display:flex;gap:8px;justify-content:center">' +
            '<button class="btn btn-sm" id="up-files">Choose files</button>' +
            '<button class="btn btn-sm" id="up-dir">Choose folder</button></div></div>' +
        '<div id="up-status" style="font-size:12.5px;color:var(--ink-3)"></div>' +
        '<div class="bar hidden" id="up-bar"><i style="width:0"></i></div>' +
      '</div>' +
      '<div class="modal-foot"><button class="btn" data-close>Close</button></div>');

    const drop = $('#up-drop', m);
    $('#up-files', m).addEventListener('click', () => pick($('#file-input')));
    $('#up-dir', m).addEventListener('click', () => pick($('#dir-input')));
    function pick(input) {
      input.value = '';
      input.onchange = () => send([...input.files]);
      input.click();
    }
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.add('hot');
    }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.remove('hot');
    }));
    drop.addEventListener('drop', async (e) => {
      const files = await filesFromDataTransfer(e.dataTransfer);
      send(files);
    });

    async function send(files) {
      if (!files.length) return;
      const fd = new FormData();
      for (const f of files) {
        const rel = f.webkitRelativePath || f._rel || f.name;
        fd.append(b64url(rel), f, f.name);
      }
      const bar = $('#up-bar', m);
      const status = $('#up-status', m);
      bar.classList.remove('hidden');
      status.textContent = files.length + ' files uploading…';

      const qs = new URLSearchParams({ p: S.projectId, folder: $('#up-folder', m).value });
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload?' + qs.toString());
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) $('i', bar).style.width = (e.loaded / e.total * 100) + '%';
      };
      xhr.onload = async () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          status.textContent = 'Done.';
          toast(files.length + ' files uploaded', 'ok');
          await loadCatalog();
        } else {
          status.textContent = 'Upload fail hua.';
          toast('Upload fail hua', 'err');
        }
      };
      xhr.onerror = () => toast('Upload fail hua', 'err');
      xhr.send(fd);
    }
  }

  function b64url(text) {
    return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** Walks a dropped directory so folder structure survives the upload. */
  async function filesFromDataTransfer(dt) {
    const out = [];
    const entries = [...dt.items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    if (!entries.length) return [...dt.files];
    async function walk(entry, prefix) {
      if (entry.isFile) {
        const file = await new Promise((r) => entry.file(r));
        file._rel = prefix + entry.name;
        out.push(file);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((r) => reader.readEntries(r));
          for (const child of batch) await walk(child, prefix + entry.name + '/');
        } while (batch.length);
      }
    }
    for (const e of entries) await walk(e, '');
    return out;
  }

  /* ---- settings */
  const THEME_FIELDS = [
    { key: 'accent', label: 'Accent', hint: 'Buttons, selection, links' },
    { key: 'folder', label: 'Folders', hint: 'Folder tiles' },
    { key: 'bg', label: 'Background', hint: 'Page behind everything' },
  ];

  /* Presets set the accent and folder colour; the page background is left to
   * follow whichever light/dark base is active, so a preset looks right in
   * both themes. */
  const THEME_PRESETS = [
    { name: 'Indigo', accent: '#5b61e6', folder: '#cdd3ef' },
    { name: 'Orange', accent: '#fb6530', folder: '#f0c983' },
    { name: 'Blue', accent: '#2f6bff', folder: '#cad7f0' },
    { name: 'Teal', accent: '#0ea5a5', folder: '#c2e7e4' },
    { name: 'Emerald', accent: '#12a06a', folder: '#cbe8d6' },
    { name: 'Violet', accent: '#8b5cf0', folder: '#ddd2f5' },
    { name: 'Rose', accent: '#e5436e', folder: '#f4d3dc' },
    { name: 'Graphite', accent: '#525a67', folder: '#d7dbe2' },
  ];

  /**
   * A small, real rendering of the app, drawn from the same CSS variables the
   * app itself uses. It needs no wiring: applyTheme() sets the variables on
   * :root, so this repaints with everything else.
   *
   * It exists because the Settings sheet covers the thing being themed — you
   * cannot judge a colour you cannot see.
   */
  function themePreview() {
    const folder = () =>
      '<span class="tp-folder"><span class="tp-tab"></span><span class="tp-body"></span></span>';
    return '<div class="theme-preview" aria-hidden="true">' +
      '<div class="tp-side">' +
        '<span class="tp-pill on"></span><span class="tp-pill"></span>' +
        '<span class="tp-row on"></span><span class="tp-row"></span><span class="tp-row"></span>' +
      '</div>' +
      '<div class="tp-main">' +
        '<div class="tp-bar"><span class="tp-input"></span><span class="tp-btn">Share</span></div>' +
        '<div class="tp-items">' + folder() + folder() + '<span class="tp-file"></span>' + '</div>' +
      '</div>' +
    '</div>';
  }

  /** What a picker should show: the owner's choice, or the live default. */
  function currentThemeColor(key) {
    if (S.theme && S.theme[key]) return S.theme[key];
    const css = getComputedStyle(document.documentElement);
    const fallback = {
      accent: css.getPropertyValue('--accent'),
      folder: css.getPropertyValue('--fold-back-lo'),
      bg: css.getPropertyValue('--bg'),
    }[key];
    const hex = String(fallback || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#000000';
  }

  function syncThemeInputs(root) {
    $$('[data-theme-key]', root).forEach((i) => { i.value = currentThemeColor(i.dataset.themeKey); });
  }

  /* Appearance: an explicit Light / Dark / System choice. "System" clears the
   * remembered value so the vault follows the device from then on. */
  function currentAppearance() { return localStorage.getItem('av.theme') || 'system'; }
  function applyAppearance(mode) {
    if (mode === 'system') {
      localStorage.removeItem('av.theme');
      document.documentElement.dataset.theme =
        (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    } else {
      localStorage.setItem('av.theme', mode);
      document.documentElement.dataset.theme = mode;
    }
  }

  function settingsModal() {
    const m = modal(head('Settings') +
      '<div class="modal-body">' +
        '<div class="field"><label>Vault name</label>' +
          '<div style="display:flex;gap:8px"><input type="text" id="st-name" value="' + esc(S.vaultName) + '">' +
          '<button class="btn" id="st-name-go">Save</button></div></div>' +
        (S.user
          ? '<div style="border-top:1px solid var(--line-soft);padding-top:14px" class="field">' +
              '<label>Your account</label>' +
              '<span class="hint">Signed in as <strong>' + esc(S.user.name) + '</strong> (' + esc(S.user.email) + ')' +
                (S.user.role === 'owner' ? ' &middot; vault owner' : '') + '</span>' +
              '<input type="password" id="st-pw-cur" placeholder="Current password" autocomplete="current-password">' +
              '<input type="password" id="st-pw-new" placeholder="New password (min 8)" autocomplete="new-password">' +
              '<button class="btn" id="st-pw-go" style="align-self:flex-start">Update password</button></div>'
          : '') +
        '<div style="border-top:1px solid var(--line-soft);padding-top:14px" class="field">' +
          '<label>Change passcode</label>' +
          '<span class="hint">The vault passcode unlocks the vault without an account, and invites new accounts.</span>' +
          '<input type="password" id="st-cur" placeholder="Current passcode" autocomplete="current-password">' +
          '<input type="password" id="st-new" placeholder="New passcode (min 4)" autocomplete="new-password">' +
          '<button class="btn" id="st-pass-go" style="align-self:flex-start">Update passcode</button></div>' +
        '<div style="border-top:1px solid var(--line-soft);padding-top:14px" class="field">' +
          '<label>Appearance</label>' +
          '<div class="seg-appear" id="st-appear">' +
            '<button data-appear="light">Light</button>' +
            '<button data-appear="dark">Dark</button>' +
            '<button data-appear="system">System</button>' +
          '</div>' +
          '<span class="hint">“System” follows your device. Your choice is remembered on this device.</span>' +
        '</div>' +
        '<div style="border-top:1px solid var(--line-soft);padding-top:14px" class="field">' +
          '<label>Colours</label>' +
          themePreview() +
          '<div class="swatch-picks">' +
            THEME_FIELDS.map((f) => (
              '<label class="pick">' +
                '<input type="color" data-theme-key="' + f.key + '" value="' + esc(currentThemeColor(f.key)) + '">' +
                '<span class="pick-name">' + esc(f.label) + '</span>' +
                '<span class="pick-hint">' + esc(f.hint) + '</span>' +
              '</label>'
            )).join('') +
          '</div>' +
          '<div class="preset-row">' +
            THEME_PRESETS.map((p, i) => (
              '<button class="preset" data-preset="' + i + '" title="' + esc(p.name) + '">' +
                '<span style="background:' + p.accent + '"></span>' +
                '<span style="background:' + p.folder + '"></span>' +
                esc(p.name) +
              '</button>'
            )).join('') +
          '</div>' +
          '<button class="btn btn-sm" id="st-theme-reset" style="align-self:flex-start">Reset to default colours</button>' +
          '<span class="hint">Colours are saved on the server, so every device and every share link shows the same look.</span>' +
        '</div>' +
        '<div style="border-top:1px solid var(--line-soft);padding-top:14px;display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="btn btn-sm" id="st-rescan">' + icon('refresh', 13) + ' Rescan everything</button>' +
          '<button class="btn btn-sm btn-danger" id="st-logout">Log out</button></div>' +
      '</div><div class="modal-foot"><button class="btn" data-close>Close</button></div>');

    // Live preview while dragging, saved when the picker is released.
    $$('[data-theme-key]', m).forEach((input) => {
      input.addEventListener('input', () => {
        applyTheme(Object.assign({}, S.theme, { [input.dataset.themeKey]: input.value }));
      });
      input.addEventListener('change', () => {
        saveTheme({ [input.dataset.themeKey]: input.value })
          .catch((err) => toast(err.message, 'err'));
      });
    });
    $$('[data-preset]', m).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const p = THEME_PRESETS[Number(btn.dataset.preset)];
        try {
          await saveTheme({ accent: p.accent, folder: p.folder, bg: null });
          syncThemeInputs(m);
          toast(p.name + ' applied', 'ok');
        } catch (err) { toast(err.message, 'err'); }
      });
    });
    $('#st-theme-reset', m).addEventListener('click', async () => {
      try {
        await saveTheme({ accent: null, folder: null, bg: null });
        syncThemeInputs(m);
        toast('Default colours restored', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });

    $('#st-name-go', m).addEventListener('click', async () => {
      const name = $('#st-name', m).value.trim();
      await api('/api/vault-name', { method: 'POST', body: { name } });
      S.vaultName = name; $('#vault-name').textContent = name; toast('Name saved', 'ok');
    });
    if (S.user) {
      $('#st-pw-go', m).addEventListener('click', async () => {
        try {
          await api('/api/auth/password', {
            method: 'POST',
            body: { current: $('#st-pw-cur', m).value, next: $('#st-pw-new', m).value },
          });
          toast('Password updated', 'ok');
          $('#st-pw-cur', m).value = ''; $('#st-pw-new', m).value = '';
        } catch (err) { toast(err.message, 'err'); }
      });
    }
    $('#st-pass-go', m).addEventListener('click', async () => {
      try {
        await api('/api/passcode', { method: 'POST', body: { current: $('#st-cur', m).value, next: $('#st-new', m).value } });
        toast('Passcode updated', 'ok');
        $('#st-cur', m).value = ''; $('#st-new', m).value = '';
      } catch (err) { toast(err.message, 'err'); }
    });
    const markAppear = () => $$('#st-appear button', m).forEach(
      (b) => b.classList.toggle('on', b.dataset.appear === currentAppearance()));
    markAppear();
    $('#st-appear', m).addEventListener('click', (e) => {
      const b = e.target.closest('[data-appear]');
      if (!b) return;
      applyAppearance(b.dataset.appear);
      markAppear();
    });

    $('#st-rescan', m).addEventListener('click', async () => { m.close(); await rescan(); });
    $('#st-logout', m).addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' });
      location.reload();
    });
  }

  async function rescan() {
    toast('Scanning…');
    try {
      await api('/api/rescan', { method: 'POST', body: {} });
      await loadCatalog({ keepScroll: true });
      await refreshGitState();
      toast('Index updated', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  /* ========================================================= live updates */

  /* The server pushes whenever the index moves, whether that came from a git
   * pull, your own commit, or a file dropped straight into the folder. */
  let stream = null;
  function openStream() {
    if (stream) stream.close();
    const url = '/api/events' + (S.shareToken ? '?share=' + encodeURIComponent(S.shareToken) : '');
    stream = new EventSource(url);

    stream.addEventListener('index', (e) => {
      const data = JSON.parse(e.data);
      if (data.projectId !== S.projectId) { refreshGitState(); return; }
      // Never yank the grid out from under an open preview.
      if (viewerIndex >= 0 || $('#modal-root').children.length) { S.pendingRefresh = true; return; }
      loadCatalog({ keepScroll: true }).then(() => {
        if (data.reason === 'git') return;   // the git event below reports it
        if (data.delta > 0) toast(data.delta + ' new file added', 'ok');
        else if (data.delta < 0) toast(Math.abs(data.delta) + ' file removed');
      });
    });

    stream.addEventListener('git', (e) => {
      const data = JSON.parse(e.data);
      refreshGitState();
      if (data.kind === 'pulled') {
        toast('GitHub: ' + data.commits + ' new commit' + (data.commits === 1 ? '' : 's') +
              (data.subject ? ' — ' + data.subject : ''), 'ok');
      } else if (data.kind === 'behind') {
        toast('GitHub pe ' + data.behind + ' new commits on the remote. Press Pull.');
      } else if (data.kind === 'blocked') {
        toast(data.message, 'err');
      }
    });

    stream.addEventListener('clone', (e) => onCloneProgress(JSON.parse(e.data)));

    stream.onerror = () => { /* EventSource retries on its own */ };
  }

  function flushPendingRefresh() {
    if (!S.pendingRefresh) return;
    S.pendingRefresh = false;
    loadCatalog({ keepScroll: true }).catch(() => {});
  }

  /* ============================================================== events */

  $('#lock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = $('#lock-pass').value;
    const msg = $('#lock-msg');
    msg.textContent = ''; msg.className = 'msg';
    try {
      if (S.shareToken) { await unlockShare(pass); }
      else {
        const r = await api('/api/login', { method: 'POST', body: { passcode: pass } });
        S.owner = true;
        const sess = await api('/api/session');
        S.vaultName = sess.vaultName;
        await enter(Object.assign(sess, { passcodeIsDefault: r.passcodeIsDefault }));
      }
    } catch (err) {
      msg.textContent = err.message; msg.className = 'msg err';
      $('#lock-pass').select();
    }
  });

  let searchTimer;
  $('#q').addEventListener('input', (e) => {
    S.query = e.target.value;
    $('#clearq').classList.toggle('hidden', !S.query);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { S.selection.clear(); syncSelection(); renderStage(); }, 90);
  });
  $('#clearq').addEventListener('click', () => {
    $('#q').value = ''; S.query = ''; $('#clearq').classList.add('hidden'); renderStage();
  });
  $('#sort').addEventListener('change', (e) => { S.sort = e.target.value; renderStage(); });

  $('#v-grid').addEventListener('click', () => setView('grid'));
  $('#v-list').addEventListener('click', () => setView('list'));
  function setView(v) {
    S.view = v; localStorage.setItem('av.view', v);
    $('#v-grid').classList.toggle('on', v === 'grid');
    $('#v-list').classList.toggle('on', v === 'list');
    renderStage();
  }

  $('#sidebar').addEventListener('click', (e) => {
    // Order matters: a folder row lives inside the project block, so the more
    // specific targets have to be tested before [data-proj].
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const dir = toggle.dataset.toggle;
      if (S.openDirs.has(dir)) S.openDirs.delete(dir); else S.openDirs.add(dir);
      renderSidebar(); return;
    }
    const scope = e.target.closest('[data-scope]');
    if (scope) { setScope(scope.dataset.scope); return; }
    const dir = e.target.closest('[data-dir]');
    if (dir) { goFolder(dir.dataset.dir); return; }
    if (e.target.closest('#git-pull')) { gitSync(S.projectId); return; }
    if (e.target.closest('#git-open')) { gitModal(); return; }

    const proj = e.target.closest('[data-proj]');
    if (proj) {
      const id = proj.dataset.proj;
      // Clicking the project you are already in folds its whole folder list
      // away, the way a submenu closes when you tap its parent again.
      if (id === S.projectId) {
        if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id);
        renderSidebar(); return;
      }
      // Switching to a project always shows it opened.
      S.collapsed.delete(id);
      S.projectId = id; S.folder = ''; S.selection.clear(); S.openDirs.clear();
      S.cursor = -1;
      pushNav();
      renderAll(); syncSelection();
    }
  });

  /* ------------------------------------------------------ file-type popover */

  function toggleKindsPop(show) {
    const pop = $('#kinds-pop');
    const open = show === undefined ? pop.classList.contains('hidden') : show;
    pop.classList.toggle('hidden', !open);
  }

  $('#btn-kinds').addEventListener('click', (e) => { e.stopPropagation(); toggleKindsPop(); });
  $('#kinds-clear').addEventListener('click', () => { S.kinds.clear(); renderAll(); });
  $('#kinds-pop').addEventListener('click', (e) => {
    e.stopPropagation();
    const chip = e.target.closest('[data-kind]');
    if (!chip) return;
    const k = chip.dataset.kind;
    if (S.kinds.has(k)) S.kinds.delete(k); else S.kinds.add(k);
    renderAll();
  });
  // Anywhere else dismisses it.
  document.addEventListener('click', () => toggleKindsPop(false));

  function goFolder(dir) {
    if (dir === S.folder && S.scope === 'all') return;
    S.folder = dir;
    S.selection.clear();
    S.cursor = -1;
    pushNav();
    // Picking a folder is a statement about where you want to be, so drop out
    // of the project-wide views rather than showing a folder that filters to
    // nothing.
    S.scope = 'all';
    if (dir) {
      let acc = '';
      for (const part of dir.split('/')) { acc = acc ? acc + '/' + part : part; S.openDirs.add(acc); }
    }
    $('#sidebar').classList.remove('open');
    renderAll(); syncSelection();
    $('#stage').scrollTop = 0;
  }

  $('#crumbs').addEventListener('click', (e) => {
    const c = e.target.closest('[data-dir]');
    if (c) goFolder(c.dataset.dir);
  });

  $('#stage').addEventListener('click', (e) => {
    const start = e.target.closest('[data-start]');
    if (start) { addProjectModal(start.dataset.start); return; }
    const sugg = e.target.closest('[data-sugg]');
    if (sugg) { $('#q').value = sugg.dataset.sugg; $('#q').dispatchEvent(new Event('input')); return; }
    const folder = e.target.closest('[data-folder]');
    if (folder) { goFolder(folder.dataset.folder); return; }
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      e.stopPropagation();
      const host = pick.closest('[data-file]');
      toggleSelect(pick.dataset.pick, host ? Number(host.dataset.i) : -1, e.shiftKey);
      return;
    }
    const star = e.target.closest('[data-star]');
    if (star) { e.stopPropagation(); toggleStar(star.dataset.star); return; }
    const dl = e.target.closest('[data-dl]');
    if (dl) {
      e.stopPropagation();
      const file = fileByPath(dl.dataset.dl);
      if (file) window.location.href = assetURL('/api/file', file, { dl: '1' });
      return;
    }
    const card = e.target.closest('[data-file]');
    if (!card) return;
    // Clicking is also how you tell the keyboard where you are.
    const at = cards().indexOf(card);
    if (at >= 0) setCursor(at);
    if (e.metaKey || e.ctrlKey || e.shiftKey || S.selection.size) {
      toggleSelect(card.dataset.file, Number(card.dataset.i), e.shiftKey);
    } else {
      openViewer(card.dataset.file);
    }
  });

  $('#btn-selall').addEventListener('click', () => {
    if (S.selection.size) S.selection.clear();
    else S.results.forEach((f) => S.selection.add(f.p));
    syncSelection();
  });
  $('#sel-clear').addEventListener('click', () => { S.selection.clear(); syncSelection(); });
  $('#sel-download').addEventListener('click', downloadSelection);
  $('#sel-share').addEventListener('click', () => shareModal(S.folder));

  $('#btn-share').addEventListener('click', () => shareModal());
  $('#btn-shares').addEventListener('click', sharesModal);
  $('#btn-projects').addEventListener('click', () => addProjectModal());
  $('#btn-upload').addEventListener('click', uploadModal);
  $('#btn-rescan').addEventListener('click', rescan);
  $('#btn-settings').addEventListener('click', settingsModal);
  $('#btn-keys').addEventListener('click', shortcutsModal);
  $('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('av.theme', next);
  });

  $('#viewer').addEventListener('click', (e) => {
    if (e.target.closest('#v-back')) { history.back(); return; }
    if (e.target.id === 'v-close' || e.target.closest('#v-close')) return closeViewer();
    if (e.target.closest('#v-prev')) { viewerIndex--; return drawViewer(); }
    if (e.target.closest('#v-next')) { viewerIndex++; return drawViewer(); }
    const sw = e.target.closest('[data-bg]');
    if (sw && sw.classList.contains('sw')) {
      viewerBg = sw.dataset.bg; localStorage.setItem('av.vbg', viewerBg);
      $('#v-stage').dataset.bg = viewerBg;
      $$('.sw').forEach((x) => x.classList.toggle('on', x.dataset.bg === viewerBg));
      return;
    }
    const swatch = e.target.closest('[data-hex]');
    if (swatch) { copyText(swatch.dataset.hex, swatch.dataset.hex); return; }
    const hash = e.target.closest('[data-copy-hash]');
    if (hash) { copyText(hash.dataset.copyHash, 'Commit id'); return; }
    const star = e.target.closest('[data-star]');
    if (star) { toggleStar(star.dataset.star); return; }

    const file = S.results[viewerIndex];
    if (!file) return;
    if (e.target.closest('#v-copyimg')) { copyImage(file); return; }
    if (e.target.closest('#v-copypath')) { copyText(file.p, 'Path'); return; }
    if (e.target.closest('#v-dl') || e.target.closest('#v-dl2')) {
      window.location.href = assetURL('/api/file', file, { dl: '1' });
    }
    if (e.target.closest('#v-open')) window.open(assetURL('/api/file', file), '_blank');
    if (e.target.closest('#v-del')) {
      if (!confirm('"' + file.n + '” permanently? It will be removed from disk.')) return;
      api('/api/file?' + new URLSearchParams({ p: S.projectId, f: file.p }), { method: 'DELETE' })
        .then(() => { closeViewer(); return loadCatalog(); })
        .then(() => toast('Deleted', 'ok'))
        .catch((err) => toast(err.message, 'err'));
    }
  });

  /* ---------------------------------------------------- keyboard cursor */

  /* The cursor walks the cards as they are laid out, folders included, so
   * arrowing around matches what the eye sees rather than some parallel
   * ordering that skips half the grid. */
  const cards = () => $$('#stage .card, #stage .row');

  function setCursor(i) {
    const list = cards();
    if (!list.length) { S.cursor = -1; return; }
    S.cursor = Math.max(0, Math.min(list.length - 1, i));
    list.forEach((c, n) => c.classList.toggle('cursor', n === S.cursor));
    const el = list[S.cursor];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  /** Columns actually rendered, read off the grid rather than guessed. */
  function gridColumns() {
    const g = $('#stage .grid');
    if (!g || S.view !== 'grid') return 1;
    const cols = getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length;
    return Math.max(1, cols);
  }

  function moveCursor(delta) {
    if (!cards().length) return;
    setCursor(S.cursor < 0 ? 0 : S.cursor + delta);
  }

  function cursorCard() {
    return cards()[S.cursor] || null;
  }

  function activateCursor() {
    const el = cursorCard();
    if (!el) return;
    if (el.dataset.folder) goFolder(el.dataset.folder);
    else if (el.dataset.file) openViewer(el.dataset.file);
  }

  const SHORTCUTS = [
    ['/', 'Search'],
    ['Arrow keys', 'Move between items'],
    ['Enter', 'Open the item under the cursor'],
    ['Space', 'Select / deselect'],
    ['s', 'Star the item under the cursor'],
    ['g  /  l', 'Grid view / list view'],
    ['Ctrl+A', 'Select everything on screen'],
    ['Backspace', 'Go up one folder'],
    ['Esc', 'Close, or clear the selection'],
    ['?', 'This list'],
  ];

  function shortcutsModal() {
    modal(head('Keyboard shortcuts') +
      '<div class="modal-body"><table class="tbl keys">' +
      SHORTCUTS.map(([k, what]) =>
        '<tr><td><kbd>' + esc(k).replace(/ {2}\/ {2}/, '</kbd> / <kbd>') + '</kbd></td><td>' + esc(what) + '</td></tr>').join('') +
      '</table></div>');
  }

  document.addEventListener('keydown', (e) => {
    if ($('#lock').classList.contains('hidden') === false) return;
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);

    if (viewerIndex >= 0) {
      if (e.key === 'Escape') { e.preventDefault(); closeViewer(); }
      if (e.key === 'ArrowLeft' && viewerIndex > 0) { viewerIndex--; drawViewer(); }
      if (e.key === 'ArrowRight' && viewerIndex < S.results.length - 1) { viewerIndex++; drawViewer(); }
      if (e.key === 's' && S.owner) { const f = S.results[viewerIndex]; if (f) toggleStar(f.p); }
      return;
    }
    if (typing) {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    // A modal owns the keyboard while it is up. It closes itself on Escape and
    // runs its own teardown, so stay out of the way entirely.
    if ($('#modal-root').children.length) return;

    if (e.key === '/') { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
    if (e.key === '?') { e.preventDefault(); shortcutsModal(); return; }
    if (e.key === 'g') return setView('grid');
    if (e.key === 'l') return setView('list');

    if (e.key === 'ArrowRight') { e.preventDefault(); return moveCursor(S.view === 'grid' ? 1 : 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); return moveCursor(-1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); return moveCursor(gridColumns()); }
    if (e.key === 'ArrowUp') { e.preventDefault(); return moveCursor(-gridColumns()); }
    if (e.key === 'Home') { e.preventDefault(); return setCursor(0); }
    if (e.key === 'End') { e.preventDefault(); return setCursor(cards().length - 1); }
    if (e.key === 'Enter') { e.preventDefault(); return activateCursor(); }
    if (e.key === 'Backspace' && S.folder) {
      e.preventDefault();
      return goFolder(S.folder.split('/').slice(0, -1).join('/'));
    }
    if (e.key === ' ') {
      const el = cursorCard();
      if (el && el.dataset.file) {
        e.preventDefault();
        toggleSelect(el.dataset.file, Number(el.dataset.i), false);
      }
      return;
    }
    if (e.key === 's' && S.owner) {
      const el = cursorCard();
      if (el && el.dataset.file) { e.preventDefault(); toggleStar(el.dataset.file); }
      return;
    }
    if (e.key === 'Escape' && S.selection.size) { S.selection.clear(); syncSelection(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault(); S.results.forEach((f) => S.selection.add(f.p)); syncSelection();
    }
  });

  // Drag a folder anywhere onto the app to upload it.
  window.addEventListener('dragover', (e) => { if (S.owner) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!S.owner || $('#modal-root').children.length) return;
    if (!e.dataTransfer || !e.dataTransfer.items.length) return;
    e.preventDefault();
    uploadModal();
    toast('Upload panel open — drop files here');
  });

  boot().catch((err) => {
    console.error('[vault] boot failed', err);
    $('#lock-msg').textContent = err.message;
    $('#lock-msg').className = 'msg err';
  });
})();
