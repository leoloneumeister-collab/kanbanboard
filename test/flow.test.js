import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { boot, waitFor, sleep } from './helpers.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('happy path: In Work -> Testing -> Review -> Done, on its own branch with real commits', async () => {
  const b = await boot();
  try {
    const t = await b.create('Add greeting', 'Say hello');
    assert.equal(t.column, 'backlog');
    assert.equal(t.status, 'idle');

    await b.api.post(`/api/tickets/${t.id}/move`, { column: 'in_work' });
    const done = await waitFor(async () => {
      const x = await b.ticket(t.id);
      return x.column === 'done' && x.status === 'idle' ? x : null;
    }, { label: 'ticket reaching done' });

    assert.deepEqual(done.runs.map((r) => r.stage), ['developer', 'tester', 'reviewer']);
    assert.deepEqual(done.runs.map((r) => r.outcome), ['done', 'pass', 'approve']);
    assert.ok(done.costUsd > 0);
    assert.match(done.branch, /^kanban\/t-1-add-greeting$/);

    // Real git work happened: the branch has commits that main does not, and main is untouched.
    const ahead = git(b.workspace.repoDir, 'rev-list', '--count', `main..${done.branch}`);
    assert.ok(Number(ahead) >= 1, 'branch should be ahead of main');
    assert.equal(git(b.workspace.repoDir, 'rev-list', '--count', 'main'), '1', 'main must be untouched');
    assert.ok(fs.existsSync(path.join(b.dataDir, 'worktrees', t.id, 't-1.md')));

    const verdicts = done.log.filter((l) => l.kind === 'verdict').map((l) => l.text.split(':')[0]);
    assert.deepEqual(verdicts, ['DONE', 'PASS', 'APPROVE']);
  } finally {
    await b.close();
  }
});

test('"Add & start" creates the ticket straight in In Work', async () => {
  const b = await boot();
  try {
    const t = await b.create('Quick one', '', { start: true });
    const x = await b.ticket(t.id);
    assert.equal(x.column, 'in_work');
    await waitFor(async () => (await b.ticket(t.id)).column === 'done', { label: 'done' });
  } finally {
    await b.close();
  }
});

test('tester FAIL sends the ticket back to In Work with the failure details, then it recovers', async () => {
  const b = await boot();
  try {
    const t = await b.create('Handle empty input', 'Must cope with nothing. [fail-test]');
    await b.api.post(`/api/tickets/${t.id}/move`, { column: 'in_work' });
    const done = await waitFor(async () => {
      const x = await b.ticket(t.id);
      return x.column === 'done' ? x : null;
    }, { label: 'recovery to done' });

    assert.equal(done.loops, 1);
    assert.deepEqual(done.runs.map((r) => `${r.stage}:${r.outcome}`), [
      'developer:done', 'tester:fail', 'developer:done', 'tester:pass', 'reviewer:approve',
    ]);
    assert.equal(done.feedback, null, 'feedback is cleared once the developer addressed it');
  } finally {
    await b.close();
  }
});

test('reviewer CHANGES_REQUESTED sends it back and the developer prompt carries the review', async () => {
  const prompts = [];
  const { createMockRunner } = await import('../server/agents/mockRunner.js');
  const b = await boot({}, {});
  const inner = createMockRunner(b.config);
  b.orchestrator.runner = {
    name: 'mock',
    run: async (args) => {
      prompts.push({ stage: args.stage, prompt: args.prompt });
      return inner.run(args);
    },
  };
  try {
    const t = await b.create('Error handling', 'Do it. [fail-review]');
    await b.api.post(`/api/tickets/${t.id}/move`, { column: 'in_work' });
    await waitFor(async () => (await b.ticket(t.id)).column === 'done', { label: 'done' });
    const devPrompts = prompts.filter((p) => p.stage === 'developer');
    assert.equal(devPrompts.length, 2);
    assert.doesNotMatch(devPrompts[0].prompt, /came back from/);
    assert.match(devPrompts[1].prompt, /came back from reviewer/);
    assert.match(devPrompts[1].prompt, /Errors are swallowed/);
  } finally {
    await b.close();
  }
});

