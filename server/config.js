import path from 'node:path';

const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || './data');
  return {
    port: num(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dataDir,

    // Auth. One shared password; the board is remote code execution on your box, so it is mandatory.
    appPassword: env.APP_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || '',
    allowNoAuth: bool(env.ALLOW_NO_AUTH, false),
    cookieSecure: env.COOKIE_SECURE === undefined ? 'auto' : bool(env.COOKIE_SECURE, false),
    trustProxy: env.TRUST_PROXY || '',

    // Agents.
    agentMode: (env.AGENT_MODE || (env.ANTHROPIC_API_KEY ? 'sdk' : 'mock')).toLowerCase(),
    model: env.AGENT_MODEL || '',
    maxTurns: num(env.AGENT_MAX_TURNS, 40),
    maxBudgetPerRunUsd: num(env.AGENT_MAX_BUDGET_USD, 2),
    dailyBudgetUsd: num(env.DAILY_BUDGET_USD, 20),
    agentEnvPassthrough: (env.AGENT_ENV_PASSTHROUGH || '').split(',').map((x) => x.trim()).filter(Boolean),
    maxConcurrent: Math.max(1, num(env.MAX_CONCURRENT_AGENTS, 2)),
    maxLoops: num(env.MAX_LOOPS, 3),
    autoDone: bool(env.AUTO_DONE, true),
    mockDelayMs: num(env.MOCK_DELAY_MS, 1200),

    // Workspace the agents work on.
    workspaceRepo: env.WORKSPACE_REPO || '',
    baseBranch: env.BASE_BRANCH || '',
    workspaceDir: env.WORKSPACE_DIR ? path.resolve(env.WORKSPACE_DIR) : '',
    gitToken: env.GIT_TOKEN || '',
    pushBranches: bool(env.PUSH_BRANCHES, false),
    gitName: env.GIT_AUTHOR_NAME || 'Kanban Agent',
    gitEmail: env.GIT_AUTHOR_EMAIL || 'agent@kanban.local',
  };
}

export const COLUMNS = [
  { id: 'backlog', title: 'Backlog', agent: null },
  { id: 'in_work', title: 'In Work', agent: 'developer' },
  { id: 'testing', title: 'Testing', agent: 'tester' },
  { id: 'review', title: 'Review', agent: 'reviewer' },
  { id: 'done', title: 'Done', agent: null },
];

export const COLUMN_IDS = COLUMNS.map((c) => c.id);
export const agentFor = (column) => COLUMNS.find((c) => c.id === column)?.agent ?? null;
