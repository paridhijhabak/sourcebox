# SourceBox

A private, self-hosted drive for your files. Point it at folders you already have, find
anything by describing it in plain language, preview almost any file in the browser, and
hand someone a single folder through a secure link — all from a small server that runs on
your own machine.

Your files stay where they live. SourceBox reads your folders in place, so nothing is
duplicated, and it notices changes on its own. Point it at a git repository and it keeps
itself up to date with the remote.

It isn't tied to any one industry. Whether the files are brand assets, invoices, contracts,
photo shoots, course material, or a project repo, the same four things apply: point, find,
preview, share.

---

## At a glance

| | |
|---|---|
| **Any project** | Register a local folder, clone a git repo, or create an empty project and upload to it |
| **Auto update** | A folder watcher plus git polling. No need to press rescan |
| **Plain-language search** | Type the way you'd describe a file out loud. Understands synonyms, short forms and typos across any kind of file |
| **Preview** | Images, SVG, PDF, AI, video, markdown, code, HTML |
| **Colours** | The real hex codes inside any image — click to copy |
| **File history** | Every commit that touched a file, in a git-backed project |
| **Starred / Recent** | Star what you reach for daily; recents follow you per device |
| **Share** | Per-folder link with its own passcode, expiry, and downloads on or off |
| **Accounts** | An email and password per person, stored on your own disk. First account owns the vault |
| **Themeable** | Rename the vault, pick an accent colour and a preset, choose Light / Dark / System |
| **Private** | Everything on your machine. No cloud, no vendor account, no telemetry |

---

## Getting started

You need **Node.js 18+** and, for the git features, **git**.

```
npm install
npm start
```

Or on Windows, double-click **`Start Vault.bat`**.

The first run prints something like this in the terminal:

```
  SourceBox is running
  Local:   http://localhost:4477
  Network: http://192.168.1.20:4477

  First run. Your passcode:  k7ra-9mqp
```

Note that passcode, sign in, and set your own in **Settings**. The passcode is generated
fresh for every install — it is never hardcoded.

Then open the product page at `http://localhost:4477/product` and create your account.

---

## Accounts

The vault has two ways in, and they work together.

**The owner passcode** unlocks the whole vault on its own. It is printed on first run,
changed in Settings, and is what the lock screen at `/` asks for.

**An account** is an email and a password, one per person. Sign up and log in on the
product page at `/product#account` — the same page that describes the product, which is
why it sits outside the passcode.

| | |
|---|---|
| First account | Whoever signs up first on a fresh install becomes the **owner** |
| Later accounts | Need the owner passcode as an invitation, so nobody on your Wi-Fi or on a public link can sign themselves up |
| Storage | `data/users.json`, next to your projects. A name, an email, and a scrypt hash with a per-account salt — never the password |
| Session | A signed, http-only cookie, good for 30 days. Deleting an account ends its open sessions immediately |
| Rate limit | Eight failed logins per email from one address closes that door for 15 minutes |
| Roles | `owner` and `member`. Both see the whole vault; only the owner can remove accounts |

Members see everything in the vault — the roles separate who may remove accounts, not who
may read which project. If you need per-person file permissions, this isn't that yet.

Nothing here reaches a network. There is no verification email, no password reset link and
no vendor: an account is a local credential, the same way the passcode is. If a password is
forgotten, unlock the vault with the owner passcode instead, and remake the account.

### Account endpoints

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/auth/state` | Whether this vault has any account, and who is signed in |
| `POST` | `/api/auth/signup` | `{ name, email, password, passcode? }` |
| `POST` | `/api/auth/login` | `{ email, password }` |
| `POST` | `/api/auth/logout` | Ends the session |
| `GET` | `/api/auth/users` | Everyone with an account |
| `POST` | `/api/auth/password` | `{ current, next }` for the signed-in account |
| `DELETE` | `/api/auth/users/:id` | Owner only; the owner account cannot be removed |

---

## Three ways to add a project

Click the `+` next to **Projects** in the sidebar, or use the cards shown on an empty vault.

### 1. A folder on this computer
Give the full path, for example `C:\Users\You\Desktop\ClientProject`. Files are **not
copied** — SourceBox reads them where they are and puts a watcher on the folder. If that
folder is a git repo, git sync turns on automatically.

### 2. Clone a git repo
Paste the repo URL (`https://github.com/user/repo.git` or `git@github.com:user/repo.git`).

- **Check repo** confirms the repo is reachable and lists its branches in a few seconds,
  before a full clone begins.
- The clone lands in the vault's own `storage/repos/`, with a progress bar.
- From then on it behaves like any project, and new commits are pulled automatically.

**Private repos:** if your system git is already signed in to GitHub (Windows Credential
Manager or an SSH key), nothing more is needed. Otherwise there is a Personal Access Token
field. The token is saved into the clone's remote URL (standard git behaviour) so later
fetches keep working, and it is never shown in the UI.

