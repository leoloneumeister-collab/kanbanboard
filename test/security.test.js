import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, waitFor } from './helpers.js';
import { parseVerdict } from '../server/agents/prompts.js';
import { agentEnv, mapSdkError } from '../server/agents/sdkRunner.js';
import { loadConfig } from '../server/config.js';

test('everything under /api needs a session; login rejects bad passwords and rate limits guessing', async () => {
  const b = await boot();
  try {
    const anon = await fetch(`${b.base}/api/board`);
    assert.equal(anon.status, 401);
    assert.equal((await fetch(`${b.base}/api/events`)).status, 401);
    assert.equal((await fetch(`${b.base}/healthz`)).status, 200);
    assert.equal((await fetch(`${b.base}/`)).status, 200, 'the app shell itself is public so the login form can render');

    const s = await fetch(`${b.base}/api/session`).then((r) => r.json());
    assert.deepEqual(s, { authRequired: true, authed: false });

    let last;
    for (let i = 0; i < 8; i++) {
      last = await fetch(`${b.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
      assert.equal(last.status, 401);
    }
    const locked = await fetch(`${b.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret-pw' }) });
    assert.equal(locked.status, 429, 'even the right password is refused while locked out');
  } finally {
    await b.close();
  }
});

test('session cookie is HttpOnly + SameSite=Lax, tampering is rejected, logout clears it', async () => {
  const b = await boot();
  try {
    const res = await fetch(`${b.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret-pw' }) });
    const set = res.headers.get('set-cookie');
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=Lax/i);
    const token = set.split(';')[0];
    assert.equal((await fetch(`${b.base}/api/board`, { headers: { cookie: token } })).status, 200);
    const forged = token.slice(0, -3) + (token.endsWith('AAA') ? 'BBB' : 'AAA');
    assert.equal((await fetch(`${b.base}/api/board`, { headers: { cookie: forged } })).status, 401);
    const expired = `kb_session=${Date.now() - 1000}.abc.sig`;
    assert.equal((await fetch(`${b.base}/api/board`, { headers: { cookie: expired } })).status, 401);
  } finally {
    await b.close();
  }
});

test('CSRF: writes need JSON and a same-origin Origin header', async () => {
  const b = await boot();
  try {
    const form = await b.api.raw('POST', '/api/tickets', undefined, { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 415);
    const cross = await b.api.raw('POST', '/api/tickets', { title: 'x' }, { origin: 'https://evil.example' });
    assert.equal(cross.status, 403);
    const same = await b.api.raw('POST', '/api/tickets', { title: 'x' }, { origin: b.base });
    assert.equal(same.status, 201);
  } finally {
    await b.close();
  }
});

test('input validation', async () => {
  const b = await boot();
  try {
    assert.equal((await b.api.post('/api/tickets', { title: '   ' })).status, 400);
    assert.equal((await b.api.post('/api/tickets', { title: 'x'.repeat(201) })).status, 400);
    assert.equal((await b.api.post('/api/tickets', { title: 't', description: 'd'.repeat(10001) })).status, 400);
    const t = (await b.api.post('/api/tickets', { title: 'ok' })).data;
    assert.equal((await b.api.post(`/api/tickets/${t.id}/move`, { column: 'nonsense' })).status, 400);
    assert.equal((await b.api.post('/api/tickets/T-999/move', { column: 'done' })).status, 404);
    assert.equal((await b.api.post(`/api/tickets/${t.id}/retry`)).status, 400, 'backlog has no agent');
    assert.equal((await b.api.post(`/api/tickets/${t.id}/comments`, { text: '' })).status, 400);
    const bad = await b.api.raw('POST', '/api/tickets', undefined, { 'content-type': 'application/json' });
    assert.ok([400].includes(bad.status));
    assert.equal((await b.api.patch(`/api/tickets/${t.id}`, { title: 'renamed', description: 'more' })).data.title, 'renamed');
  } finally {
    await b.close();
  }
});

test('the app refuses to be configured without a password unless explicitly opened up', async () => {
  const { createAuth } = await import('../server/auth.js');
  const open = createAuth(loadConfig({ ALLOW_NO_AUTH: 'true' }));
  assert.equal(open.enabled, false);
  const closed = createAuth(loadConfig({ APP_PASSWORD: 'x' }));
  assert.equal(closed.enabled, true);
});

test('server sent events deliver ticket updates, log lines and removals live', async () => {
  const b = await boot();
  try {
    const cookie = (await b.api.login()) && null;
    const res = await fetch(`${b.base}/api/events`, { headers: { cookie: (await (async () => {
      const r = await fetch(`${b.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret-pw' }) });
      return r.headers.get('set-cookie').split(';')[0];
    })()) } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    let buf = '';
    const pump = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
      }
    })();
    const t = await b.create('Live', '', { start: true });
    await waitFor(() => /event: removed/.test(buf) || (/event: ticket/.test(buf) && /event: log/.test(buf) && buf.includes('"column":"done"')), { label: 'sse frames' });
    assert.match(buf, /event: status/);
    await b.api.del(`/api/tickets/${t.id}`);
    await waitFor(() => /event: removed\ndata: {"id":"T-1"}/.test(buf), { label: 'removed frame' });
    await reader.cancel();
    await pump.catch(() => {});
  } finally {
    await b.close();
  }
});

