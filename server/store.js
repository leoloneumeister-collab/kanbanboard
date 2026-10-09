import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const MAX_LOG = 400;
const MAX_RUNS = 40;
const MAX_COMMENTS = 100;
const MAX_LINE = 2000;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Tiny JSON-file store. A kanban board for one person does not need a database,
 * and a single file on a volume is trivial to back up. Writes are debounced and atomic.
 */
export class Store extends EventEmitter {
  constructor(dataDir, { debounceMs = 150 } = {}) {
    super();
    this.file = path.join(dataDir, 'state.json');
    this.debounceMs = debounceMs;
    this.timer = null;
    fs.mkdirSync(dataDir, { recursive: true });
    this.state = { nextId: 1, tickets: {}, ledger: { date: today(), usd: 0 } };
    if (fs.existsSync(this.file)) {
      try {
        this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
      } catch (err) {
        const bad = `${this.file}.corrupt-${Date.now()}`;
        fs.renameSync(this.file, bad);
        console.error(`state.json was unreadable, moved to ${bad}: ${err.message}`);
      }
    }
  }

  list() {
    return Object.values(this.state.tickets);
  }

  get(id) {
    return this.state.tickets[id] ?? null;
  }

  create({ title, description = '' }) {
    const id = `T-${this.state.nextId++}`;
    const now = Date.now();
    const ticket = {
      id,
      title: String(title).trim().slice(0, 200),
      description: String(description).slice(0, 10000),
      column: 'backlog',
      status: 'idle', // idle | queued | running | blocked | failed | approved
      statusNote: '',
      branch: '',
      loops: 0,
      costUsd: 0,
      feedback: null, // { from, text } handed to the developer on the next run
      comments: [],
      runs: [],
      log: [],
      runId: null,
      createdAt: now,
      updatedAt: now,
      movedAt: now,
    };
    this.state.tickets[id] = ticket;
    this.touch(ticket);
    return ticket;
  }

  remove(id) {
    const t = this.get(id);
    if (!t) return null;
    delete this.state.tickets[id];
    this.schedule();
    this.emit('removed', t);
    return t;
  }

  /** Call after mutating a ticket in place. */
  touch(ticket, { quiet = false } = {}) {
    ticket.updatedAt = Date.now();
    this.schedule();
    if (!quiet) this.emit('ticket', ticket);
  }

  addLog(ticket, kind, text) {
    const entry = { t: Date.now(), kind, text: String(text).slice(0, MAX_LINE) };
    ticket.log.push(entry);
    if (ticket.log.length > MAX_LOG) ticket.log.splice(0, ticket.log.length - MAX_LOG);
    this.schedule();
    this.emit('log', ticket, entry);
    return entry;
  }

  addComment(ticket, author, text) {
    ticket.comments.push({ t: Date.now(), author, text: String(text).slice(0, 4000) });
    if (ticket.comments.length > MAX_COMMENTS) ticket.comments.shift();
    this.touch(ticket);
  }

  addRun(ticket, run) {
    ticket.runs.push(run);
    if (ticket.runs.length > MAX_RUNS) ticket.runs.shift();
  }

  /** Spend ledger survives ticket deletion, so a delete can not be used to dodge the daily cap. */
  spentToday() {
    const l = this.state.ledger;
    return l.date === today() ? l.usd : 0;
  }

  addSpend(usd) {
    const l = this.state.ledger;
    if (l.date !== today()) {
      l.date = today();
      l.usd = 0;
    }
    l.usd += usd || 0;
    this.schedule();
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }
}