### 3. Empty project
Give it a name and it's created; then use Upload to drag in files or a whole folder.

---

## Staying up to date

Two things run in the background. Neither needs anything from you.

**Folder watch (instant).** A recursive watcher on each project root. Commit, switch
branches, save from another app, or drop a file into the folder, and SourceBox re-indexes
within about 1.5 seconds. Open browser tabs update themselves — no reload.

**Git polling (every 5 minutes).** For git-backed projects, a background `git fetch`. When
new commits arrive it safely pulls, re-indexes, and shows a toast.

The sidebar git strip shows the branch, last commit, local changes, the time of the last
check, a **Check now** button and an **Auto** toggle.

### Your work is never overwritten

Auto pull runs only when both are true:

- the working tree is **clean** (no uncommitted changes), and
- the pull is a **fast-forward** (the branch hasn't diverged).

Otherwise SourceBox does nothing and simply tells you why: *"13 local changes pending, so
no pull"* or *"the branch has diverged"*. It never runs `push`, `commit`, `merge`, or
`rebase` — only `fetch` and `merge --ff-only`. No merge conflicts, no lost work.

---

## Sharing a link

Open any folder and click **Share** at the top right.

| Option | What it does |
|---|---|
| Folder | The recipient sees only this folder; the rest of the vault stays hidden |
| Passcode | Leave blank to open without a passcode |
| Expiry | How many days until the link closes itself |
| Allow downloads | Turn off and the recipient can view but not download |

Every link appears under the **Links** button (bottom-left), where you can copy or revoke
it. Revoking closes the link immediately.

### On the same network
When the server starts it prints `Network: http://192.168.x.x:4477`. That address opens on
any device on the same Wi-Fi.

### Over the internet
Once:

```
winget install --id Cloudflare.cloudflared
```

Then, whenever you need a public link, keep `Start Vault.bat` running and double-click
`Share Online.bat`. You'll get a `https://something.trycloudflare.com` link. Both windows
need to stay open.

---

## How to search

You don't have to remember filenames. Type the way you'd describe a file:

```
red logo                signed contract pdf       product photos
last quarter invoice    whatsapp status           editable source file
business card           revenue spreadsheet        all pdfs
```

Search understands synonyms across many domains (invoice/bill/receipt, contract/agreement,
report/summary, logo/mark, photo/picture…), short forms (`ig`, `fb`, `yt`, `vc`), and
typos (`logoo`, `invoic`). When nothing matches, it offers "did you mean" suggestions.

While browsing you see only the current folder's files, but search looks through everything
inside that folder. To search the whole project, click the project name in the breadcrumb.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `?` | This list, inside the app |
| `/` | Jump to search |
| Arrow keys | Move in the grid (or previous/next file when a preview is open) |
| `Enter` | Open whatever the cursor is on — folder or file |
| `Space` | Select / deselect |
| `s` | Star |
| `Backspace` | Up one folder |
| `g` / `l` | Grid / list view |
| Click | Preview |
| Ctrl+click | Select |
| Shift+click | Range select |
| Ctrl+A | Select all |
| `Esc` | Close |

With files selected, a bar appears at the bottom: **Download zip** puts every selected file
into a single zip.

---

## Views: Starred and Recent

The sidebar has a **Views** section — three routes into one project:

| View | Shows |
|---|---|
| **All files** | The folder you're standing in |
| **Starred** | Everything you've starred across the project |
| **Recent** | What you opened lately, newest first |

Star in two ways: the star button on a card, or hover and press `s`. Stars are saved on the
server, so they show up on your laptop and your phone alike. Recent lives in your browser,
because "what did I just look at" is specific to that browser.

---

## Colours and file history

Open any image or SVG and the right-hand panel shows:

- **Colours** — the real dominant hex codes in that file, with coverage %. Click to copy.
  No need to open a design tool and use an eyedropper.
- **History** — in a git-backed project, the commits that touched that one file.
- **Copy image** — the picture itself onto the clipboard, to paste straight into a deck or
  chat.

---

## Appearance and theme

In **Settings** you can:

- **Rename the vault** — the name shows in the sidebar, the lock screen, and share links.
- **Choose Light / Dark / System** — "System" follows your device; your choice is
  remembered per device.
- **Set colours** — pick an accent, a folder colour, and a page background by hand, or tap
  a preset (Indigo, Orange, Blue, Teal, Emerald, Violet, Rose, Graphite). Colours are saved
  on the server, so every device and every share link shows the same look.

---

## Hosting the product page

The vault itself cannot be deployed to a serverless host. It watches folders on the machine
it runs on, keeps an index and a thumbnail cache on disk, clones git repos and holds an SSE
connection open — none of which survives a read-only, ephemeral function. More to the
point, a cloud box cannot see the folders on your computer, which is the whole product.

The page that describes it is a different matter, and it is a static file:

```
npm run build:site     # copies public/usp.html -> site/index.html
vercel --prod          # or any static host; vercel.json is already set up
```

Live at **https://sourcebox-phi.vercel.app**.

There is no second copy of the page to keep in step — `public/usp.html` is the only source,
and it checks at load whether a vault is answering `/api/auth/state`. On your machine the
sign-in and sign-up forms are live; on the hosted copy the same card shows install
instructions instead.

If you want the vault reachable from outside your machine, use `Share Online.bat`
(a Cloudflare tunnel), or run it on a box with a real disk — a VPS, Railway, Render, Fly.

---

## Product page

`http://localhost:4477/product` (also `/usp`) — what SourceBox is, in one page: the problem
it solves, how it works, every feature, who it's for, how it stays private, and the sign-in
and sign-up forms. It sits outside the passcode because it describes the vault without
showing anything in it, and because it is where accounts are created.

---

## Preview support

| Type | What happens |
|---|---|
| PNG, JPG, SVG, WEBP, GIF | Full preview, with a background swatch you can switch (checker / white / cream / black / red) |
| PDF, AI, EPS | Rendered page by page in the browser (AI only when saved "PDF Compatible") |
| MP4, WEBM, MOV | Inline player |
| MD, TXT, JSON, CSV, code | Text view |
| HTML | Sandboxed iframe |
| PSD, INDD, ZIP, fonts | No preview — download only |

Thumbnails are made on the server (with sharp), and the ones the server can't make (PDF, AI,
video) are rendered by the browser and sent back, so the next person gets them instantly.

