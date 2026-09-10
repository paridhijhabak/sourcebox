# Asset Vault

A private, passcode-protected drive for design and brand assets. Add any number of
projects, search them in plain language, preview almost anything in the browser, and hand
a client a link that shows them one folder and nothing else.

Projects stay where they already live. The vault reads your folders in place, so nothing
is duplicated, and it notices changes on its own. Point it at a git repo and it keeps
itself up to date with the remote.

---

## Ek nazar me

| | |
|---|---|
| **Koi bhi project** | Local folder register kijiye, git repo clone kijiye, ya khaali project banaake upload kijiye |
| **Auto update** | Folder watcher + git polling. Rescan dabane ki zarurat nahi |
| **Layman search** | `red wala logo`, `insta post hindi`, `tshirt print file`. Hinglish, short forms, typos |
| **Preview** | Images, SVG, PDF, AI, video, markdown, code, HTML |
| **Share** | Per-folder link with its own passcode, expiry, aur download on/off |
| **Private** | Sab kuch aapki machine pe. Koi cloud, koi account, koi telemetry |

---

## Chalu kaise karein

Chahiye: **Node.js 18+** aur (git features ke liye) **git**.

```
npm install
npm start
```

Ya Windows pe seedha **`Start Vault.bat`** pe double click.

Pehli baar chalane pe terminal me aisa kuch dikhega:

```
  Asset Vault is running
  Local:   http://localhost:4477
  Network: http://192.168.1.20:4477

  First run. Aapka passcode:  k7ra-9mqp
```

Wo passcode note kar lijiye, login kijiye, aur Settings me jaake apna set kar lijiye.
Har install pe ye passcode alag generate hota hai, kahin hardcoded nahi hai.

---

## Project add karne ke teen tareeke

Sidebar me **Projects** ke aage `+`, ya khaali vault pe seedha cards dikhte hain.

### 1. Is PC ka folder
Folder ka poora path dijiye, jaise `C:\Users\You\Desktop\ClientProject`.
Files **copy nahi hoti**. Vault wahi se padhta hai, aur us folder pe watcher laga deta hai.
Agar wo folder git repo hua to git sync khud chalu ho jayega.

### 2. Git repo se clone
Repo ka URL paste kijiye (`https://github.com/user/repo.git` ya `git@github.com:user/repo.git`).

- **Repo check karein** dabaake pehle confirm kar lijiye ki repo mil raha hai aur kaunsi
  branches hain. Ye kuch second me pata chal jata hai, poora clone shuru karne se pehle.
- Clone vault ke apne `storage/repos/` me hota hai, progress bar ke saath.
- Uske baad wo project normal project ki tarah behave karta hai, aur naye commits apne aap
  pull hote rehte hain.

**Private repos:** agar aapke system ke git me pehle se GitHub login hai (Windows
Credential Manager ya SSH key), to kuch nahi chahiye. Warna ek Personal Access Token
field hai. Token clone ke remote URL me save hota hai (standard git behaviour) taaki baad
ke fetch bhi chalte rahein, aur UI me kabhi display nahi hota.

### 3. Khaali project
Naam dijiye, project ban jayega, phir Upload se files ya poora folder drag-drop kar dijiye.

---

## Apne aap update hona

Do cheezein background me chalti hain. Dono ke liye aapko kuch nahi karna.

**Folder watch (turant).** Har project root pe recursive watcher. Aap commit karein, branch
switch karein, Illustrator se save karein, ya Explorer se file daalein: vault 1.5 second me
re-index kar leta hai aur khuli hui browser tabs khud badal jaati hain. Koi reload nahi.

**Git polling (har 5 minute).** Jo project git repo hai, uske liye background me `git fetch`.
Naye commits milte hi safe pull karke re-index, aur toast dikhta hai.

Sidebar me git strip: branch, aakhri commit, local changes, last check ka time,
**Check now** button aur **Auto** toggle.

