import { execFileSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';

const WORK_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];
const READ_GIT = ['diff', 'log', 'show', 'status', 'ls-files', 'blame'].flatMap((c) => [`Bash(git ${c})`, `Bash(git ${c} *)`]);

// The tool surface is explicit per role. dontAsk means anything not listed here is denied
// outright instead of hanging on an approval prompt nobody can see.
const ROLES = {
  developer: { tools: WORK_TOOLS, allow: WORK_TOOLS },
  tester: { tools: WORK_TOOLS, allow: WORK_TOOLS },
  reviewer: { tools: ['Read', 'Glob', 'Grep', 'Bash'], allow: ['Read', 'Glob', 'Grep', ...READ_GIT] },
};

// Best-effort guard rails. The real boundary is the container/OS user the server runs as,
// and the fact that the agents never get the git token (see agentEnv).
const DENY = [
  'Bash(git push *)', 'Bash(git remote *)', 'Bash(git checkout *)', 'Bash(git switch *)',
  'Bash(git worktree *)', 'Bash(git config *)', 'Bash(git reset --hard *)', 'Bash(git branch -D *)',
  'Bash(sudo *)', 'Bash(rm -rf /)', 'Bash(rm -rf /*)', 'Bash(rm -rf ~*)', 'Bash(rm -rf ..*)',
  'WebFetch', 'WebSearch',
];

// Agents can run arbitrary shell commands, so they get a minimal environment: an allow-list, not a deny-list.
// Anything else the server happens to have (cloud keys, registry tokens, the board password...) stays out
// unless you name it in AGENT_ENV_PASSTHROUGH.
const ENV_ALLOW = [
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TERM|TZ|TMPDIR|COLORTERM|NO_COLOR|CI)$/,
  /^LC_/,
  /^(https?|no|all)_proxy$/i,
  /^(SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/,
  /^ANTHROPIC_/,
  /^CLAUDE_/,
];

export function agentEnv(config, base = process.env) {
  const extra = new Set(config.agentEnvPassthrough || []);
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && (extra.has(k) || ENV_ALLOW.some((re) => re.test(k)))) env[k] = v;
  }
  // Subscription mode must never silently fall back to a metered API key.
  if (config.agentMode === 'subscription') {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = config.gitName;
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = config.gitEmail;
  env.GIT_TERMINAL_PROMPT = '0';
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'kanbanboard/0.1';
  return env;
}

const short = (v, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function describeTool(block) {
  const i = block.input || {};
  if (block.name === 'Bash') return `Bash: ${short(i.command)}`;
  if (i.file_path) return `${block.name} ${i.file_path}`;
  if (i.pattern) return `${block.name} ${short(i.pattern, 80)}`;
  return block.name;
}

/**
 * The SDK throws (rather than yielding an error result) when a turn or budget limit is hit, with messages like
 * "Claude Code returned an error result: Reached maximum budget ($0.0005)". Turn them into something readable,
 * and when the budget was the reason, charge the full run budget to the ledger: the true cost is unknown but
 * it is at least close to that, and under-counting would defeat the daily cap.
 */
export function mapSdkError(message, config) {
  const msg = String(message || '').replace(/^Claude Code returned an error result:\s*/i, '').trim();
  if (/maximum number of turns/i.test(msg)) return { error: `Hit the ${config.maxTurns}-turn limit. Retry, or split the ticket.`, costUsd: 0 };
  if (/maximum budget/i.test(msg)) return { error: `Hit the $${config.maxBudgetPerRunUsd} per-run budget. Retry, or split the ticket.`, costUsd: config.maxBudgetPerRunUsd };
  return { error: msg || 'Agent failed', costUsd: 0 };
}

/** Guard against billing surprises: check which credential the Claude process actually picked. */
export function checkAuthSource(mode, apiKeySource) {
  if (mode === 'subscription' && apiKeySource !== 'none') {
    return `Subscription mode expected your Claude login, but Claude is using an API key (${apiKeySource}). Run was stopped so nothing gets billed.`;
  }
  if (mode === 'api' && apiKeySource === 'none') {
    return 'API mode expected ANTHROPIC_API_KEY, but Claude is using a login instead. Set the key, or use AGENT_MODE=subscription.';
  }
  return null;
}

/** Find the user's own installed `claude` so the run uses the binary they signed in with. */
export function findClaudeBinary(config) {
  if (config.claudeBin) return config.claudeBin;
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' }).split('\n')[0].trim() || undefined;
  } catch {
    return undefined;
  }
}

