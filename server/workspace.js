import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'ticket';

/**
 * Owns the git side of things. Every ticket gets its own branch and worktree, so
 * several agents can work in parallel without stepping on each other, and nothing
 * ever touches the base branch. Merging stays a human decision.
 */
export class Workspace {
  constructor(config) {
    this.config = config;
    this.repoDir = '';
    this.baseBranch = '';
    this.remote = false;
    this.chain = Promise.resolve();
  }

  git(args, { cwd = this.repoDir, auth = false } = {}) {
    const pre = [
      '-c', `user.name=${this.config.gitName}`,
      '-c', `user.email=${this.config.gitEmail}`,
    ];
    if (auth && this.config.gitToken && /^https:\/\//.test(this.config.workspaceRepo)) {
      // Token is only ever handed to git calls the server makes itself. It never reaches the agents.
      const origin = new URL(this.config.workspaceRepo).origin;
      const b64 = Buffer.from(`x-access-token:${this.config.gitToken}`).toString('base64');
      pre.push('-c', `http.${origin}/.extraheader=AUTHORIZATION: basic ${b64}`);
    }
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        [...pre, ...args],
        { cwd, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        (err, stdout, stderr) => {
          if (err) {
            const msg = String(stderr || err.message).replaceAll(this.config.gitToken || '\0', '***').trim();
            reject(new Error(`git ${args[0]} failed: ${msg}`));
          } else resolve(stdout.trim());
        },
      );
    });
  }

  /** git worktree add/remove race on shared metadata, so those go through one queue. */
  serial(fn) {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  async init() {
    const { workspaceDir, workspaceRepo, dataDir } = this.config;
    if (workspaceDir) {
      this.repoDir = workspaceDir;
      await this.git(['rev-parse', '--git-dir']).catch(() => {
        throw new Error(`WORKSPACE_DIR ${workspaceDir} is not a git repository`);
      });
    } else {
      this.repoDir = path.join(dataDir, 'repo');
      if (!fs.existsSync(path.join(this.repoDir, '.git'))) {
        fs.mkdirSync(path.dirname(this.repoDir), { recursive: true });
        if (workspaceRepo) {
          await this.git(['clone', workspaceRepo, this.repoDir], { cwd: dataDir, auth: true });
        } else {
          fs.mkdirSync(this.repoDir, { recursive: true });
          await this.git(['init', '-b', 'main']);
          fs.writeFileSync(
            path.join(this.repoDir, 'README.md'),
            '# Scratch workspace\n\nNo WORKSPACE_REPO was configured, so agents work in this empty repo.\n',
          );
          await this.git(['add', '-A']);
          await this.git(['commit', '-m', 'Initial commit']);
        }
      }
    }
    this.baseBranch = this.config.baseBranch || (await this.git(['symbolic-ref', '--short', 'HEAD']));
    this.remote = Boolean(await this.git(['remote']).catch(() => ''));
    fs.mkdirSync(this.worktreesDir, { recursive: true });
    return this;
  }

  get worktreesDir() {
    return path.join(this.config.dataDir, 'worktrees');
  }

  dirFor(ticket) {
    return path.join(this.worktreesDir, ticket.id);
  }

  /** Where new ticket branches start from: the freshest copy of the base branch we can see. */
  async startPoint({ fetch = false } = {}) {
    if (!this.remote) return this.baseBranch;
    if (fetch) await this.git(['fetch', 'origin'], { auth: true }).catch(() => {});
    const hasRemoteBase = await this.git(['rev-parse', '--verify', `refs/remotes/origin/${this.baseBranch}`]).then(() => true, () => false);
    return hasRemoteBase ? `origin/${this.baseBranch}` : this.baseBranch;
  }

  /**
   * Make sure the ticket has a branch + worktree. Idempotent, and safe to call after a crash that
   * happened halfway through (worktree created, ticket metadata not yet saved).
   */
  prepare(ticket) {
    return this.serial(async () => {
      const dir = this.dirFor(ticket);
      const branch = ticket.branch || `kanban/${ticket.id.toLowerCase()}-${slugify(ticket.title)}`;
      // A crash in the middle of `git worktree add` leaves a half-made directory that blocks every retry.
      // Check .git first: DATA_DIR may itself live inside a repo, which would fool rev-parse alone.
      let exists = fs.existsSync(path.join(dir, '.git'));
      if (exists) exists = await this.git(['rev-parse', '--is-inside-work-tree'], { cwd: dir }).then(() => true, () => false);
      if (!exists && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        await this.git(['worktree', 'prune']);
      }
      const start = await this.startPoint({ fetch: !exists });
      if (!exists) {
        const branchExists = await this.git(['rev-parse', '--verify', `refs/heads/${branch}`]).then(() => true, () => false);
        if (branchExists) await this.git(['worktree', 'add', dir, branch]);
        else await this.git(['worktree', 'add', '-b', branch, dir, start]);
      }
      const baseSha = ticket.baseSha || (await this.git(['merge-base', 'HEAD', start], { cwd: dir }));
      return { dir, branch, baseSha };
    });
  }

  /** Commit anything the agent left uncommitted, so work is never silently lost. */
  async sealChanges(ticket, message) {
    const dir = this.dirFor(ticket);
    const dirty = await this.git(['status', '--porcelain'], { cwd: dir });
    if (!dirty) return false;
    await this.git(['add', '-A'], { cwd: dir });
    await this.git(['commit', '-m', message], { cwd: dir });
    return true;
  }

  async commitsAhead(ticket) {
    if (!ticket.baseSha) return 0;
    const n = await this.git(['rev-list', '--count', `${ticket.baseSha}..HEAD`], { cwd: this.dirFor(ticket) });
    return Number(n) || 0;
  }

  /** What this ticket's branch changes relative to where it started. Read-only, size capped. */
  async diff(ticket, { maxBytes = 200_000 } = {}) {
    const dir = this.dirFor(ticket);
    if (!ticket.baseSha || !fs.existsSync(path.join(dir, '.git'))) return { files: [], patch: '', truncated: false };
    const range = `${ticket.baseSha}...HEAD`;
    const stat = await this.git(['diff', '--numstat', range], { cwd: dir });
    const files = stat.split('\n').filter(Boolean).map((l) => {
      const [add, del, ...name] = l.split('\t');
      return { file: name.join('\t'), added: add === '-' ? 0 : Number(add), removed: del === '-' ? 0 : Number(del), binary: add === '-' };
    });
    let patch = await this.git(['diff', '--no-color', range], { cwd: dir });
    const truncated = patch.length > maxBytes;
    if (truncated) patch = patch.slice(0, maxBytes);
    return { files, patch, truncated };
  }

  async push(ticket) {
    if (!this.config.pushBranches || !this.remote || !ticket.branch) return false;
    await this.git(['push', '-u', 'origin', ticket.branch], { cwd: this.dirFor(ticket), auth: true });
    return true;
  }

  /** Remove the worktree but keep the branch: deleting a ticket should never destroy commits. */
  remove(ticket) {
    return this.serial(async () => {
      const dir = this.dirFor(ticket);
      if (!fs.existsSync(dir)) return;
      await this.git(['worktree', 'remove', '--force', dir]).catch(() => fs.rmSync(dir, { recursive: true, force: true }));
    });
  }
}