### Aapka kaam kabhi overwrite nahi hoga

Auto pull tabhi chalta hai jab dono sach hon:

- working tree **clean** ho (koi uncommitted change na ho)
- pull **fast-forward** ho (branch diverge na hui ho)

Warna vault kuch nahi karta, sirf bata deta hai: *"13 local changes pending hain, isliye
pull nahi kiya"* ya *"branch diverge ho gayi hai"*. Vault kabhi `push`, `commit`, `merge`,
ya `rebase` nahi karta. Sirf `fetch` aur `merge --ff-only`. Merge conflicts ya lost work ka
risk nahi.

---

## Link share karna

Kisi bhi folder me jaayiye, upar right me **Share**.

| Option | Matlab |
|---|---|
| Folder | Client ko sirf yahi folder dikhega, baaki poora vault chhupa rahega |
| Passcode | Khaali chhoda to bina passcode khulega |
| Expire | Kitne din baad link apne aap band ho jaye |
| Download allow | Off kiya to client dekh sakta hai, download nahi kar sakta |

Saare links **Links** button (bottom-left) me dikhte hain, wahan se copy ya revoke.
Revoke karte hi link turant band.

### Same wifi pe
Server start hote hi `Network: http://192.168.x.x:4477` dikhta hai. Wahi address office ke
kisi bhi device pe khulega.

### Internet pe
Ek baar:

```
winget install --id Cloudflare.cloudflared
```

Phir jab bhi link chahiye: `Start Vault.bat` chalu rakhiye aur `Share Online.bat` pe double
click. `https://kuch-kuch.trycloudflare.com` jaisa link milega. Dono windows khuli rehni
chahiye.

---

## Search kaise likhein

Filename yaad rakhne ki zarurat nahi. Aise likhiye jaise bol rahi hon:

```
red wala logo              insta post hindi          tshirt print file
mujhe kala logo chahiye    whatsapp status           editable source file
visiting card              youtube banner            sare pdf
```

Search Hinglish samajhta hai (`lal`, `kala`, `lifafa`, `sare`), short forms samajhta hai
(`ig`, `fb`, `yt`, `wa`, `vc`), aur typo bhi chala leta hai (`logoo`, `instgram`).
Kuch na mile to "did you mean" suggestions aa jaate hain.

Browse karte waqt sirf current folder ki files dikhti hain, lekin search us folder ke andar
sab kuch dhoondhta hai. Poore project me dhoondhna ho to breadcrumb me project ke naam pe
click kar lijiye.

---

## Shortcuts

| Key | Kaam |
|---|---|
| `/` | Search pe jump |
| `g` / `l` | Grid / List view |
| Click | Preview |
| Ctrl+click | Select |
| Shift+click | Range select |
| Ctrl+A | Sab select |
| Arrow keys | Preview me agli/pichli file |
| `Esc` | Band karna |

Select karne ke baad niche bar aata hai: **Download zip** se saari selected files ek zip me.

---

## Preview support

| Type | Kya hota hai |
|---|---|
| PNG, JPG, SVG, WEBP, GIF | Poora preview, aur background swatch (checker / white / cream / black / red) badal ke dekh sakti hain |
| PDF, AI, EPS | Browser me page-by-page render (AI tabhi jab "PDF Compatible" save kiya ho) |
| MP4, WEBM, MOV | Inline player |
| MD, TXT, JSON, CSV, code | Text view |
| HTML | Sandboxed iframe |
| PSD, INDD, ZIP, fonts | Preview nahi, sirf download |

Thumbnails server pe banti hain (sharp se), aur jo server nahi bana sakta (PDF, AI, video)
wo browser render karke server ko wapas bhej deta hai, taaki agli baar sabke liye instant ho.

---

## Configuration

| Env var | Default | Kaam |
|---|---|---|
| `PORT` | `4477` | Kis port pe chale |
| `VAULT_DATA_DIR` | repo folder | Kahan `data/`, `cache/`, `storage/` rakhe |