test('send-back loop is capped and parks the ticket for a human instead of burning money forever', async () => {
  const alwaysFail = {
    name: 'mock',
    async run({ stage, cwd, ticket }) {
      if (stage === 'developer') {
        fs.writeFileSync(path.join(cwd, `${ticket.id}-${ticket.loops}.txt`), 'x');
        return { text: 'VERDICT: DONE\nSUMMARY: ok', costUsd: 0.01 };
      }
      return { text: 'Broken.\nVERDICT: FAIL\nSUMMARY: still broken', costUsd: 0.01 };
    },
  };
  const b = await boot({ MAX_LOOPS: '2' }, { runner: alwaysFail });
  try {
    const t = await b.create('Impossible', '');
    await b.api.post(`/api/tickets/${t.id}/move`, { column: 'in_work' });
    const x = await waitFor(async () => {
      const y = await b.ticket(t.id);
      return y.status === 'blocked' ? y : null;
    }, { label: 'blocked after cap' });
    assert.equal(x.column, 'testing');
    assert.equal(x.loops, 3);
    assert.match(x.statusNote, /Sent back 2 times/);
    assert.equal(x.runs.filter((r) => r.stage === 'developer').length, 3);
    await sleep(100);
    assert.equal((await b.ticket(t.id)).runs.length, x.runs.length, 'no more runs after the cap');

    // A human retry resets the counter, so the whole capped cycle runs again:
    // tester, dev, tester, dev, tester = 5 more runs. Without the reset it would block after 1.
    await b.api.post(`/api/tickets/${t.id}/retry`);
    const y = await waitFor(async () => {
      const z = await b.ticket(t.id);
      return z.status === 'blocked' && z.runs.length > x.runs.length ? z : null;
    }, { label: 'retry cycle finished' });
    assert.equal(y.runs.length - x.runs.length, 5);
    assert.equal(y.loops, 3);
  } finally {
    await b.close();
  }
});

test('developer says DONE but changed nothing: blocked, not advanced', async () => {
  const lazy = { name: 'mock', run: async () => ({ text: 'VERDICT: DONE\nSUMMARY: all good', costUsd: 0.01 }) };
  const b = await boot({}, { runner: lazy });
  try {
    const t = await b.create('Ghost work', '');
    await b.api.post(`/api/tickets/${t.id}/move`, { column: 'in_work' });
    const x = await waitFor(async () => {
      const y = await b.ticket(t.id);
      return y.status === 'blocked' ? y : null;
    }, { label: 'blocked' });
    assert.equal(x.column, 'in_work');
    assert.match(x.statusNote, /no changes/);
  } finally {
    await b.close();
  }
});

test('missing verdict, agent error and BLOCKED are surfaced, never silently advanced', async () => {
  const scripted = {
    name: 'mock',
    async run({ ticket, cwd }) {
      if (ticket.title === 'no-verdict') return { text: 'I did some stuff', costUsd: 0.02 };
      if (ticket.title === 'error') return { text: '', costUsd: 0.03, error: 'Hit the 40-turn limit' };
      return { text: 'VERDICT: BLOCKED\nSUMMARY: Which database should I use?', costUsd: 0 };
    },
  };
  const b = await boot({}, { runner: scripted });
  try {
    const ids = {};
    for (const title of ['no-verdict', 'error', 'ask']) {
      const t = await b.create(title, '');
      ids[title] = t.id;
      await b.api.post(`/api/tickets/${t.id}/move`, { column: 'in_work' });
    }
    const settled = async (id) => waitFor(async () => {
      const y = await b.ticket(id);
      return ['blocked', 'failed'].includes(y.status) ? y : null;
    }, { label: id });

    const nv = await settled(ids['no-verdict']);
    assert.equal(nv.status, 'blocked');
    assert.match(nv.statusNote, /without a verdict/);
    assert.equal(nv.costUsd, 0.02);

    const er = await settled(ids.error);
    assert.equal(er.status, 'failed');
    assert.equal(er.costUsd, 0.03, 'cost of a failed run still counts');

    const ask = await settled(ids.ask);
    assert.equal(ask.status, 'blocked');
    assert.equal(ask.statusNote, 'Which database should I use?');
    for (const x of [nv, er, ask]) assert.equal(x.column, 'in_work');
  } finally {
    await b.close();
  }
});

