import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { agentFor, COLUMN_IDS } from './config.js';
import { buildPrompt, parseVerdict } from './agents/prompts.js';

const FEEDBACK_MAX = 6000;
const stripVerdict = (text) => String(text).replace(/^.*\bVERDICT:.*$/gim, '').trim().slice(0, FEEDBACK_MAX);

/**
 * Moves tickets through the board and runs the right agent for the column a ticket sits in:
 *
 *   In Work  -> developer -> Testing
 *   Testing  -> tester    -> Review   (FAIL: back to In Work with the failure details)
 *   Review   -> reviewer  -> Done     (CHANGES_REQUESTED: back to In Work with the review)
 *
 * Bounded on purpose: a send-back cap, a per-run budget (in the runner) and a daily budget.
 */
export class Orchestrator extends EventEmitter {
  constructor({ store, runner, workspace, config }) {
    super();
    this.store = store;
    this.runner = runner;
    this.workspace = workspace;
    this.config = config;
    this.active = new Map(); // ticket id -> { runId, abort }
    this.inflight = new Set(); // promises of runs that have started, so shutdown can wait for them
    this.queue = [];
    this.timer = null;
    this.lastPaused = false;
  }

  start() {
    // Anything that was mid-run when the server stopped goes back in the queue.
    for (const t of this.store.list()) {
      t.runId = null;
      for (const r of t.runs) {
        if (!r.endedAt) Object.assign(r, { endedAt: Date.now(), outcome: 'interrupted', summary: 'Server restarted' });
      }
      if (agentFor(t.column) && (t.status === 'running' || t.status === 'queued')) {
        t.status = 'queued';
        this.queue.push(t.id);
        this.store.touch(t, { quiet: true });
      }
    }
    this.timer = setInterval(() => this.pump(), 30_000); // lets a daily-budget pause lift itself
    this.timer.unref?.();
    this.pump();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    // Detach runs from their tickets first so the aborts below look stale and are not recorded as
    // failures. The tickets stay "running" on disk and start() re-queues them after a restart.
    for (const [id, { abort }] of this.active) {
      const t = this.store.get(id);
      if (t) t.runId = null;
      abort.abort();
    }
    this.active.clear();
    // Let aborted runs unwind (an in-progress `git worktree add` must not outlive us), but never hang shutdown.
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, 5000).unref())]);
    this.store.flush();
  }

  get overBudget() {
    const cap = this.config.dailyBudgetUsd;
    return cap > 0 && this.store.spentToday() >= cap;
  }

  status() {
    return {
      mode: this.runner.name,
      running: this.active.size,
      queued: this.queue.length,
      maxConcurrent: this.config.maxConcurrent,
      paused: this.overBudget,
      spentToday: Number(this.store.spentToday().toFixed(4)),
      dailyBudgetUsd: this.config.dailyBudgetUsd,
    };
  }

  // ---- human actions -------------------------------------------------------------------

  move(id, column) {
    const t = this.#need(id);
    if (!COLUMN_IDS.includes(column)) throw httpError(400, `Unknown column "${column}"`);
    if (t.column === column) return t;
    this.#cancel(t, 'moved');
    t.loops = 0; // a human decision resets the send-back counter
    this.#transition(t, column, 'You moved this ticket');
    if (column === 'backlog') t.feedback = null;
    this.store.touch(t);
    this.#after();
    return t;
  }

  retry(id) {
    const t = this.#need(id);
    if (!agentFor(t.column)) throw httpError(400, 'Only tickets in In Work, Testing or Review have an agent to run');
    if (t.status === 'running') throw httpError(409, 'Already running');
    this.#cancel(t, 'retry');
    t.loops = 0;
    this.#enqueue(t);
    this.#after();
    return t;
  }

  stopRun(id) {
    const t = this.#need(id);
    if (t.status !== 'running' && t.status !== 'queued') throw httpError(409, 'Nothing is running for this ticket');
    this.#cancel(t, 'stopped');
    t.status = 'blocked';
    t.statusNote = 'Stopped by you';
    this.store.addLog(t, 'system', 'Stopped by you');
    this.store.touch(t);
    this.#after();
    return t;
  }

  comment(id, text, { rerun = false } = {}) {
    const t = this.#need(id);
    this.store.addComment(t, 'human', text);
    if (rerun && agentFor(t.column) && t.status !== 'running') return this.retry(id);
    return t;
  }

  remove(id) {
    const t = this.#need(id);
    this.#cancel(t, 'deleted');
    this.store.remove(id);
    this.workspace.remove(t).catch(() => {});
    this.#after();
    return t;
  }

  // ---- machinery -----------------------------------------------------------------------

  #need(id) {
    const t = this.store.get(id);
    if (!t) throw httpError(404, 'Ticket not found');
    return t;
  }

  #after() {
    this.pump();
    this.#emitStatus();
  }

  #emitStatus() {
    this.emit('status', this.status());
  }

  #cancel(t, why) {
    const a = this.active.get(t.id);
    if (a) {
      a.abort.abort();
      this.active.delete(t.id);
    }
    this.queue = this.queue.filter((id) => id !== t.id);
    const run = t.runs.find((r) => r.id === t.runId);
    if (run && !run.endedAt) {
      run.endedAt = Date.now();
      run.outcome = 'cancelled';
      run.summary = why;
    }
    t.runId = null; // the aborted execute() sees a stale id and stays quiet
  }

  #transition(t, column, why) {
    t.column = column;
    t.movedAt = Date.now();
    t.status = 'idle';
    t.statusNote = '';
    t.runId = null;
    this.store.addLog(t, 'system', `${why} -> ${column.replace('_', ' ')}`);
    if (agentFor(column)) this.#enqueue(t);
  }

  #enqueue(t) {
    t.status = 'queued';
    t.statusNote = '';
    t.runId = null;
    if (!this.queue.includes(t.id)) this.queue.push(t.id);
    this.store.touch(t);
  }

  pump() {
    if (this.stopped) return;
    const paused = this.overBudget;
    while (!paused && this.active.size < this.config.maxConcurrent && this.queue.length) {
      const t = this.store.get(this.queue.shift());
      if (!t || t.status !== 'queued' || !agentFor(t.column)) continue;
      const p = this.#execute(t);
      this.inflight.add(p);
      p.finally(() => this.inflight.delete(p));
    }
    if (paused) {
      for (const id of this.queue) {
        const t = this.store.get(id);
        if (t && t.statusNote !== 'Waiting: daily budget reached') {
          t.statusNote = 'Waiting: daily budget reached';
          this.store.touch(t);
        }
      }
    }
    if (paused !== this.lastPaused) {
      this.lastPaused = paused;
      this.#emitStatus();
    }
  }

  async #execute(t) {
    const stage = agentFor(t.column);
    const runId = randomUUID();
    const abort = new AbortController();
    const run = { id: runId, stage, startedAt: Date.now(), endedAt: null, outcome: 'running', costUsd: 0, summary: '' };
    t.runId = runId;
    t.status = 'running';
    t.statusNote = '';
    this.active.set(t.id, { runId, abort });
    this.store.addRun(t, run);
    this.store.touch(t);
    this.#emitStatus();

    const stale = () => t.runId !== runId;
    try {
      const ws = await this.workspace.prepare(t);
      if (stale()) return;
      t.branch = ws.branch;
      t.baseSha = ws.baseSha;
      this.store.addLog(t, 'system', `${stage} started on ${ws.branch}`);
      const { system, prompt } = buildPrompt(stage, t, { branch: ws.branch, baseSha: ws.baseSha });
      const result = await this.runner.run({
        stage,
        ticket: t,
        cwd: ws.dir,
        prompt,
        system,
        signal: abort.signal,
        onLog: (kind, text) => {
          if (!stale()) this.store.addLog(t, kind, text);
        },
      });
      if (stale()) return;
      await this.#finish(t, run, stage, result);
    } catch (err) {
      if (stale()) return;
      this.#fail(t, run, err.message || String(err));
    } finally {
      if (this.active.get(t.id)?.runId === runId) this.active.delete(t.id);
      this.#after();
    }
  }

  #closeRun(t, run, outcome, summary, costUsd = 0) {
    run.endedAt = Date.now();
    run.outcome = outcome;
    run.summary = String(summary || '').slice(0, 1000);
    run.costUsd = costUsd;
    t.costUsd = Number((t.costUsd + costUsd).toFixed(4));
    this.store.addSpend(costUsd);
  }

  #fail(t, run, message, costUsd = 0) {
    this.#closeRun(t, run, 'error', message, costUsd);
    t.status = 'failed';
    t.statusNote = String(message).slice(0, 500);
    t.runId = null;
    this.store.addLog(t, 'error', message);
    this.store.touch(t);
  }

  #block(t, run, outcome, note, costUsd) {
    this.#closeRun(t, run, outcome, note, costUsd);
    t.status = 'blocked';
    t.statusNote = String(note).slice(0, 500);
    t.runId = null;
    this.store.addLog(t, 'system', `Blocked: ${note}`);
    this.store.touch(t);
  }

  async #finish(t, run, stage, result) {
    const cost = result.costUsd || 0;
    if (result.error) return this.#fail(t, run, result.error, cost);

    const { verdict, summary } = parseVerdict(stage, result.text);
    if (!verdict) {
      const tail = String(result.text || '(no output)').trim().slice(-300);
      return this.#block(t, run, 'no-verdict', `Agent ended without a verdict. Last words: ${tail}`, cost);
    }

    // Anything the agent forgot to commit is committed for it, so work is never lost.
    try {
      await this.workspace.sealChanges(t, `${t.id}: ${stage} changes`);
    } catch (err) {
      return this.#fail(t, run, `Could not commit changes: ${err.message}`, cost);
    }
    if (stage !== 'reviewer') {
      await this.workspace.push(t).catch((err) => this.store.addLog(t, 'error', `Push failed: ${err.message}`));
    }

    this.store.addLog(t, 'verdict', `${verdict}${summary ? `: ${summary}` : ''}`);

    if (stage === 'developer') {
      if (verdict === 'BLOCKED') return this.#block(t, run, 'blocked', summary || 'Developer needs input', cost);
      const commits = await this.workspace.commitsAhead(t);
      if (commits === 0) {
        return this.#block(t, run, 'no-changes', 'Developer reported DONE but the branch has no changes', cost);
      }
      this.#closeRun(t, run, 'done', summary, cost);
      t.feedback = null;
      return this.#advance(t, 'testing', 'Developer finished');
    }

    if (stage === 'tester') {
      if (verdict === 'PASS') {
        this.#closeRun(t, run, 'pass', summary, cost);
        return this.#advance(t, 'review', 'Tests passed');
      }
      this.#closeRun(t, run, 'fail', summary, cost);
      return this.#sendBack(t, 'tester', result.text);
    }

    if (verdict === 'APPROVE') {
      this.#closeRun(t, run, 'approve', summary, cost);
      if (this.config.autoDone) return this.#advance(t, 'done', 'Review approved');
      t.status = 'approved';
      t.statusNote = summary || 'Approved, waiting for you';
      t.runId = null;
      return this.store.touch(t);
    }
    this.#closeRun(t, run, 'changes', summary, cost);
    return this.#sendBack(t, 'reviewer', result.text);
  }

  #advance(t, column, why) {
    this.#transition(t, column, why);
    this.store.touch(t);
  }

  #sendBack(t, from, text) {
    t.loops += 1;
    t.feedback = { from, text: stripVerdict(text) || `${from} rejected the work without details` };
    if (t.loops > this.config.maxLoops) {
      t.status = 'blocked';
      t.statusNote = `Sent back ${t.loops - 1} times. Needs your call.`;
      t.runId = null;
      this.store.addLog(t, 'system', t.statusNote);
      return this.store.touch(t);
    }
    this.#advance(t, 'in_work', `Sent back by ${from} (${t.loops}/${this.config.maxLoops})`);
  }
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