/** `claude auth status`. Output format varies by CLI version, so keep the raw text for diagnostics. */
export function loginStatus(config) {
  const bin = findClaudeBinary(config);
  if (!bin) return { found: false };
  let raw = '';
  try {
    raw = execFileSync(bin, ['auth', 'status'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    raw = `${err.stdout || ''}${err.stderr || ''}` || String(err.message);
  }
  try {
    return { found: true, bin, raw, ...JSON.parse(raw) };
  } catch {
    const loggedIn = /logged in|signed in/i.test(raw) && !/not (logged|signed)/i.test(raw);
    return { found: true, bin, raw, loggedIn: loggedIn ? true : undefined };
  }
}

class RateLimited extends Error {
  constructor(resetsAtMs) {
    super('Claude usage limit reached');
    this.resetsAtMs = resetsAtMs;
  }
}

export function createSdkRunner(config) {
  const claudeBin = config.agentMode === 'subscription' ? findClaudeBinary(config) : undefined;
  return {
    name: 'sdk',
    async run({ stage, cwd, prompt, system, signal, onLog }) {
      const role = ROLES[stage];
      const abortController = new AbortController();
      signal?.addEventListener('abort', () => abortController.abort(), { once: true });

      const options = {
        cwd,
        abortController,
        env: agentEnv(config),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: system },
        settingSources: ['project'], // pick up the repo's own CLAUDE.md and rules
        tools: role.tools,
        allowedTools: role.allow,
        disallowedTools: DENY,
        permissionMode: 'dontAsk',
        maxTurns: config.maxTurns,
        maxBudgetUsd: config.maxBudgetPerRunUsd,
        persistSession: false,
        ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
        ...(config.model ? { model: config.model } : {}),
      };

      let text = '';
      let costUsd = 0;
      let error = null;
      try {
        for await (const msg of query({ prompt, options })) {
          if (msg.type === 'system' && msg.subtype === 'init') {
            const bad = checkAuthSource(config.agentMode, msg.apiKeySource);
            if (bad) {
              abortController.abort();
              return { text: '', costUsd, error: bad };
            }
          } else if (msg.type === 'rate_limit_event' && msg.rate_limit_info?.status === 'rejected') {
            const r = msg.rate_limit_info.resetsAt;
            throw new RateLimited(r ? (r < 1e12 ? r * 1000 : r) : Date.now() + 15 * 60 * 1000);
          } else if (msg.type === 'assistant') {
            if (msg.error === 'rate_limit') throw new RateLimited(Date.now() + 15 * 60 * 1000);
            if (msg.error) error = `Claude API error: ${msg.error}`;
            for (const block of msg.message?.content ?? []) {
              if (block.type === 'text' && block.text?.trim()) onLog('say', block.text.trim());
              else if (block.type === 'tool_use') onLog('tool', describeTool(block));
            }
          } else if (msg.type === 'result') {
            costUsd = msg.total_cost_usd ?? 0;
            if (msg.subtype === 'success' && !msg.is_error) text = msg.result ?? '';
            else error = (msg.errors?.join('; ') || msg.result || msg.subtype || 'agent failed').toString();
          }
        }
      } catch (err) {
        if (err instanceof RateLimited) return { text: '', costUsd, rateLimited: { resetsAt: err.resetsAtMs } };
        if (abortController.signal.aborted) throw err; // a stop or move, not a failure
        const mapped = mapSdkError(err.message, config);
        error = mapped.error;
        costUsd = Math.max(costUsd, mapped.costUsd);
      }
      return { text, costUsd, error };
    },
  };
}