`VAULT_DATA_DIR` se aap state ko doosri drive pe rakh sakti hain, ya ek hi code se do
alag-alag vault chala sakti hain.

---

## Kya kahan rehta hai

```
AssetVault/
  server.js            HTTP server aur saare API endpoints
  lib/
    config.js          passcode, project list, settings
    indexer.js         folder scan aur file catalog
    shares.js          share links
    thumbs.js          thumbnail generation aur cache
    auth.js            signed cookie sessions
    git.js             git status / probe / clone / safe fast-forward pull
    sync.js            folder watcher, git poller, clone jobs, live events
  public/              browser app
    search.js          fuzzy + synonym search engine
  scripts/tunnel.js    public link banane wala script
  tests/               npm test aur npm run test:ui
  data/                config.json, index.json, shares.json   <- backup ke layak
  cache/thumbs/        generated thumbnails (delete karna safe hai)
  storage/             uploaded projects aur cloned repos
```

`data/` ka backup rakhiye. Usme passcode hash, project list aur share links hain.
Baaki sab dobara ban sakta hai.

---

## Tests

```
npm test           # API, search, upload, sync, clone, fresh install (headless)
npm run test:ui    # browser tests, needs Chrome
```

Tests apna khud ka fixture project banate hain aur git wale tests local throwaway repos
use karte hain, to koi network ya credentials nahi chahiye, aur aapke asli projects ko
haath nahi lagta. Agar aapne passcode badal diya hai to `VAULT_PASSCODE` set kar dijiye.

---

## Dhyan rakhne wali baatein

- Owner passcode ek hi hai poore vault ke liye. Share links ke apne alag passcode hote hain.
- "Download off" wala share client ko download button nahi deta aur zip block karta hai,
  lekin preview ke liye file browser tak jaati hi hai. Devtools ya screenshot se koi
  determined banda nikaal sakta hai. Ye casual protection hai, DRM nahi.
- Trycloudflare ka link har baar naya banta hai. Fixed link chahiye to Cloudflare account
  leke named tunnel setup karna padega.
- Server sirf tab tak chalta hai jab tak wo window khuli hai. Crash ho jaye to
  `Start Vault.bat` 3 second me khud restart kar deta hai aur `crash.log` likh deta hai.

---

## Agar kuch atak jaye

**Port already in use** — pichla server chal raha hai. Task Manager me `node.exe` band
kijiye, ya `PORT=4478 npm start` chala lijiye.

**Passcode bhool gayi** — `data/config.json` delete karke server restart. Naya passcode
generate hoga aur print ho jayega. Project list reset hogi (files ko kuch nahi hota).

**Project pe "folder missing"** — original folder move ya rename ho gaya. Projects me jaake
hata dijiye aur naye path se dubara add kar dijiye.

**Nayi files nahi dikh rahi** — normally khud aa jaani chahiye. Server window me
`Watching N project folder(s)` line dekhiye: agar aapka project count me nahi hai to
watcher us folder pe nahi laga (network drive ya ajeeb path ho sakta hai), aisi soorat me
**Rescan** use kariye.

**Git strip pe "sync ruka hua hai"** — us line ke niche wajah likhi hoti hai. Aksar internet
nahi hai ya credentials expire ho gaye. Ek baar terminal me `git pull` chala lijiye.

**Auto pull nahi ho raha** — 99% cases me uncommitted changes hain. Git strip me
"N local changes" dikhega. Commit ya stash kar dijiye.

**Clone pe "GitHub ne login maanga"** — private repo hai. Ya to token field bhariye, ya ek
baar terminal me `git clone` chala ke credentials save kar lijiye.

**Thumbnail nahi aa raha** — us format ka preview nahi banta (PSD, INDD waghairah).
File phir bhi download ho jayegi.