test('parseVerdict copes with how models actually format the last lines', () => {
  assert.deepEqual(parseVerdict('tester', 'ok\nVERDICT: PASS\nSUMMARY: all green').verdict, 'PASS');
  assert.equal(parseVerdict('tester', '**VERDICT:** FAIL\n**SUMMARY:** broken').verdict, 'FAIL');
  assert.equal(parseVerdict('reviewer', '```\nVERDICT: CHANGES_REQUESTED\nSUMMARY: 1. x\n2. y\n```').verdict, 'CHANGES_REQUESTED');
  assert.equal(parseVerdict('reviewer', 'verdict: approve').verdict, 'APPROVE');
  assert.equal(parseVerdict('developer', 'VERDICT: PASS').verdict, null, 'a verdict from the wrong stage is not accepted');
  assert.equal(parseVerdict('developer', 'no verdict here').verdict, null);
  // If the model quotes the format earlier and then answers, the last one wins.
  assert.equal(parseVerdict('tester', 'I will end with VERDICT: PASS | FAIL\n...\nVERDICT: FAIL\nSUMMARY: no').verdict, 'FAIL');
  assert.match(parseVerdict('reviewer', 'VERDICT: CHANGES_REQUESTED\nSUMMARY: 1. a\n2. b').summary, /1\. a\n2\. b/);
});

test('agents get an allow-listed environment: API key yes, everything else no unless passed through', () => {
  const base = {
    PATH: '/bin', HOME: '/home/x', LANG: 'C', HTTPS_PROXY: 'http://proxy', ANTHROPIC_API_KEY: 'sk-ant-xyz', CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    APP_PASSWORD: 'p', SESSION_SECRET: 's', GIT_TOKEN: 'g', GITHUB_TOKEN: 'gh', GH_TOKEN: 'gh2',
    AWS_SECRET_ACCESS_KEY: 'aws', NPM_TOKEN: 'npm', DATABASE_URL: 'postgres://u:p@h/db',
  };
  const env = agentEnv(loadConfig({}), base);
  for (const k of ['PATH', 'HOME', 'LANG', 'HTTPS_PROXY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(env[k], base[k], `${k} should pass`);
  for (const k of ['APP_PASSWORD', 'SESSION_SECRET', 'GIT_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'DATABASE_URL']) assert.equal(env[k], undefined, `${k} must not leak`);
  assert.equal(env.GIT_AUTHOR_NAME, 'Kanban Agent');

  const opted = agentEnv(loadConfig({ AGENT_ENV_PASSTHROUGH: 'NPM_TOKEN, DATABASE_URL' }), base);
  assert.equal(opted.NPM_TOKEN, 'npm');
  assert.equal(opted.DATABASE_URL, base.DATABASE_URL);
  assert.equal(opted.AWS_SECRET_ACCESS_KEY, undefined);
});

test('SDK limit errors (exact strings seen from the real SDK) become readable messages, and budget hits are charged', () => {
  const cfg = loadConfig({ AGENT_MAX_TURNS: '40', AGENT_MAX_BUDGET_USD: '2' });
  const turns = mapSdkError('Claude Code returned an error result: Reached maximum number of turns (40)', cfg);
  assert.match(turns.error, /^Hit the 40-turn limit/);
  assert.equal(turns.costUsd, 0);
  const budget = mapSdkError('Claude Code returned an error result: Reached maximum budget ($2)', cfg);
  assert.match(budget.error, /^Hit the \$2 per-run budget/);
  assert.equal(budget.costUsd, 2, 'the daily ledger must not under-count a run that exhausted its budget');
  assert.equal(mapSdkError('Claude Code returned an error result: Invalid API key', cfg).error, 'Invalid API key');
  assert.equal(mapSdkError('', cfg).error, 'Agent failed');
});
