import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/index.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 8000, step = 20, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(step);
  }
}

/** Boots a real app on a random port with its own data dir and git repo. */
export async function boot(env = {}, opts = {}) {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    APP_PASSWORD: 'secret-pw',
    AGENT_MODE: 'mock',
    MOCK_DELAY_MS: '5',
    ...env,
  });
  const ctx = await createApp(config, opts);
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function req(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data, headers: res.headers };
  }

  const api = {
    get: (u) => req('GET', u),
    post: (u, b = {}) => req('POST', u, b),
    patch: (u, b) => req('PATCH', u, b),
    del: (u) => req('DELETE', u, undefined, { 'content-type': 'application/json' }),
    raw: req,
    login: () => req('POST', '/api/login', { password: 'secret-pw' }),
  };
  await api.login();

  const ticket = async (id) => (await api.get(`/api/tickets/${id}`)).data;
  const create = async (title, description = '', extra = {}) => (await api.post('/api/tickets', { title, description, ...extra })).data;

  async function close() {
    await ctx.shutdown();
    await new Promise((r) => server.close(r));
    if (!opts.keepData) fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { ...ctx, config, base, api, ticket, create, close, dataDir };
}
