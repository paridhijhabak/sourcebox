'use strict';
/* Thin, defensive wrapper around the git CLI.
 *
 * Two rules everywhere in here:
 *   1. Never block. Every call has a timeout and interactive prompts are off,
 *      so a credential popup turns into a fast error instead of a hung server.
 *   2. Never lose work. The only write operation is a fast-forward merge, and
 *      it is refused outright when the working tree is dirty.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const UNIT = '\x1f';

// Git must never stop and wait for a human: this process has no terminal.
const GIT_ENV = Object.assign({}, process.env, {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_OPTIONAL_LOCKS: '0',
});

function run(cwd, args, timeout) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      env: GIT_ENV,
      timeout: timeout || 15000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        // Porcelain output is column-sensitive, so keep an untrimmed copy:
        // trimming eats the leading status space of the first line.
        raw: String(stdout || ''),
        err: String((err && err.message) || stderr || '').trim(),
        timedOut: !!(err && err.killed),
      });
    });
  });
}

function isRepo(root) {
  try {
    return fs.existsSync(path.join(root, '.git'));
  } catch {
    return false;
  }
}

/** Everything the UI needs about a repo, in one shot. Read-only. */
async function status(root) {
  if (!isRepo(root)) return { isRepo: false };

  const [branch, head, upstream, dirty] = await Promise.all([
    run(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    run(root, ['log', '-1', '--format=%h' + UNIT + '%s' + UNIT + '%an' + UNIT + '%cI']),
    run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    run(root, ['status', '--porcelain', '--untracked-files=normal'], 30000),
  ]);

  const commit = head.ok && head.out ? head.out.split(UNIT) : [];
  const changed = dirty.ok ? dirty.raw.split('\n').filter((l) => l.trim()) : [];

  const info = {
    isRepo: true,
    branch: branch.ok ? branch.out : null,
    upstream: upstream.ok ? upstream.out : null,
    remote: null,
    lastCommit: commit.length === 4
      ? { hash: commit[0], subject: commit[1], author: commit[2], date: commit[3] }
      : null,
    dirtyCount: changed.length,
    dirtyFiles: changed.slice(0, 8).map(porcelainPath),
    ahead: 0,
    behind: 0,
  };

  const remote = await run(root, ['remote', 'get-url', 'origin']);
  if (remote.ok) info.remote = remote.out.replace(/^https:\/\/[^@]+@/, 'https://');

  if (info.upstream) {
    const counts = await run(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
    if (counts.ok) {
      const [a, b] = counts.out.split(/\s+/).map(Number);
      info.ahead = a || 0;
      info.behind = b || 0;
    }
  }
  return info;
}

/** Contacts the remote. Read-only for the working tree. */
async function fetch(root) {
  if (!isRepo(root)) return { ok: false, err: 'Not a git repo' };
  const r = await run(root, ['fetch', '--quiet', '--prune'], 120000);
  if (!r.ok) {
    return {
      ok: false,
      err: r.timedOut
        ? 'GitHub se baat karne me time zyada lag gaya'
        : cleanGitError(r.err),
    };
  }
  return { ok: true };
}

/**
 * Fast-forward only, and only from a clean tree. If the branch has diverged
 * or there are local edits, this reports why and changes nothing.
 */
async function pull(root) {
  const before = await status(root);
  if (!before.isRepo) return { ok: false, err: 'Not a git repo' };
  if (!before.upstream) return { ok: false, err: 'Is branch ka koi remote nahi hai' };

  const fetched = await fetch(root);
  if (!fetched.ok) return fetched;

  const after = await status(root);
  if (after.behind === 0) return { ok: true, changed: false, status: after };

  if (after.dirtyCount > 0) {
    return {
      ok: false, skipped: true, status: after,
      err: after.dirtyCount + ' local change' + (after.dirtyCount === 1 ? '' : 's') +
           ' pending hain, isliye pull nahi kiya. Pehle commit ya stash kar lijiye.',
    };
  }
  if (after.ahead > 0) {
    return {
      ok: false, skipped: true, status: after,
      err: 'Branch diverge ho gayi hai (' + after.ahead + ' ahead, ' + after.behind +
           ' behind). Ise manually merge kariye.',
    };
  }

  const merged = await run(root, ['merge', '--ff-only', '@{u}'], 300000);
  if (!merged.ok) {
    return { ok: false, status: after, err: cleanGitError(merged.err) };
  }
  return { ok: true, changed: true, pulled: after.behind, status: await status(root) };
}

/* ------------------------------------------------------------- cloning */

/**
 * A repo URL is passed straight to the git CLI, so anything that could be read
 * as an option (`--upload-pack=...`) has to be refused outright. execFile
 * already rules out shell injection; this rules out argument injection.
 */
function validateUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return { ok: false, err: 'Repo ka URL daaliye' };
  if (url.startsWith('-')) return { ok: false, err: 'Ye URL valid nahi hai' };
  if (/[\r\n\0]/.test(url)) return { ok: false, err: 'Ye URL valid nahi hai' };
  const shape = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/i.test(url) ||
    /^[A-Za-z]:[\\/]/.test(url) || url.startsWith('/') || url.startsWith('.');
  if (!shape) return { ok: false, err: 'https://... ya git@... jaisa URL chahiye' };
  return { ok: true, url };
}

/** Strips any embedded credentials before a URL is stored or shown. */
function maskUrl(url) {
  return String(url || '').replace(/^(\w+:\/\/)[^@/]+@/, '$1');
}

/** Puts a token into an https URL for the duration of a clone. */
function withToken(url, token) {
  if (!token) return url;
  const m = /^(https?:\/\/)(.*)$/i.exec(url);
  if (!m) return url;
  return m[1] + encodeURIComponent(String(token).trim()) + '@' + m[2].replace(/^[^@/]+@/, '');
}

/** Cheap reachability + auth check so a bad URL fails in seconds, not minutes. */
async function probe(url, token) {
  const check = validateUrl(url);
  if (!check.ok) return check;
  const r = await run(process.cwd(), ['ls-remote', '--heads', '--', withToken(check.url, token)], 30000);
  if (!r.ok) return { ok: false, err: cleanGitError(r.err) };
  const branches = r.out.split('\n').filter(Boolean)
    .map((l) => l.split('refs/heads/')[1]).filter(Boolean);
  if (!branches.length) return { ok: false, err: 'Is repo me koi branch nahi mili' };
  const preferred = ['main', 'master'].find((b) => branches.includes(b));
  return { ok: true, branches, defaultBranch: preferred || branches[0] };
}

/**
 * Clones into `dest`, reporting git's own progress lines as they arrive.
 * If a token is supplied it stays in the clone's remote so later fetches keep
 * working; the caller is responsible for telling the user that.
 */
function clone(url, dest, { branch, token, onProgress } = {}) {
  return new Promise((resolve) => {
    const check = validateUrl(url);
    if (!check.ok) return resolve(check);

    const args = ['clone', '--progress'];
    if (branch) args.push('--branch', String(branch));
    args.push('--', withToken(check.url, token), dest);

    const child = execFile('git', args, {
      env: GIT_ENV,
      timeout: 60 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }, (err) => {
      if (err) {
        try { fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
        return resolve({ ok: false, err: cleanGitError(tail.join('\n')) });
      }
      resolve({ ok: true });
    });

    // git writes progress to stderr, as carriage-return updated lines.
    const tail = [];
    let carry = '';
    const consume = (chunk) => {
      carry += chunk.toString();
      const parts = carry.split(/[\r\n]+/);
      carry = parts.pop();
      for (const line of parts) {
        const text = line.trim();
        if (!text) continue;
        tail.push(text);
        if (tail.length > 40) tail.shift();
        const pct = /(\d{1,3})%/.exec(text);
        if (onProgress) {
          onProgress({ line: text, percent: pct ? Number(pct[1]) : null, phase: phaseOf(text) });
        }
      }
    };
    if (child.stderr) child.stderr.on('data', consume);
    if (child.stdout) child.stdout.on('data', consume);
  });
}

function phaseOf(line) {
  if (/Receiving objects/i.test(line)) return 'download';
  if (/Resolving deltas/i.test(line)) return 'resolve';
  if (/Counting objects|Compressing objects|remote:/i.test(line)) return 'prepare';
  if (/Updating files|Checking out|Filtering content/i.test(line)) return 'checkout';
  return 'work';
}

/** Which files a fast-forward would touch, so we can say what changed. */
async function incomingFiles(root) {
  if (!isRepo(root)) return [];
  const r = await run(root, ['diff', '--name-status', 'HEAD..@{u}']);
  if (!r.ok || !r.out) return [];
  return r.out.split('\n').filter(Boolean).map((line) => {
    const [code, ...rest] = line.split('\t');
    return { change: code[0], path: rest.join('\t') };
  });
}

/** `XY path`, or `XY old -> new` for renames. Quoted when it has odd bytes. */
function porcelainPath(line) {
  let p = line.slice(2).replace(/^\s+/, '');
  const arrow = p.indexOf(' -> ');
  if (arrow >= 0) p = p.slice(arrow + 4);
  if (p.startsWith('"') && p.endsWith('"')) {
    try { return JSON.parse(p); } catch { return p.slice(1, -1); }
  }
  return p;
}

/* A token can be embedded in the remote URL (see `withToken`) and git echoes
 * back the URL it failed on, so nothing from git's output reaches the UI
 * without passing through here first. */
function redactSecrets(text) {
  return String(text || '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1')
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, '$1***');
}

/* GitHub's own wording, mapped to the one thing the user can act on. Order
 * matters: git wraps nearly every HTTP failure in `unable to access '<url>'`,
 * so the specific status codes must be matched before the generic network
 * pattern at the bottom, or a 403 gets reported as "check your internet". */
const GIT_ERRORS = [
  [/SAML|single sign-on/i,
    'Is organization me SAML SSO on hai. GitHub ke token settings me is token ko org ke liye "Authorize" kijiye, phir dobara try kijiye.'],
  [/could not read Username|could not read Password|terminal prompts disabled/i,
    'GitHub ne login maanga par koi saved credential nahi mila. Yahan token field bhariye, ya terminal me ek baar "git ls-remote <url>" chala ke login kar lijiye.'],
  [/Authentication failed|invalid username or password|invalid username or token|Bad credentials|error: 401|password authentication (is not supported|was removed)/i,
    'GitHub ne login reject kar diya — saved token expire ho gaya hai ya galat hai. Naya personal access token bana ke token field me daaliye.'],
  [/Repository not found|repository '[^']*' not found/i,
    'Repo nahi mila. Ya to URL galat hai, ya ye private repo hai jiski access is login ke paas nahi — "repo" scope wala token daal ke dekhiye.'],
  [/error: 403|Write access to repository not granted|You don't have permission/i,
    'Is repo par permission nahi hai (403). Token me "repo" scope hai ya nahi, wo check kijiye.'],
  [/Permission denied \(publickey|Host key verification failed/i,
    'SSH key se login nahi hua. Asset Vault SSH passphrase nahi pooch sakta — "https://github.com/..." wala URL use kijiye.'],
  [/Remote branch .* not found|couldn't find remote ref/i,
    'Ye branch remote par nahi mili. Branch ka naam check kijiye.'],
  [/early EOF|RPC failed|remote end hung up|index-pack failed/i,
    'Download beech me toot gaya. Dobara try kijiye — bade repo me aisa ho jaata hai.'],
  [/detected dubious ownership/i,
    'Is folder ka Windows owner alag hai, isliye git ne ise refuse kar diya.'],
  [/index\.lock|Unable to create .*\.lock/i,
    'Is repo par koi doosra git command already chal raha hai. Thodi der baad try kijiye.'],
  [/Could not resolve host|Connection timed out|Failed to connect|Network is unreachable|unable to access/i,
    'GitHub tak nahi pahuncha. Internet check kijiye.'],
];

function cleanGitError(text) {
  const t = redactSecrets(text);
  for (const [re, msg] of GIT_ERRORS) if (re.test(t)) return msg;

  /* Nothing matched, so fall back to git's own words — but prefer the line it
   * actually explained itself on over the `Command failed: git ...` header
   * that execFile puts at the top of every error. */
  const lines = t.split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((s) => !/^Command failed:/i.test(s));
  const best = lines.filter((s) => /^(fatal|error|remote):/i.test(s)).pop() || lines.pop();
  return (best || 'git command fail hui').replace(/^(fatal|error|remote):\s*/i, '').slice(0, 200);
}

/**
 * The commits that touched one path, newest first. Read-only, capped, and
 * `--follow` is deliberately off: it is slow on a repo full of large binaries
 * and its rename guesses are wrong often enough to mislead.
 */
async function fileLog(root, relPath, limit) {
  if (!isRepo(root)) return { ok: false, err: 'Not a git repo' };
  const r = await run(root, [
    'log',
    '-n', String(Math.min(Math.max(Number(limit) || 8, 1), 50)),
    '--format=%h' + UNIT + '%s' + UNIT + '%an' + UNIT + '%aI',
    '--', relPath,
  ], 20000);
  if (!r.ok) return { ok: false, err: cleanGitError(r.err) };
  const commits = r.out
    ? r.out.split('\n').map((line) => {
      const [hash, subject, author, date] = line.split(UNIT);
      return { hash, subject, author, date };
    })
    : [];
  return { ok: true, commits };
}

module.exports = {
  isRepo, status, fetch, pull, incomingFiles, fileLog,
  clone, probe, validateUrl, maskUrl, cleanGitError,
};
