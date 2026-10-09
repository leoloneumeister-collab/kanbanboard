import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig, COLUMNS } from './config.js';
import { Store } from './store.js';
import { Workspace } from './workspace.js';
import { Orchestrator, httpError } from './orchestrator.js';
import { createAuth } from './auth.js';
import { createMockRunner } from './agents/mockRunner.js';
import { createSdkRunner, loginStatus } from './agents/sdkRunner.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Everything except the (potentially long) log, which is fetched on demand and streamed. */
export function publicTicket(t, { full = false } = {}) {
  const { log, ...rest } = t;
  if (full) return { ...rest, log };
  const last = [...log].reverse().find((l) => l.kind === 'say' || l.kind === 'tool');
  return { ...rest, logCount: log.length, lastLog: last ? last.text.split('\n')[0].slice(0, 200) : '' };
}

const text = (v, max, name, { required = false } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw httpError(400, `${name} is required`);
  if (s.length > max) throw httpError(400, `${name} is too long (max ${max})`);
  return s;
};

export async function createApp(config, { runner } = {}) {
  const store = new Store(config.dataDir);
  const workspace = await new Workspace(config).init();
  const orchestrator = new Orchestrator({
    store,
    workspace,
    config,
    runner: runner ?? (config.agentMode === 'mock' ? createMockRunner(config) : createSdkRunner(config)),
  });
  const auth = createAuth(config);
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(express.json({ limit: '100kb' }));

  // CSRF: the session cookie is SameSite=Lax, and on top of that every write must be JSON from our own origin.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    // Not req.is(): that returns null for body-less requests such as DELETE or POST /retry.
    if (!/^application\/json\b/i.test(req.get('content-type') || '')) return next(httpError(415, 'JSON required'));
    const origin = req.get('origin');
    if (origin) {
      const host = req.get('x-forwarded-host') || req.get('host');
      let ok = false;
      try {
        ok = new URL(origin).host === host;
      } catch {}
      if (!ok) return next(httpError(403, 'Cross-origin request blocked'));
    }
    next();
  });

  app.get('/api/session', (req, res) => res.json({ authRequired: auth.enabled, authed: auth.isAuthed(req) }));
  app.post('/api/login', auth.login);
  app.post('/api/logout', auth.logout);

  const api = express.Router();
  api.use(auth.require);

  const board = () => ({
    columns: COLUMNS,
    tickets: store.list().map((t) => publicTicket(t)),
    status: orchestrator.status(),
    workspace: { base: workspace.baseBranch, pushes: config.pushBranches && workspace.remote },
  });

  api.get('/board', (req, res) => res.json(board()));

  api.post('/tickets', (req, res) => {
    const title = text(req.body.title, 200, 'Title', { required: true });
    const description = text(req.body.description, 10000, 'Description');
    const t = store.create({ title, description });
    store.addLog(t, 'system', 'Ticket created');
    if (req.body.start === true) orchestrator.move(t.id, 'in_work');
    res.status(201).json(publicTicket(t));
  });

  api.get('/tickets/:id', (req, res) => {
    const t = store.get(req.params.id);
    if (!t) throw httpError(404, 'Ticket not found');
    res.json(publicTicket(t, { full: true }));
  });

  api.patch('/tickets/:id', (req, res) => {
    const t = store.get(req.params.id);
    if (!t) throw httpError(404, 'Ticket not found');
    if (req.body.title !== undefined) t.title = text(req.body.title, 200, 'Title', { required: true });
    if (req.body.description !== undefined) t.description = text(req.body.description, 10000, 'Description');
    store.touch(t);
    res.json(publicTicket(t));
  });

  api.post('/tickets/:id/move', (req, res) => res.json(publicTicket(orchestrator.move(req.params.id, req.body.column))));
  api.post('/tickets/:id/retry', (req, res) => res.json(publicTicket(orchestrator.retry(req.params.id))));
  api.post('/tickets/:id/stop', (req, res) => res.json(publicTicket(orchestrator.stopRun(req.params.id))));
  api.post('/tickets/:id/comments', (req, res) => {
    const body = text(req.body.text, 4000, 'Comment', { required: true });
    res.status(201).json(publicTicket(orchestrator.comment(req.params.id, body, { rerun: req.body.rerun === true })));
  });
  api.delete('/tickets/:id', (req, res) => {
    orchestrator.remove(req.params.id);
    res.json({ ok: true });
  });

  // Server-Sent Events: works through phones, proxies and the iOS home-screen app without extra libraries.
  const clients = new Set();
  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  api.get('/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 20_000);
  heartbeat.unref();

  store.on('ticket', (t) => broadcast('ticket', publicTicket(t)));
  store.on('removed', (t) => broadcast('removed', { id: t.id }));
  store.on('log', (t, entry) => broadcast('log', { id: t.id, entry }));
  orchestrator.on('status', (s) => broadcast('status', s));

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(
    express.static(PUBLIC_DIR, {
      setHeaders: (res, file) => {
        if (/(sw\.js|index\.html|manifest\.webmanifest)$/.test(file)) res.set('Cache-Control', 'no-cache');
      },
    }),
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
  });

  orchestrator.start();

  async function shutdown() {
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    await orchestrator.stop();
  }

  return { app, store, orchestrator, workspace, shutdown };
}

// ---- entrypoint --------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  if (!config.allowNoAuth && !config.appPassword) {
    console.error(
      'APP_PASSWORD is not set. The board lets agents run commands on this machine, so it will not start without a password.\n' +
        'Set APP_PASSWORD=..., or ALLOW_NO_AUTH=true if it is only reachable from localhost.',
    );
    process.exit(1);
  }
  if (config.agentMode === 'api' && !process.env.ANTHROPIC_API_KEY) {
    console.warn('AGENT_MODE=api but ANTHROPIC_API_KEY is not set. Agent runs will fail until it is.');
  }
  if (config.agentMode === 'subscription') {
    const st = loginStatus(config);
    if (!st.found) {
      console.error('AGENT_MODE=subscription needs the Claude Code CLI signed in to your account.\nInstall it (npm i -g @anthropic-ai/claude-code), run `claude`, sign in, then start this again.');
      process.exit(1);
    }
    if (st.loggedIn !== true) {
      // Not fatal: the CLI's status output differs between versions. The first agent run checks the real credential.
      console.warn(`Could not confirm a Claude login via ${st.bin}. Output was:\n${String(st.raw).trim() || '(empty)'}\nIf agents fail, run \`claude\` once and sign in.`);
    }
    console.log(`Using your Claude login via ${st.bin} (${st.authMethod}). Usage counts against your plan limits.`);
  }
  const { app, shutdown, workspace } = await createApp(config);
  const server = app.listen(config.port, config.host, () => {
    console.log(`Kanban board on http://localhost:${config.port}  |  agents: ${config.agentMode}  |  repo: ${workspace.repoDir} (${workspace.baseBranch})`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`On your phone (same Wi-Fi): http://${a.address}:${config.port}`);
    }
  });
  const stop = async () => {
    server.close();
    await shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