test('moving a running ticket away cancels the run and nothing it produces is applied', async () => {
  let aborted = false;
  let started = false;
  const slow = {
    name: 'mock',
    run: ({ signal }) => new Promise((resolve, reject) => {
      started = true;
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
      setTimeout(() => resolve({ text: 'VERDICT: DONE\nSUMMARY: late', costUsd: 1 }), 400);
    }),
  };
  const b = await boot({}, { runner: slow });
  try {
    const t = await b.create('Slow', '');
    await b.api.post(`/api/tickets/${t.id}/move`, { column: 'in_work' });
    await waitFor(() => started, { label: 'runner entered' });
    await b.api.post(`/api/tickets/${t.id}/move`, { column: 'backlog' });
    await sleep(600);
    const x = await b.ticket(t.id);
    assert.ok(aborted, 'runner received the abort signal');
    assert.equal(x.column, 'backlog');
    assert.equal(x.status, 'idle');
    assert.equal(x.runs[0].outcome, 'cancelled');
    assert.equal(x.costUsd, 0);
  } finally {
    await b.close();
  }
});

test('stop button aborts a run and blocks the ticket; deleting removes the worktree but keeps the branch', async () => {
  const hang = { name: 'mock', run: ({ signal, cwd, ticket }) => new Promise((_, reject) => {
    fs.writeFileSync(path.join(cwd, 'wip.txt'), 'x');
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }) };
  const b = await boot({}, { runner: hang });
  try {
    const t = await b.create('Hangs', '');
    await b.api.post(`/api/tickets/${t.id}/move`, { column: 'in_work' });
    await waitFor(() => fs.existsSync(path.join(b.dataDir, 'worktrees', t.id, 'wip.txt')), { label: 'runner entered' });
    const stopped = await b.api.post(`/api/tickets/${t.id}/stop`);
    assert.equal(stopped.data.status, 'blocked');
    assert.equal(stopped.data.statusNote, 'Stopped by you');
    assert.equal((await b.api.post(`/api/tickets/${t.id}/stop`)).status, 409);

    const branch = (await b.ticket(t.id)).branch;
    await b.api.del(`/api/tickets/${t.id}`);
    assert.equal((await b.api.get(`/api/tickets/${t.id}`)).status, 404);
    await waitFor(() => !fs.existsSync(path.join(b.dataDir, 'worktrees', t.id)), { label: 'worktree removed' });
    assert.match(git(b.workspace.repoDir, 'branch', '--list', branch), /kanban\/t-1-hangs/);
  } finally {
    await b.close();
  }
});

test('concurrency limit is respected and queued tickets start as slots free up', async () => {
  let current = 0;
  let peak = 0;
  const counting = {
    name: 'mock',
    async run({ stage, cwd, ticket }) {
      current++;
      peak = Math.max(peak, current);
      await sleep(40);
      current--;
      if (stage === 'developer') fs.writeFileSync(path.join(cwd, 'f.txt'), ticket.id);
      return { text: stage === 'developer' ? 'VERDICT: DONE\nSUMMARY: ok' : stage === 'tester' ? 'VERDICT: PASS\nSUMMARY: ok' : 'VERDICT: APPROVE\nSUMMARY: ok', costUsd: 0 };
    },
  };
  const b = await boot({ MAX_CONCURRENT_AGENTS: '2' }, { runner: counting });
  try {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await b.create(`Job ${i}`, '', { start: true })).id);
    await waitFor(async () => {
      const all = await Promise.all(ids.map((id) => b.ticket(id)));
      return all.every((x) => x.column === 'done');
    }, { timeout: 15000, label: 'all five done' });
    assert.equal(peak, 2);
  } finally {
    await b.close();
  }
});

test('daily budget pauses the queue instead of overspending', async () => {
  const b = await boot({ DAILY_BUDGET_USD: '0.015' });
  try {
    const t = await b.create('Pricey', '', { start: true });
    // developer (0.01) then tester (0.01) pushes spend past 0.015; the reviewer must wait.
    const x = await waitFor(async () => {
      const y = await b.ticket(t.id);
      return y.column === 'review' && y.status === 'queued' ? y : null;
    }, { label: 'paused in review' });
    assert.equal(x.statusNote, 'Waiting: daily budget reached');
    const board = (await b.api.get('/api/board')).data;
    assert.equal(board.status.paused, true);
    assert.ok(board.status.spentToday >= 0.02);
    assert.equal(board.status.running, 0);
  } finally {
    await b.close();
  }
});

