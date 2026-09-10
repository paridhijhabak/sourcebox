'use strict';
/* Shared plumbing so every suite talks to the same disposable fixture project
 * instead of whatever happens to be registered on this machine. */
const fixture = require('./fixture');

const BASE = process.env.VAULT_URL || 'http://localhost:4477';
const PASSCODE = process.env.VAULT_PASSCODE || 'primetime';
const FIXTURE_PROJECT = 'vault-test-fixture';

function makeClient() {
  let cookie = '';
  async function call(p, o = {}) {
    const headers = Object.assign({}, o.headers);
    if (cookie) headers.Cookie = cookie;
    if (o.body && typeof o.body !== 'string' && !(o.body instanceof FormData)) {
      o = Object.assign({}, o, { body: JSON.stringify(o.body) });
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(BASE + p, Object.assign({}, o, { headers, redirect: 'manual' }));
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) cookie = c.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : null, res };
  }
  return {
    call,
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
  };
}

function reporter() {
  const state = { pass: 0, fail: 0 };
  const ok = (label, cond, extra) => {
    if (cond) { state.pass++; console.log('  PASS  ' + label); }
    else {
      state.fail++;
      console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 300) : ''));
    }
  };
  const finish = (noun) => {
    const total = state.pass + state.fail;
    console.log('\n' + (state.fail ? 'FAILED ' + state.fail + ' / ' : 'ALL ') + total + ' ' + noun + '\n');
    process.exit(state.fail ? 1 : 0);
  };
  return { ok, state, finish };
}

async function login(client) {
  const r = await client.call('/api/login', { method: 'POST', body: { passcode: PASSCODE } });
  if (r.status !== 200) {
    console.error('\nLogin failed. Set VAULT_PASSCODE to this install\'s passcode ' +
      '(server prints it on first run) and try again.\n');
    process.exit(2);
  }
  return r;
}

/** Rebuilds the fixture on disk and (re)registers it as a project. */
async function ensureFixture(client) {
  const root = fixture.build();
  await client.call('/api/projects/' + FIXTURE_PROJECT, { method: 'DELETE' });
  const add = await client.call('/api/projects', {
    method: 'POST',
    body: { name: 'Vault Test Fixture', root },
  });
  if (add.status !== 200) throw new Error('fixture project could not be registered: ' + JSON.stringify(add.body));
  return { id: add.body.id, root };
}

async function removeFixture(client, id) {
  if (id) await client.call('/api/projects/' + id, { method: 'DELETE' });
  fixture.destroy();
}

/** Streams SSE frames into a callback until the returned function is called. */
function listen(client, onEvent) {
  const controller = new AbortController();
  (async () => {
    const res = await fetch(BASE + '/api/events', {
      headers: { Cookie: client.cookie },
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop();
      for (const frame of frames) {
        const ev = (frame.match(/^event: (.+)$/m) || [])[1];
        const data = (frame.match(/^data: (.+)$/m) || [])[1];
        if (ev && data) onEvent(ev, JSON.parse(data));
      }
    }
  })().catch(() => {});
  return () => controller.abort();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  BASE, PASSCODE, FIXTURE_PROJECT,
  makeClient, reporter, login, ensureFixture, removeFixture, listen, wait, fixture,
};
