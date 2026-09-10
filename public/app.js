/* Asset Vault client. Vanilla, no build step. */
(function () {
  'use strict';

  /* ================================================================ state */

  const S = {
    owner: false,
    vaultName: 'Asset Vault',
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
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

  // Kinds that end up with an actual picture on the card, so they get the
  // checkerboard plate. Everything else gets a flat panel and an icon.
  const VISUAL = new Set(['image', 'vector', 'pdf', 'design', 'video']);

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

  /* ============================================================= boot */

  async function boot() {
    document.documentElement.dataset.theme = localStorage.getItem('av.theme') || 'dark';
    const shareMatch = location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)/);

    if (shareMatch) {
      S.shareToken = shareMatch[1];
      try {
        const info = await api('/api/share/' + S.shareToken);
        $('#lock-title').textContent = info.label || 'Shared folder';
        $('#lock-sub').innerHTML = 'From <strong>' + esc(info.projectName) + '</strong>' +
          (info.hasPasscode ? '. Passcode daaliye.' : '. Koi passcode nahi chahiye.');
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
    $('#lock').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#vault-name').textContent = sess.vaultName || S.vaultName;
    document.title = (sess.vaultName || S.vaultName) + ' - Asset Vault';
    if (!S.owner) $$('.owner-only').forEach((el) => el.classList.add('hidden'));
    await loadCatalog();
    openStream();
    if (sess.passcodeIsDefault) {
      toast('Ye auto-generated passcode hai. Settings me jaake apna set kar lijiye.', 'err');
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

  const isDeep = () => !!(S.query.trim() || S.kinds.size);

  /** Immediate subfolders of the current folder, with their file counts. */
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
      out.set(dir, 0);
    }
    for (const f of visibleFiles()) {
      for (const dir of out.keys()) {
        if (f.p.startsWith(dir + '/')) out.set(dir, out.get(dir) + 1);
      }
    }
    return [...out.entries()]
      .map(([path, n]) => ({ path, name: path.split('/').pop(), n }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function compute() {
    let files = inScope(visibleFiles(), isDeep());
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
    else if (!S.query.trim()) ranked.sort(sorters.name);

    S.results = ranked.map((r) => r.file);
    return S.results;
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
    if (s < 60) return 'abhi';
    if (s < 3600) return Math.round(s / 60) + 'm pehle';
    if (s < 86400) return Math.round(s / 3600) + 'h pehle';
    return Math.round(s / 86400) + 'd pehle';
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
    const cls = g.lastError || blocked ? 'problem' : behind > 0 ? 'behind' : '';
    const dot = g.lastError ? 'bad' : behind > 0 ? 'warn' : '';

    let state;
    if (g.lastError) state = 'sync ruka hua hai';
    else if (behind > 0) state = behind + ' naye commit' + (behind === 1 ? '' : 's');
    else if (g.ahead > 0) state = g.ahead + ' commit push hone baaki';
    else state = 'up to date';

    const auto = (g.settings && g.settings.autoPull) !== false;

    box.innerHTML =
      '<div class="git-box ' + cls + '">' +
        '<div class="git-top">' +
          '<span style="color:var(--ink-3)">' + icon('git', 13) + '</span>' +
          '<span class="git-branch">' + esc(g.branch || 'detached') + '</span>' +
          '<span class="git-dot ' + dot + '"></span>' +
          '<span class="git-state' + (behind > 0 ? ' hot' : '') + '">' + esc(state) + '</span>' +
        '</div>' +
        (g.lastCommit
          ? '<div class="git-msg" title="' + esc(g.lastCommit.subject) + '">' + esc(g.lastCommit.subject) + '</div>'
          : '') +
        '<div class="git-sub">' +
          (dirty ? dirty + ' local change' + (dirty === 1 ? '' : 's') + ' · ' : '') +
          'checked ' + esc(ago(g.checkedAt || g.lastFetchAt)) +
        '</div>' +
        (g.lastError ? '<div class="git-sub" style="color:#ff7a7a">' + esc(g.lastError) + '</div>' : '') +
        (blocked
          ? '<div class="git-sub" style="color:var(--accent-2)">Uncommitted changes hain, isliye auto pull ruka hai.</div>'
          : '') +
        '<div class="git-acts">' +
          '<button class="btn btn-sm' + (behind > 0 ? ' btn-primary' : '') + '" id="git-pull">' +
            icon('cloud-down', 13) + (behind > 0 ? ' Pull ' + behind : ' Check now') + '</button>' +
          '<label class="switch mini-switch" title="Naye commits apne aap pull karein">' +
            '<input type="checkbox" id="git-auto"' + (auto ? ' checked' : '') + '>' +
            '<span class="track"></span><span>Auto</span></label>' +
        '</div>' +
      '</div>';
  }

  async function gitSync(projectId) {
    const btn = $('#git-pull');
    if (btn) { btn.disabled = true; btn.innerHTML = icon('refresh', 13) + ' Checking'; }
    try {
      const r = await api('/api/git/sync/' + projectId, { method: 'POST', body: {} });
      if (r.changed) toast('GitHub se update aa gaya', 'ok');
      else toast('Pehle se up to date hai', 'ok');
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
    $('#tree').classList.toggle('hidden', bare);
    $('#kind-chips').classList.toggle('hidden', bare);
    $('.side-foot').classList.toggle('hidden', bare && !S.owner);
    if (S.projects.length <= 1 && !S.owner) {
      $('#proj-section').classList.add('hidden');
    } else {
      $('#proj-section').classList.remove('hidden');
      list.innerHTML = S.projects.map((p) => (
        '<button class="proj' + (p.id === S.projectId ? ' on' : '') + (p.missing ? ' missing' : '') +
        '" data-proj="' + esc(p.id) + '">' +
        '<span class="proj-dot" style="background:' + esc(p.color || '#eb2127') + '"></span>' +
        '<span class="proj-name">' + esc(p.name) + '</span>' +
        '<span class="proj-count">' + p.files.length + '</span></button>'
      )).join('');
    }

    renderTree();

    const counts = kindCounts();
    const order = ['image', 'vector', 'design', 'pdf', 'video', 'doc', 'font', 'audio', 'archive', 'code', 'other'];
    $('#kind-chips').innerHTML = order.filter((k) => counts[k]).map((k) => (
      '<button class="chip' + (S.kinds.has(k) ? ' on' : '') + '" data-kind="' + k + '">' +
      esc(KIND_LABEL[k]) + ' <span class="chip-n">' + counts[k] + '</span></button>'
    )).join('') || '<span class="hint" style="padding:0 6px;color:var(--ink-3);font-size:11.5px">Kuch nahi mila</span>';

    const p = project();
    $('#stats').textContent = p ? p.files.length + ' files  ·  ' + bytes(p.bytes) : '';
    $('#vault-sub').textContent = S.owner ? 'Owner access' : 'Shared with you';
  }

  function renderTree() {
    const p = project();
    const box = $('#tree');
    if (!p) { box.innerHTML = ''; return; }

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
    rows.push(row('', base ? base.split('/').pop() : p.name, p.files.length, 0, false, true));
    for (const dir of dirs) {
      if (dir === base) continue;
      const parts = dir.split('/');
      const depth = parts.length - baseDepth;
      const parent = parts.slice(0, -1).join('/');
      if (parent && parent !== base && !S.openDirs.has(parent)) continue;
      const hasKids = dirs.some((d) => d.startsWith(dir + '/'));
      rows.push(row(dir, parts[parts.length - 1], counts.get(dir) || 0, depth, hasKids, false));
    }
    box.innerHTML = rows.join('');

    function row(path, label, n, depth, hasKids, isRoot) {
      const open = S.openDirs.has(path);
      return '<button class="tree-row' + (S.folder === path ? ' on' : '') + '" data-dir="' + esc(path) + '"' +
        ' style="padding-left:' + (8 + depth * 12) + 'px">' +
        '<span class="tree-caret' + (hasKids ? (open ? ' open' : '') : ' leaf') + '"' +
        (hasKids ? ' data-toggle="' + esc(path) + '"' : '') + '>' + icon('chev', 11) + '</span>' +
        (isRoot ? icon('folder', 13) + ' ' : '') +
        '<span class="tree-label">' + esc(label) + '</span>' +
        '<span class="tree-n">' + n + '</span></button>';
    }
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
          '<h3>Vault khaali hai</h3>' +
          '<p>Apna pehla project add kijiye. Kitne bhi project rakh sakti hain, ' +
            'har ek ka apna share link banega.</p>' +
          '<div class="start-cards">' +
            startCard('folder', 'Is PC ka folder', 'Koi bhi folder register kijiye. Copy nahi hoga, ' +
              'aur badlav apne aap dikhte rahenge.') +
            startCard('git', 'Git repo se clone', 'Repo ka URL paste kijiye. Naye commits apne aap ' +
              'pull hote rahenge.') +
            startCard('empty', 'Khaali project', 'Banaake browser se files ya folder drag-drop kar dijiye.') +
          '</div>' +
        '</div>';
      return;
    }
    if (!files.length && !folders.length) {
      const guesses = S.query.trim() ? VaultSearch.didYouMean(visibleFiles(), S.query, 5) : [];
      stage.innerHTML = emptyState('search',
        S.query.trim() ? 'Is search pe kuch nahi mila' : 'Ye folder khaali hai',
        S.query.trim() ? 'Doosre shabd try kijiye, ya filters hata dijiye.' : 'Yahan koi file nahi hai.') +
        (guesses.length ? '<div class="sugg">' + guesses.map((g) =>
          '<button class="chip" data-sugg="' + esc(g) + '">' + esc(g) + '</button>').join('') + '</div>' : '');
      return;
    }

    stage.innerHTML = S.view === 'grid' ? gridHTML(folders, files) : listHTML(folders, files);
    hydrateThumbs(stage);
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

  function folderCard(f) {
    return '<div class="card" data-folder="' + esc(f.path) + '">' +
      '<div class="card-media plain">' +
      '<div class="ph" style="color:var(--accent)">' + icon('folder', 34) + '</div></div>' +
      '<div class="card-body"><div class="card-name">' + esc(f.name) + '</div>' +
      '<div class="card-meta"><span class="tag">Folder</span><span>' + f.n + ' files</span></div></div></div>';
  }

  function gridHTML(folders, files) {
    const cards = folders.map(folderCard);
    files.forEach((f, i) => {
      const sel = S.selection.has(f.p);
      cards.push(
        '<div class="card' + (sel ? ' sel' : '') + '" data-file="' + esc(f.p) + '" data-i="' + i + '">' +
        '<div class="card-media' + (VISUAL.has(f.k) ? '' : ' plain') + '" data-thumb="' + esc(f.p) + '">' +
          placeholder(f) + '</div>' +
        '<div class="card-pick"><button class="mini' + (sel ? ' on' : '') + '" data-pick="' + esc(f.p) + '" title="Select">' +
          icon('check', 13) + '</button></div>' +
        '<div class="card-actions">' +
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

  function placeholder(f) {
    return '<div class="ph">' + icon(f.k === 'video' ? 'play' : 'file', 22) +
      '<span class="ph-ext">' + esc(f.e || 'file') + '</span></div>';
  }

  function listHTML(folders, files) {
    const head = '<div class="list-head"><span></span><span></span><span>Name</span>' +
      '<span class="col-hide">Folder</span><span>Size</span><span class="col-hide">Modified</span><span></span></div>';
    const rows = folders.map((f) =>
      '<div class="row" data-folder="' + esc(f.path) + '"><span></span>' +
      '<span class="row-thumb" style="color:var(--accent)">' + icon('folder', 17) + '</span>' +
      '<span style="min-width:0"><div class="row-name">' + esc(f.name) + '</div>' +
      '<div class="row-sub">' + f.n + ' file' + (f.n === 1 ? '' : 's') + ' inside</div></span>' +
      '<span class="row-dim col-hide"></span><span class="row-dim"></span>' +
      '<span class="row-dim col-hide"></span><span></span></div>');

    files.forEach((f, i) => {
      const sel = S.selection.has(f.p);
      rows.push(
        '<div class="row' + (sel ? ' sel' : '') + '" data-file="' + esc(f.p) + '" data-i="' + i + '">' +
        '<span><button class="tick' + (sel ? ' on' : '') + '" data-pick="' + esc(f.p) + '" aria-label="Select">' +
          icon('check', 11) + '</button></span>' +
        '<span class="row-thumb" data-thumb="' + esc(f.p) + '">' + icon('file', 15) + '</span>' +
        '<span style="min-width:0"><div class="row-name">' + esc(f.n) + '</div>' +
        (S.query ? '<div class="row-sub">' + esc(f.d || '/') + '</div>' : '') + '</span>' +
        '<span class="row-dim col-hide" title="' + esc(f.d) + '">' + esc((f.d || '/').split('/').pop()) + '</span>' +
        '<span class="row-dim">' + bytes(f.s) + '</span>' +
        '<span class="row-dim col-hide">' + when(f.m) + '</span>' +
        '<span class="row-acts"><button class="btn btn-ghost btn-sm btn-icon" data-dl="' + esc(f.p) + '">' +
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
    const isRow = box.classList.contains('row-thumb');
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
    img.src = assetURL('/api/thumb', file, { w: isRow ? 96 : 480 }, projectId);
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
          '<span class="v-title">' + esc(file.n) + '</span><span class="grow"></span>' +
          (showSwatches ? '<div class="bg-swatches">' + ['checker', 'white', 'cream', 'black', 'brand'].map((b) =>
            '<button class="sw' + (b === viewerBg ? ' on' : '') + '" data-bg="' + b + '" title="' + b + '" style="background:' +
            ({ checker: 'repeating-conic-gradient(#3a3330 0% 25%,#26211f 0% 50%) 50%/8px 8px', white: '#fff', cream: '#dcd7cc', black: '#000', brand: '#eb2127' }[b]) +
            '"></button>').join('') + '</div>' : '') +
          (canDownload ? '<button class="btn btn-sm" id="v-dl">' + icon('download', 13) + ' Download</button>' : '') +
          '<button class="btn btn-ghost btn-icon" id="v-close">' + icon('x', 17) + '</button>' +
        '</div>' +
        (viewerIndex > 0 ? '<button class="v-nav prev" id="v-prev" style="transform:translateY(-50%) rotate(180deg)">' + icon('chev', 18) + '</button>' : '') +
        (viewerIndex < S.results.length - 1 ? '<button class="v-nav next" id="v-next">' + icon('chev', 18) + '</button>' : '') +
        '<div id="v-body" style="display:grid;place-items:center;width:100%">' + icon('refresh', 22) + '</div>' +
      '</div>' +
      '<aside class="v-side">' +
        '<h3>' + esc(file.n) + '</h3>' +
        '<dl class="kv">' +
          '<dt>Type</dt><dd>' + esc(KIND_LABEL[file.k] || file.k) + ' (.' + esc(file.e) + ')</dd>' +
          '<dt>Size</dt><dd>' + bytes(file.s) + '</dd>' +
          '<dt>Folder</dt><dd>' + esc(file.d || '/') + '</dd>' +
          '<dt>Modified</dt><dd>' + new Date(file.m).toLocaleString() + '</dd>' +
          '<dd id="v-dim-k" class="hidden"></dd><dd id="v-dim-v" class="hidden"></dd>' +
        '</dl>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          (canDownload ? '<button class="btn btn-primary btn-sm" id="v-dl2">' + icon('download', 13) + ' Download</button>' : '') +
          '<button class="btn btn-sm" id="v-open">' + icon('eye', 13) + ' New tab</button>' +
          (S.owner ? '<button class="btn btn-sm btn-danger" id="v-del">' + icon('trash', 13) + '</button>' : '') +
        '</div>' +
        '<div style="font-size:11.5px;color:var(--ink-3)">' + (viewerIndex + 1) + ' of ' + S.results.length + '</div>' +
      '</aside>';

    renderViewerBody(file);
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
        const dk = $('#v-dim-k'); const dv = $('#v-dim-v');
        if (dk) {
          dk.textContent = 'Dimensions'; dk.className = '';
          dk.style.color = 'var(--ink-3)';
          dv.textContent = img.naturalWidth + ' x ' + img.naturalHeight + ' px';
          dv.className = '';
        }
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

  function fallbackBody(file) {
    return '<div class="empty">' + icon('file', 32) +
      '<h3>Preview available nahi hai</h3>' +
      '<p>.' + esc(file.e) + ' browser me nahi khulta. Download karke apne app me kholiye.</p></div>';
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
    toast('Zip ban rahi hai...');
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
        (d ? esc(d) : 'Poora project (' + esc(p.name) + ')') + '</option>').join('');

    const m = modal(head('Share link banayein') +
      '<div class="modal-body">' +
        '<div class="field"><label>Project</label><select id="sh-proj">' +
          S.projects.map((x) => '<option value="' + esc(x.id) + '"' + (x.id === p.id ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') +
        '</select></div>' +
        '<div class="field"><label>Kaunsa folder share karna hai</label><select id="sh-folder">' + folderOptions + '</select>' +
          '<span class="hint">Client ko sirf yahi folder dikhega, baaki kuch nahi.</span></div>' +
        '<div class="field"><label>Link ka naam</label><input type="text" id="sh-label" placeholder="jaise: Client review - stationery"></div>' +
        '<div class="row2">' +
          '<div class="field"><label>Passcode</label><input type="text" id="sh-pass" placeholder="Khaali = bina passcode"></div>' +
          '<div class="field"><label>Expire (days)</label><input type="number" id="sh-exp" min="1" max="365" placeholder="Khaali = kabhi nahi"></div>' +
        '</div>' +
        '<label class="switch"><input type="checkbox" id="sh-dl" checked><span class="track"></span>' +
          '<span>Download allow karein</span></label>' +
        '<div id="sh-out" class="hidden"></div>' +
      '</div>' +
      '<div class="modal-foot"><button class="btn" data-close>Cancel</button>' +
      '<button class="btn btn-primary" id="sh-go">Link banayein</button></div>');

    $('#sh-proj', m).addEventListener('change', (e) => {
      const np = S.projects.find((x) => x.id === e.target.value);
      $('#sh-folder', m).innerHTML = ['', ...np.folders.filter((d) => !/(^|\/)previews$/i.test(d))]
        .map((d) => '<option value="' + esc(d) + '">' + (d ? esc(d) : 'Poora project (' + esc(np.name) + ')') + '</option>').join('');
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
          '<span class="hint">Tunnel chalu hone par ye link internet pe kaam karega. LAN pe abhi bhi chalega.</span>';
        $('#sh-copy', m).addEventListener('click', () => {
          navigator.clipboard.writeText(url).then(() => toast('Link copy ho gaya', 'ok'));
        });
        $('#sh-go', m).textContent = 'Ek aur banayein';
        toast('Share link ban gaya', 'ok');
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
      : '<div class="empty">' + icon('share', 26) + '<h3>Abhi koi link nahi hai</h3>' +
        '<p>Kisi bhi folder pe jaake "Share" dabaayiye.</p></div>';

    const m = modal(head('Share links') + '<div class="modal-body">' + body + '</div>' +
      '<div class="modal-foot"><button class="btn" data-close>Close</button>' +
      '<button class="btn btn-primary" id="sh-new">Naya link</button></div>', { wide: true });

    $('#sh-new', m).addEventListener('click', () => { m.close(); shareModal(); });
    m.addEventListener('click', async (e) => {
      const copy = e.target.closest('[data-copy]');
      if (copy) { navigator.clipboard.writeText(copy.dataset.copy); toast('Copy ho gaya', 'ok'); return; }
      const rev = e.target.closest('[data-revoke]');
      if (rev && confirm('Ye link band kar dein? Jisko bheja hai wo phir nahi khol payega.')) {
        await api('/api/shares/' + rev.dataset.revoke, { method: 'DELETE' });
        m.close(); sharesModal();
      }
    });
  }

  /* ---- add a project: from disk, from a git URL, or empty for uploads */
  function addProjectModal(preset) {
    let mode = preset || 'folder';
    const m = modal(head('Naya project') +
      '<div class="tabs">' +
        '<button class="tab" data-mode="folder">Is PC ka folder</button>' +
        '<button class="tab" data-mode="git">Git repo</button>' +
        '<button class="tab" data-mode="empty">Khaali (upload)</button>' +
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
          '<div class="field"><label>Folder ka poora path</label>' +
            '<input type="text" id="ap-root" placeholder="C:\\Users\\You\\Desktop\\ClientProject" autofocus>' +
            '<span class="hint">Files copy nahi hongi. Vault seedha isi folder se padhega, aur ' +
            'badlav apne aap pick kar lega. Agar ye git repo hua to git sync bhi chalu ho jayega.</span></div>' +
          '<div class="field"><label>Project ka naam (optional)</label>' +
            '<input type="text" id="ap-name" placeholder="folder ke naam se le lenge"></div>';
      } else if (mode === 'git') {
        go.textContent = 'Clone karein';
        body.innerHTML =
          '<div class="field"><label>Repo URL</label>' +
            '<input type="text" id="ap-url" placeholder="https://github.com/user/repo.git" autofocus>' +
            '<span class="hint">Vault ise apne storage me clone karega aur naye commits apne aap pull karta rahega.</span></div>' +
          '<div class="field"><label>Private repo ka token (optional)</label>' +
            '<input type="password" id="ap-token" placeholder="Public repo ke liye khaali chhod dijiye">' +
            '<span class="hint">Agar aapke git me pehle se GitHub login hai to token ki zarurat nahi. ' +
            'Token diya to wo clone ke remote URL me save hoga (standard git behaviour), UI me kabhi nahi dikhega.</span></div>' +
          '<div class="row2">' +
            '<div class="field"><label>Branch</label><select id="ap-branch" disabled>' +
              '<option>URL check karne par bharenge</option></select></div>' +
            '<div class="field"><label>Project ka naam</label><input type="text" id="ap-name" placeholder="repo ke naam se"></div>' +
          '</div>' +
          '<button class="btn btn-sm" id="ap-check" style="align-self:flex-start">Repo check karein</button>' +
          '<div id="ap-probe" class="hint"></div>' +
          '<div id="ap-progress" class="hidden">' +
            '<div class="bar"><i style="width:0"></i></div>' +
            '<div class="hint" id="ap-plog" style="margin-top:6px;font-family:var(--mono);font-size:11px"></div>' +
          '</div>';
        $('#ap-check', m).addEventListener('click', probeRepo);
        $('#ap-url', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') probeRepo(); });
      } else {
        go.textContent = 'Banayein';
        body.innerHTML =
          '<div class="field"><label>Project ka naam</label>' +
            '<input type="text" id="ap-name" placeholder="jaise: Acme Rebrand" autofocus></div>' +
          '<div class="hint">Ek khaali project banega. Uske baad Upload se files ya poora folder ' +
            'drag-drop kar sakti hain. Ye vault ke apne storage me rahega.</div>';
      }
    }

    async function probeRepo() {
      const url = ($('#ap-url', m).value || '').trim();
      const out = $('#ap-probe', m);
      if (!url) { out.textContent = 'Pehle URL daaliye'; return null; }
      out.textContent = 'Check ho raha hai...';
      try {
        const info = await api('/api/git/probe', { method: 'POST', body: { url, token: $('#ap-token', m).value || null } });
        const sel = $('#ap-branch', m);
        sel.disabled = false;
        sel.innerHTML = info.branches.map((b) =>
          '<option value="' + esc(b) + '"' + (b === info.defaultBranch ? ' selected' : '') + '>' + esc(b) + '</option>').join('');
        const nameField = $('#ap-name', m);
        if (!nameField.value) nameField.placeholder = info.suggestedName;
        out.style.color = 'var(--ok)';
        out.textContent = 'Mil gaya. ' + info.branches.length + ' branch' + (info.branches.length === 1 ? '' : 'es') + '.';
        return info;
      } catch (err) {
        out.style.color = '#ff7a7a';
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
        if (mode === 'folder' && !root) return toast('Folder ka path daaliye', 'err');
        if (mode === 'empty' && !name) return toast('Naam daaliye', 'err');
        const r = await api('/api/projects', {
          method: 'POST',
          body: { name: name || root.split(/[\\/]/).filter(Boolean).pop(), root },
        });
        m.close();
        await loadCatalog();
        S.projectId = r.id; S.folder = ''; S.openDirs.clear();
        renderAll();
        toast(r.isRepo ? 'Project add ho gaya, git sync bhi chalu' : 'Project add ho gaya', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });

    paint();
    return m;
  }

  /* Clone runs on the server; progress arrives over the same SSE stream. */
  let cloneJob = null;
  async function startClone(m, name) {
    const url = ($('#ap-url', m).value || '').trim();
    if (!url) return toast('Repo URL daaliye', 'err');
    const branchSel = $('#ap-branch', m);
    const branch = branchSel && !branchSel.disabled ? branchSel.value : null;

    const progress = $('#ap-progress', m);
    const go = $('#ap-go', m);
    progress.classList.remove('hidden');
    go.disabled = true;
    go.textContent = 'Clone ho raha hai';

    try {
      const job = await api('/api/projects/clone', {
        method: 'POST',
        body: { name, url, branch, token: $('#ap-token', m).value || null },
      });
      cloneJob = { id: job.jobId, modal: m };
    } catch (err) {
      progress.classList.add('hidden');
      go.disabled = false;
      go.textContent = 'Clone karein';
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
      if (go) { go.disabled = false; go.textContent = 'Dobara try karein'; }
      if (log) { log.style.color = '#ff7a7a'; log.textContent = data.error; }
      toast(data.error, 'err');
      cloneJob = null;
      return;
    }
    cloneJob = null;
    m.close();
    loadCatalog().then(() => {
      S.projectId = data.projectId; S.folder = ''; S.openDirs.clear();
      renderAll();
      toast('Clone ho gaya: ' + data.fileCount + ' files', 'ok');
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
          : '<div class="empty">' + icon('folder', 26) + '<h3>Abhi koi project nahi hai</h3>' +
            '<p>Apne PC ka folder add kijiye, ya seedha koi git repo clone kar lijiye.</p></div>') +
      '</div>' +
      '<div class="modal-foot"><button class="btn" data-close>Close</button>' +
      '<button class="btn btn-primary" id="np-go">' + icon('plus', 14) + ' Naya project</button></div>', { wide: true });

    $('#np-go', m).addEventListener('click', () => { m.close(); addProjectModal(); });

    m.addEventListener('click', async (e) => {
      const rm = e.target.closest('[data-rmproj]');
      if (!rm) return;
      const p = S.projects.find((x) => x.id === rm.dataset.rmproj);
      const inVault = p.managed || p.cloned;
      const alsoFiles = inVault && confirm(
        p.cloned
          ? 'Cloned copy bhi disk se delete kar dein? Cancel = sirf list se hataayenge.'
          : 'Uploaded files bhi delete kar dein? Cancel = sirf list se hataayenge.');
      if (!inVault && !confirm('"' + p.name + '" ko vault se hata dein? Aapke original folder ko kuch nahi hoga.')) return;
      await api('/api/projects/' + p.id + (alsoFiles ? '?files=1' : ''), { method: 'DELETE' });
      m.close();
      S.projectId = null;
      await loadCatalog();
      toast('Hata diya', 'ok');
    });
  }

  /* ---- upload */
  function uploadModal() {
    const p = project();
    if (!p) return toast('Pehle koi project banayein', 'err');
    const m = modal(head('Upload to ' + p.name) +
      '<div class="modal-body">' +
        '<div class="field"><label>Kis folder me</label><select id="up-folder">' +
          ['', ...p.folders].map((d) => '<option value="' + esc(d) + '"' + (d === S.folder ? ' selected' : '') + '>' +
            (d ? esc(d) : '/ (root)') + '</option>').join('') + '</select></div>' +
        '<div class="drop" id="up-drop">' + icon('upload', 26) +
          '<div style="margin-top:8px">Files ya poora folder yahan drop kijiye</div>' +
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
      status.textContent = files.length + ' files upload ho rahi hain...';

      const qs = new URLSearchParams({ p: S.projectId, folder: $('#up-folder', m).value });
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload?' + qs.toString());
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) $('i', bar).style.width = (e.loaded / e.total * 100) + '%';
      };
      xhr.onload = async () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          status.textContent = 'Ho gaya.';
          toast(files.length + ' files upload ho gayi', 'ok');
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
  function settingsModal() {
    const m = modal(head('Settings') +
      '<div class="modal-body">' +
        '<div class="field"><label>Vault ka naam</label>' +
          '<div style="display:flex;gap:8px"><input type="text" id="st-name" value="' + esc(S.vaultName) + '">' +
          '<button class="btn" id="st-name-go">Save</button></div></div>' +
        '<div style="border-top:1px solid var(--line-soft);padding-top:14px" class="field">' +
          '<label>Passcode badlein</label>' +
          '<input type="password" id="st-cur" placeholder="Abhi ka passcode" autocomplete="current-password">' +
          '<input type="password" id="st-new" placeholder="Naya passcode (min 4)" autocomplete="new-password">' +
          '<button class="btn" id="st-pass-go" style="align-self:flex-start">Passcode update karein</button></div>' +
        '<div style="border-top:1px solid var(--line-soft);padding-top:14px;display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="btn btn-sm" id="st-rescan">' + icon('refresh', 13) + ' Sab rescan karein</button>' +
          '<button class="btn btn-sm btn-danger" id="st-logout">Log out</button></div>' +
      '</div><div class="modal-foot"><button class="btn" data-close>Close</button></div>');

    $('#st-name-go', m).addEventListener('click', async () => {
      const name = $('#st-name', m).value.trim();
      await api('/api/vault-name', { method: 'POST', body: { name } });
      S.vaultName = name; $('#vault-name').textContent = name; toast('Naam save ho gaya', 'ok');
    });
    $('#st-pass-go', m).addEventListener('click', async () => {
      try {
        await api('/api/passcode', { method: 'POST', body: { current: $('#st-cur', m).value, next: $('#st-new', m).value } });
        toast('Passcode badal gaya', 'ok');
        $('#st-cur', m).value = ''; $('#st-new', m).value = '';
      } catch (err) { toast(err.message, 'err'); }
    });
    $('#st-rescan', m).addEventListener('click', async () => { m.close(); await rescan(); });
    $('#st-logout', m).addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' });
      location.reload();
    });
  }

  async function rescan() {
    toast('Scan ho raha hai...');
    try {
      await api('/api/rescan', { method: 'POST', body: {} });
      await loadCatalog({ keepScroll: true });
      await refreshGitState();
      toast('Index update ho gaya', 'ok');
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
        if (data.delta > 0) toast(data.delta + ' nayi file aa gayi', 'ok');
        else if (data.delta < 0) toast(Math.abs(data.delta) + ' file hat gayi');
      });
    });

    stream.addEventListener('git', (e) => {
      const data = JSON.parse(e.data);
      refreshGitState();
      if (data.kind === 'pulled') {
        toast('GitHub: ' + data.commits + ' naya commit' + (data.commits === 1 ? '' : 's') +
              (data.subject ? ' — ' + data.subject : ''), 'ok');
      } else if (data.kind === 'behind') {
        toast('GitHub pe ' + data.behind + ' naye commits hain. Pull dabaayiye.');
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
    const proj = e.target.closest('[data-proj]');
    if (proj) {
      S.projectId = proj.dataset.proj; S.folder = ''; S.selection.clear(); S.openDirs.clear();
      renderAll(); syncSelection(); return;
    }
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const dir = toggle.dataset.toggle;
      if (S.openDirs.has(dir)) S.openDirs.delete(dir); else S.openDirs.add(dir);
      renderTree(); return;
    }
    const dir = e.target.closest('[data-dir]');
    if (dir) { goFolder(dir.dataset.dir); return; }
    if (e.target.closest('#git-pull')) { gitSync(S.projectId); return; }
    const autoToggle = e.target.closest('#git-auto');
    if (autoToggle) {
      api('/api/git/settings/' + S.projectId, { method: 'POST', body: { autoPull: autoToggle.checked } })
        .then(() => refreshGitState())
        .then(() => toast(autoToggle.checked ? 'Auto pull on' : 'Auto pull off', 'ok'))
        .catch((err) => toast(err.message, 'err'));
      return;
    }
    const chip = e.target.closest('[data-kind]');
    if (chip) {
      const k = chip.dataset.kind;
      if (S.kinds.has(k)) S.kinds.delete(k); else S.kinds.add(k);
      renderAll(); return;
    }
  });

  function goFolder(dir) {
    S.folder = dir;
    S.selection.clear();
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
    const dl = e.target.closest('[data-dl]');
    if (dl) {
      e.stopPropagation();
      const file = fileByPath(dl.dataset.dl);
      if (file) window.location.href = assetURL('/api/file', file, { dl: '1' });
      return;
    }
    const card = e.target.closest('[data-file]');
    if (!card) return;
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
  $('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('av.theme', next);
  });

  $('#viewer').addEventListener('click', (e) => {
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
    const file = S.results[viewerIndex];
    if (!file) return;
    if (e.target.closest('#v-dl') || e.target.closest('#v-dl2')) {
      window.location.href = assetURL('/api/file', file, { dl: '1' });
    }
    if (e.target.closest('#v-open')) window.open(assetURL('/api/file', file), '_blank');
    if (e.target.closest('#v-del')) {
      if (!confirm('"' + file.n + '" ko permanently delete karein? Ye disk se hat jaayegi.')) return;
      api('/api/file?' + new URLSearchParams({ p: S.projectId, f: file.p }), { method: 'DELETE' })
        .then(() => { closeViewer(); return loadCatalog(); })
        .then(() => toast('Delete ho gayi', 'ok'))
        .catch((err) => toast(err.message, 'err'));
    }
  });

  document.addEventListener('keydown', (e) => {
    if ($('#lock').classList.contains('hidden') === false) return;
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (viewerIndex >= 0) {
      if (e.key === 'Escape') { e.preventDefault(); closeViewer(); }
      if (e.key === 'ArrowLeft' && viewerIndex > 0) { viewerIndex--; drawViewer(); }
      if (e.key === 'ArrowRight' && viewerIndex < S.results.length - 1) { viewerIndex++; drawViewer(); }
      return;
    }
    if (typing) {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    if (e.key === '/') { e.preventDefault(); $('#q').focus(); $('#q').select(); }
    if (e.key === 'g') setView('grid');
    if (e.key === 'l') setView('list');
    if (e.key === 'Escape' && S.selection.size) { S.selection.clear(); syncSelection(); }
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
    toast('Upload window khul gaya, ab yahan drop kijiye');
  });

  boot().catch((err) => {
    console.error('[vault] boot failed', err);
    $('#lock-msg').textContent = err.message;
    $('#lock-msg').className = 'msg err';
  });
})();