---

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4477` | Which port to run on |
| `VAULT_DATA_DIR` | repo folder | Where to keep `data/`, `cache/`, `storage/` |

`VAULT_DATA_DIR` lets you keep state on another drive, or run two separate vaults from one
codebase.

---

## What lives where

```
AssetVault/
  server.js            HTTP server and all API endpoints
  lib/
    config.js          passcode, project list, settings
    theme.js           accent / folder / background colours
    indexer.js         folder scan and file catalog
    shares.js          share links
    thumbs.js          thumbnail generation and cache
    auth.js            signed cookie sessions
    users.js           accounts: email, scrypt-hashed password, roles
    git.js             git status / probe / clone / safe fast-forward pull
    sync.js            folder watcher, git poller, clone jobs, live events
  public/              the browser app
    search.js          plain-language fuzzy search engine
    usp.html           the product page served at /product and /usp, with sign-in
  scripts/tunnel.js    creates the public link
  tests/               npm test and npm run test:ui
  data/                config.json, users.json, index.json, shares.json   <- worth backing up
  cache/thumbs/        generated thumbnails (safe to delete)
  storage/             uploaded projects and cloned repos
```

Back up `data/`. It holds the passcode hash, accounts, project list and share links.
Everything else can be rebuilt.

---

## Tests

```
npm test           # API, accounts, search, upload, sync, clone, git errors (headless)
npm run test:ui    # browser tests, needs Chrome
```

Tests build their own fixture project and use throwaway local repos for the git tests, so no
network or credentials are needed and your real projects are never touched. If you changed
the passcode, set `VAULT_PASSCODE`.

---

## Good to know

- There is one owner passcode for the whole vault, plus an account per person. Share links
  have their own separate passcodes, unrelated to both.
- A "downloads off" share hides the download button and blocks the zip, but the file still
  travels to the browser for the preview. A determined person could extract it via devtools
  or a screenshot. This is casual protection, not DRM.
- A trycloudflare link is new every time. For a fixed link, set up a named tunnel with a
  Cloudflare account.
- The server runs only while its window is open. If it crashes, `Start Vault.bat` restarts
  it within 3 seconds and writes `crash.log`.

---

## If something gets stuck

**Port already in use** — a previous server is running. End `node.exe` in Task Manager, or
run `PORT=4478 npm start`.

**Forgot the passcode** — delete `data/config.json` and restart the server. A new passcode
is generated and printed. The project list resets, and existing sessions are signed out
because the session secret is regenerated (your files and accounts are untouched).

**Forgot an account password** — there is no reset email, because there is no email. Unlock
the vault with the owner passcode instead, or delete that account's entry from
`data/users.json` and sign up again with the same address. Emptying the file entirely makes
the next sign-up the owner once more.

**Project shows "folder missing"** — the original folder was moved or renamed. Remove it in
Projects and add it again from the new path.

**New files not showing** — they normally appear on their own. Check the server window's
`Watching N project folder(s)` line: if your project isn't counted, the watcher didn't
attach (a network drive or unusual path can do this) — use **Rescan**.

**Git strip says "sync paused"** — the reason is printed under that line. Usually no
internet or expired credentials. Run `git pull` once in the terminal.

**Auto pull not happening** — 99% of the time there are uncommitted changes. The git strip
shows "N local changes". Commit or stash them.

**Clone asks for a GitHub login** — it's a private repo. Fill in the token field, or run
`git clone` once in the terminal to save your credentials.

**No thumbnail** — that format has no preview (PSD, INDD, and so on). The file still
downloads.