test('restart recovery: a ticket that was mid-run when the server died is re-queued and finishes', async () => {
  const dataDir = (await import('node:fs')).mkdtempSync(path.join((await import('node:os')).tmpdir(), 'kanban-restart-'));
  const hang = { name: 'mock', run: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('x')))) };
  let id;
  const first = await boot({}, { dataDir, runner: hang, keepData: true });
  try {
    id = (await first.create('Survivor', '', { start: true })).id;
    await waitFor(async () => (await first.ticket(id)).status === 'running', { label: 'running' });
  } finally {
    await first.close(); // flushes state with the ticket still "running"
  }
  const second = await boot({}, { dataDir });
  try {
    const x = await waitFor(async () => {
      const y = await second.ticket(id);
      return y.column === 'done' ? y : null;
    }, { label: 'resumed and done' }).catch(async (err) => {
      const y = await second.ticket(id);
      throw new Error(`${err.message}: ${JSON.stringify({ column: y.column, status: y.status, note: y.statusNote, runs: y.runs, log: y.log.slice(-6) })}`);
    });
    assert.equal(x.title, 'Survivor');
  } finally {
    await second.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('human comment with rerun re-queues a blocked ticket and the comment reaches the developer', async () => {
  let n = 0;
  const seen = [];
  const asks = {
    name: 'mock',
    async run({ stage, cwd, prompt }) {
      seen.push(prompt);
      if (stage !== 'developer') return { text: stage === 'tester' ? 'VERDICT: PASS\nSUMMARY: ok' : 'VERDICT: APPROVE\nSUMMARY: ok', costUsd: 0 };
      if (n++ === 0) return { text: 'VERDICT: BLOCKED\nSUMMARY: Postgres or SQLite?', costUsd: 0 };
      fs.writeFileSync(path.join(cwd, 'db.txt'), 'sqlite');
      return { text: 'VERDICT: DONE\nSUMMARY: used sqlite', costUsd: 0 };
    },
  };
  const b = await boot({}, { runner: asks });
  try {
    const t = await b.create('Pick a DB', '', { start: true });
    await waitFor(async () => (await b.ticket(t.id)).status === 'blocked', { label: 'blocked' });
    await b.api.post(`/api/tickets/${t.id}/comments`, { text: 'Use SQLite.', rerun: true });
    await waitFor(async () => (await b.ticket(t.id)).column === 'done', { label: 'done' });
    assert.match(seen[1], /Notes from the human[\s\S]*Use SQLite\./);
  } finally {
    await b.close();
  }
});

test('with AUTO_DONE=false an approved ticket waits in Review for a human', async () => {
  const b = await boot({ AUTO_DONE: 'false' });
  try {
    const t = await b.create('Needs sign-off', '', { start: true });
    const x = await waitFor(async () => {
      const y = await b.ticket(t.id);
      return y.status === 'approved' ? y : null;
    }, { label: 'approved' });
    assert.equal(x.column, 'review');
    await b.api.post(`/api/tickets/${t.id}/move`, { column: 'done' });
    assert.equal((await b.ticket(t.id)).column, 'done');
  } finally {
    await b.close();
  }
});

test('a half-created worktree directory from a crash is cleaned up instead of failing the ticket forever', async () => {
  const b = await boot({}, {});
  try {
    const t = await b.create('Crash victim', '');
    // Simulate a kill -9 in the middle of `git worktree add`: directory exists, no valid worktree inside.
    const dir = path.join(b.dataDir, 'worktrees', t.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'leftover.tmp'), 'junk');
    await b.api.post(`/api/tickets/${t.id}/move`, { column: 'in_work' });
    const x = await waitFor(async () => {
      const y = await b.ticket(t.id);
      return y.column === 'done' ? y : null;
    }, { label: 'recovered and done' });
    assert.ok(!fs.existsSync(path.join(dir, 'leftover.tmp')));
    assert.equal(x.runs[0].outcome, 'done');
  } finally {
    await b.close();
  }
});
