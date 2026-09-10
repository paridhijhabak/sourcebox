/* Layman-language fuzzy search for the vault.
 *
 * People do not search by filename. They type "wo red wala logo",
 * "insta post hindi", "tshirt print file". So a query is expanded through a
 * synonym table (English + Hinglish), matched against the filename AND the
 * folder path, and finally softened with a subsequence matcher for typos.
 */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------- vocabulary */

  // Words that carry no signal in either language.
  const STOP = new Set([
    'a', 'an', 'the', 'of', 'for', 'and', 'or', 'with', 'in', 'on', 'to', 'from',
    'me', 'my', 'mine', 'is', 'are', 'was', 'that', 'this', 'it', 'all', 'any',
    'show', 'find', 'get', 'give', 'want', 'need', 'please', 'file', 'files',
    'wala', 'wali', 'wale', 'ka', 'ki', 'ke', 'ko', 'se', 'mai', 'main', 'mein',
    'hai', 'hain', 'tha', 'thi', 'the', 'ho', 'hoga', 'chahiye', 'chaiye',
    'mujhe', 'meko', 'muje', 'mereko', 'dikhao', 'dikha', 'do', 'dedo', 'batao',
    'kaun', 'kaunsa', 'konsa', 'jo', 'wo', 'woh', 'vo', 'yeh', 'ye', 'kuch',
    'aur', 'bhi', 'sab', 'sabhi', 'nikal', 'nikalo', 'chahta', 'chahti',
  ]);

  // Each row is one concept. Every word in a row matches every other word.
  const SYNONYM_GROUPS = [
    ['logo', 'logos', 'brandmark', 'mark', 'symbol', 'monogram', 'lockup', 'wordmark', 'emblem', 'chinh', 'laogo'],
    ['icon', 'favicon', 'appicon', 'launcher', 'tile'],
    ['red', 'lal', 'laal', 'crimson', 'maroon', 'scarlet'],
    ['black', 'kala', 'kaala', 'dark', 'noir', 'blackout'],
    ['white', 'safed', 'light', 'reverse', 'reversed', 'knockout'],
    ['yellow', 'peela', 'pila', 'gold', 'golden', 'amber'],
    ['blue', 'neela', 'nila'], ['green', 'hara'], ['cream', 'beige', 'offwhite', 'ivory'],
    ['instagram', 'insta', 'ig', 'gram'],
    ['reel', 'reels', 'shorts', 'short'],
    ['story', 'stories', 'status'],
    ['post', 'posts', 'feed', 'creative'],
    ['carousel', 'slides', 'slide', 'swipe'],
    ['facebook', 'fb', 'meta'],
    ['linkedin', 'li', 'linked'],
    ['twitter', 'tweet', 'tweets'],
    ['youtube', 'yt', 'ytube'],
    ['thumbnail', 'thumb', 'thumbnails'],
    ['whatsapp', 'wa', 'whatsup', 'dp'],
    ['reddit', 'subreddit'],
    ['tshirt', 'shirt', 'tee', 'tees', 'apparel', 'merch', 'merchandise', 'tishirt', 'teeshirt'],
    ['visitingcard', 'businesscard', 'vc', 'namecard', 'visiting'],
    ['idcard', 'identity', 'badge', 'employee', 'staff', 'pass'],
    ['card', 'cards'],
    ['letterhead', 'letter', 'stationery', 'stationary', 'stationaries'],
    ['envelope', 'envelop', 'lifafa', 'envelopes'],
    ['sticker', 'stickers', 'label', 'labels', 'decal'],
    ['notepad', 'notebook', 'diary', 'pad', 'jotter'],
    ['nameplate', 'plate', 'signage', 'signboard', 'board', 'plaque'],
    ['door', 'doorsticker', 'gate'],
    ['banner', 'cover', 'header', 'hero', 'masthead'],
    ['mockup', 'mock', 'mockups', 'presentation', 'render', 'preview'],
    ['video', 'clip', 'film', 'motion', 'animation', 'footage', 'movie'],
    ['guidelines', 'guideline', 'guide', 'manual', 'rundown', 'brandbook', 'brandguide', 'handbook'],
    ['hindi', 'regional', 'devanagari', 'desi', 'bhasha'],
    ['english', 'eng'],
    ['poster', 'flyer', 'handbill', 'artwork', 'art'],
    ['font', 'typeface', 'type', 'typography', 'fonts'],
    ['colour', 'color', 'palette', 'swatch', 'swatches', 'rang'],
    ['source', 'editable', 'open', 'working', 'raw', 'master'],
    ['final', 'approved', 'latest', 'locked', 'signedoff'],
    ['draft', 'wip', 'exploration', 'explorations', 'concept', 'option', 'options', 'variation', 'variations', 'trial'],
    ['square', '1x1'], ['portrait', 'vertical', 'tall'], ['landscape', 'horizontal', 'wide'],
    ['print', 'printing', 'cmyk', 'press', 'chhapai'],
    ['digital', 'web', 'screen', 'rgb', 'online'],
    ['mike', 'mic', 'microphone'],
    ['news', 'breaking', 'headline', 'khabar', 'samachar'],
    ['qr', 'qrcode'],
    ['tagline', 'slogan', 'strapline'],
    ['research', 'docs', 'documentation', 'notes', 'brief'],
    ['clearspace', 'safezone', 'padding', 'margin'],
  ];

  // Query words that mean "give me this kind of file", regardless of name.
  const KIND_WORDS = {
    image: 'image', images: 'image', photo: 'image', photos: 'image', picture: 'image',
    pictures: 'image', pic: 'image', pics: 'image', png: 'image', jpg: 'image',
    jpeg: 'image', raster: 'image', tasveer: 'image',
    vector: 'vector', svg: 'vector', scalable: 'vector',
    video: 'video', videos: 'video', mp4: 'video',
    pdf: 'pdf', pdfs: 'pdf',
    ai: 'design', psd: 'design', illustrator: 'design', photoshop: 'design',
    design: 'design', editable: 'design', sourcefile: 'design', figma: 'design',
    doc: 'doc', docs: 'doc', document: 'doc', documents: 'doc', readme: 'doc', md: 'doc',
    font: 'font', fonts: 'font', otf: 'font', ttf: 'font',
    zip: 'archive', archive: 'archive',
    audio: 'audio', sound: 'audio', music: 'audio',
  };

  const ALIAS = new Map();
  SYNONYM_GROUPS.forEach((group, gi) => {
    for (const word of group) {
      if (!ALIAS.has(word)) ALIAS.set(word, []);
      ALIAS.get(word).push(gi);
    }
  });

  /* ------------------------------------------------------------ helpers */

  function normalize(text) {
    return String(text)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-.+/\\()[\]{}#@&,'"]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function tokenize(text) {
    return normalize(text).split(' ').filter(Boolean);
  }

  /** Merges "t shirt" back into "tshirt" so the synonym table can see it. */
  function glue(tokens) {
    const out = tokens.slice();
    for (let i = 0; i < tokens.length - 1; i++) out.push(tokens[i] + tokens[i + 1]);
    return out;
  }

  const VOCAB = [...ALIAS.keys()];
  const nearMissCache = new Map();

  function groupsFor(word) {
    const direct = ALIAS.get(word);
    if (direct) return direct;
    // Tolerate simple plurals so "logos" hits "logo".
    if (word.endsWith('s') && ALIAS.has(word.slice(0, -1))) return ALIAS.get(word.slice(0, -1));
    if (word.endsWith('es') && ALIAS.has(word.slice(0, -2))) return ALIAS.get(word.slice(0, -2));
    return null;
  }

  /* A misspelled query word still has to reach its concept: "instgram" must
   * find the 01_Instagram folder even though no filename says "instgram". */
  function groupsForFuzzy(word) {
    const exact = groupsFor(word);
    if (exact) return exact;
    if (word.length < 4) return null;
    if (nearMissCache.has(word)) return nearMissCache.get(word);
    let best = null;
    let bestScore = 0.86;
    for (const candidate of VOCAB) {
      if (Math.abs(candidate.length - word.length) > 3) continue;
      const s = Math.max(fuzzy(word, candidate), fuzzy(candidate, word));
      if (s > bestScore) { bestScore = s; best = candidate; }
    }
    const groups = best ? ALIAS.get(best) : null;
    nearMissCache.set(word, groups);
    return groups;
  }

  /** Ordered-subsequence score, rewarding consecutive runs and word starts. */
  function fuzzy(needle, haystack) {
    if (!needle || !haystack) return 0;
    if (needle.length < 3 || needle.length > haystack.length) return 0;
    let hi = 0;
    let hits = 0;
    let run = 0;
    let best = 0;
    let firstAt = -1;
    for (let ni = 0; ni < needle.length; ni++) {
      const ch = needle[ni];
      let found = -1;
      for (let j = hi; j < haystack.length; j++) {
        if (haystack[j] === ch) { found = j; break; }
      }
      if (found < 0) { run = 0; continue; }
      if (firstAt < 0) firstAt = found;
      run = found === hi ? run + 1 : 1;
      best = Math.max(best, run);
      hits++;
      hi = found + 1;
    }
    const coverage = hits / needle.length;
    if (coverage < 0.82) return 0;
    const density = best / needle.length;
    const early = firstAt <= 0 ? 1 : Math.max(0, 1 - firstAt / 24);
    return coverage * (0.45 + 0.4 * density + 0.15 * early);
  }

  /* --------------------------------------------------------- preparation */

  /** Attach the searchable shadow fields to a file record, once. */
  function prepare(file) {
    if (file._ready) return file;
    const nameTokens = tokenize(file.n.replace(/\.[^.]+$/, ''));
    const pathTokens = tokenize(file.d || '');
    const nameFlat = nameTokens.join('');
    const pathFlat = pathTokens.join('');

    const groups = new Set();
    for (const word of glue(nameTokens)) {
      const g = groupsFor(word);
      if (g) for (const gi of g) groups.add(gi);
    }
    const pathGroups = new Set();
    for (const word of glue(pathTokens)) {
      const g = groupsFor(word);
      if (g) for (const gi of g) pathGroups.add(gi);
    }

    file._nameTokens = nameTokens;
    file._pathTokens = new Set(pathTokens);
    file._nameFlat = nameFlat;
    file._pathFlat = pathFlat;
    file._nameJoined = nameTokens.join(' ');
    file._groups = groups;
    file._pathGroups = pathGroups;
    file._ready = true;
    return file;
  }

  function parseQuery(raw) {
    const tokens = tokenize(raw);
    const meaningful = tokens.filter((t) => !STOP.has(t));
    const words = meaningful.length ? meaningful : tokens;
    const terms = [];
    const kinds = new Set();
    for (const word of words) {
      if (KIND_WORDS[word]) kinds.add(KIND_WORDS[word]);
      terms.push({ word, groups: new Set(groupsForFuzzy(word) || []) });
    }
    // A pure kind query ("sare videos") should not also demand the literal word.
    const onlyKinds = terms.length > 0 && terms.every((t) => KIND_WORDS[t.word] && !t.groups.size);
    return {
      raw: normalize(raw),
      flat: normalize(raw).replace(/ /g, ''),
      terms: onlyKinds ? [] : terms,
      kinds,
      empty: !tokens.length,
    };
  }

  /* -------------------------------------------------------------- scoring */

  function scoreTerm(term, file) {
    const { word, groups } = term;
    let best = 0;

    for (const nameToken of file._nameTokens) {
      if (nameToken === word) { best = Math.max(best, 100); continue; }
      if (nameToken.startsWith(word)) best = Math.max(best, 82);
      else if (nameToken.includes(word)) best = Math.max(best, 68);
    }
    if (best < 68 && file._nameFlat.includes(word)) best = Math.max(best, 62);

    if (groups.size) {
      for (const gi of groups) {
        if (file._groups.has(gi)) { best = Math.max(best, 74); break; }
      }
      if (best < 44) {
        for (const gi of groups) {
          if (file._pathGroups.has(gi)) { best = Math.max(best, 44); break; }
        }
      }
    }

    if (best < 46) {
      if (file._pathTokens.has(word)) best = Math.max(best, 46);
      else if (file._pathFlat.includes(word)) best = Math.max(best, 32);
    }

    if (best < 40) {
      if (word === file.e) best = Math.max(best, 88);
      const f = fuzzy(word, file._nameJoined) || fuzzy(word, file._nameFlat);
      if (f) best = Math.max(best, Math.round(f * 46));
    }
    if (best < 28) {
      const f = fuzzy(word, file._pathFlat);
      if (f) best = Math.max(best, Math.round(f * 28));
    }
    return best;
  }

  function scoreFile(file, query) {
    let total = 0;
    let missed = 0;

    if (query.flat.length >= 3) {
      if (file._nameFlat.includes(query.flat)) total += 120;
      else if (file._nameJoined.includes(query.raw)) total += 100;
    }

    for (const term of query.terms) {
      const s = scoreTerm(term, file);
      if (s === 0) missed++;
      total += s;
    }

    if (query.kinds.size) {
      total += query.kinds.has(file.k) ? 90 : -55;
    }

    // Every word should mean something. If some did not, keep the file but
    // push it well below the ones that matched fully.
    if (missed && query.terms.length) {
      const hitRatio = (query.terms.length - missed) / query.terms.length;
      if (hitRatio === 0) return 0;
      total *= 0.18 + 0.55 * hitRatio;
    }

    // Nudge the things people usually mean: finals over drafts, real assets
    // over the flattened previews that sit beside them.
    if (/final|approved|master/.test(file._pathFlat + file._nameFlat)) total += 8;
    if (/preview|_vtmp|temp/.test(file._pathFlat)) total -= 22;
    if (file.k === 'image' || file.k === 'vector') total += 4;

    return total;
  }

  /* ---------------------------------------------------------------- api */

  function search(files, rawQuery) {
    const query = parseQuery(rawQuery || '');
    if (query.empty) return files.map((f) => ({ file: f, score: 0 }));

    const out = [];
    for (const file of files) {
      prepare(file);
      const score = scoreFile(file, query);
      if (score > 24) out.push({ file, score });
    }
    out.sort((a, b) => b.score - a.score || a.file.n.localeCompare(b.file.n));
    return out;
  }

  /** Suggests what the user could have meant when a query returns nothing. */
  function didYouMean(files, rawQuery, limit) {
    const words = tokenize(rawQuery).filter((w) => !STOP.has(w) && w.length > 2);
    if (!words.length) return [];
    const pool = new Map();
    for (const file of files) {
      prepare(file);
      for (const token of file._nameTokens) {
        if (token.length < 3) continue;
        pool.set(token, (pool.get(token) || 0) + 1);
      }
    }
    const scored = [];
    for (const [token, count] of pool) {
      let best = 0;
      for (const word of words) best = Math.max(best, fuzzy(word, token), fuzzy(token, word));
      if (best > 0.55) scored.push({ token, score: best * Math.log2(count + 2) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit || 5).map((s) => s.token);
  }

  global.VaultSearch = { search, prepare, normalize, tokenize, didYouMean, KIND_WORDS };
})(window);
