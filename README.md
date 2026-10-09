# Agent Board

A kanban board you run from your phone. Drop a ticket in a column and a Claude agent picks it up.

| Column | Who works on it | What happens next |
| --- | --- | --- |
| Backlog | nobody | You move it to In Work |
| In Work | developer agent | Commits on its own branch, then moves to Testing |
| Testing | tester agent | Runs the suite and checks the ticket. Pass goes to Review, fail goes back to In Work with the details |
| Review | reviewer agent (read only) | Approve goes to Done, changes requested goes back to In Work with the review |
| Done | nobody | Branch is ready for you to merge |

Agents never touch your main branch and never merge. Every ticket gets its own git branch and worktree, so several can run in parallel.

## Try it in 30 seconds (no API key, no cost)

```sh
npm install
APP_PASSWORD=demo npm run dev
```

Open http://localhost:3000. Agents are simulated in this mode. Put `[fail-test]` or `[fail-review]` in a ticket description to watch the send-back loop.

## Connect your Claude

Three modes, picked with `AGENT_MODE`:

| Mode | Uses | Bills |
| --- | --- | --- |
| `mock` (default with no key) | simulated agents | nothing |
| `subscription` | your own local Claude Code login (Pro/Max) | counts against your plan limits |
| `api` (default if `ANTHROPIC_API_KEY` is set) | an API key from console.anthropic.com | per token |

### Using your Pro plan (local only)

1. Install Claude Code and sign in once: `npm i -g @anthropic-ai/claude-code`, run `claude`, log in.
2. `APP_PASSWORD=pick-one AGENT_MODE=subscription npm start`

The board launches your own `claude` binary, which reads your login from your machine. The board never sees, stores or forwards the token. It strips any `ANTHROPIC_API_KEY` from the agents and stops a run if Claude reports it is using a key, so you can't get billed by accident.

What Anthropic's [terms](https://code.claude.com/docs/en/legal-and-compliance) say: plan login is for "ordinary use" of Claude Code, and developers may not offer Claude.ai login in their apps, route requests through plan credentials "on behalf of their users", or "collect, store, or intermediate" credentials. This setup is one person, one machine, their own login, unmodified binary. That looks like the allowed case, but it's your account and Anthropic's call, so read the page yourself. Do not put your login or a `setup-token` on a server, share the board with other people, or resell it.

Practical limits on Pro:
- Three agents per ticket plus send-back loops use the plan fast. Defaults are one agent at a time.
- When Claude says the limit is reached, the board pauses the queue and resumes by itself at the reset time. Tickets are not failed.
- Dollar figures in the UI are estimates of API-equivalent cost, not charges. `DAILY_BUDGET_USD` defaults to off here, per-run limits still apply.

### Using an API key

Set `ANTHROPIC_API_KEY`. Billed per token: cents for a small ticket, dollars for a big one. This is the mode for any hosted setup.

### Try it from your phone on your Wi-Fi

`npm start` prints a line like `On your phone (same Wi-Fi): http://192.168.1.20:3000`. It's plain HTTP, fine at home, but the home-screen install and service worker only work over HTTPS (Tailscale below gives you that).

## Point it at your code

```sh
APP_PASSWORD=... ANTHROPIC_API_KEY=sk-ant-... \
WORKSPACE_REPO=https://github.com/you/your-repo.git \
GIT_TOKEN=github_pat_...   PUSH_BRANCHES=true \
npm start
```

- `GIT_TOKEN` needs contents read and write on that one repo. Only the server uses it. Agents can't see it or push.
- With `PUSH_BRANCHES=true` each ticket branch is pushed to origin, so you can open the PR from your phone.
- Already have the repo on the machine? Use `WORKSPACE_DIR=/path/to/repo` instead.
- Without either, agents work in an empty scratch repo.

## Open it on your phone

Pick one.

1. **Home machine or VPS + Tailscale (my recommendation).** Install Tailscale on the server and your phone, then `tailscale serve --bg 3000`. Nothing is exposed to the public internet. Open the `https://<machine>.<tailnet>.ts.net` URL.
2. **Hosted container (Fly.io, Railway, Render).** Deploy the `Dockerfile`, mount a volume at `/data`, set the env vars from `.env.example`, and set `TRUST_PROXY=1`. This one is public, so use a long `APP_PASSWORD`.
3. **Quick tunnel (Cloudflare Tunnel, ngrok).** Fine for a test. Same warning as above.

Then on the phone: open the URL, Share, Add to Home Screen. It installs like an app.

## Vercel

This backend can't run on Vercel. Vercel Functions are capped at [5 minutes on Hobby and 13 minutes on Pro](https://vercel.com/docs/functions/limitations) (streams included), and agent runs plus the live event stream outlast that. They also have no persistent disk, and this app needs one for git worktrees and state. Moving it there means a rewrite onto a sandbox/queue product, an API key (subscription login must not live on a host), and a database.

If you still want a Vercel URL, host only the static `public/` folder there and proxy `/api` to the machine running the board through a tunnel. It works, but it adds a hop and still exposes your machine, so Tailscale alone is simpler.

## Limits that stop a bad day

| Setting | Default | Does |
| --- | --- | --- |
| `AGENT_MAX_BUDGET_USD` | 2 | Hard stop per agent run |
| `DAILY_BUDGET_USD` | 20 | Whole board. New runs wait once it's hit (0 = off) |
| `AGENT_MAX_TURNS` | 40 | Hard stop per agent run |
| `MAX_LOOPS` | 3 | Times a ticket can be sent back before it waits for you |
| `MAX_CONCURRENT_AGENTS` | 2 | Parallel runs |
| `AUTO_DONE` | true | `false` keeps approved tickets in Review until you tap Mark done |

A run cancelled mid-way (you moved the ticket, or stopped it) has no cost report, so it isn't counted against the daily budget. The daily cap can overshoot by up to `MAX_CONCURRENT_AGENTS x AGENT_MAX_BUDGET_USD`.

All settings are in `.env.example`.

## What the agents can and can't do

Enforced:
- The board needs a password. It won't start without one.
- Developer and tester get Read, Edit, Write, Glob, Grep and Bash. The reviewer gets read only tools plus `git diff/log/show/status`. Anything else is denied, not prompted.
- Agents run in their own worktree, with a minimal environment. Your board password, git token, cloud keys and everything else in the server's environment are not passed on, unless you list a name in `AGENT_ENV_PASSTHROUGH`.
- Web fetch and web search are off.

Be honest with yourself about:
- Bash on the developer and tester is real shell access as the server's OS user. The deny rules (`git push`, `sudo`, `rm -rf /` and friends) are best effort. A determined or confused agent can route around a string match. The real boundary is the container or user you run this as. Run it in Docker, as non root, on a machine with nothing precious on it.
- If the machine has its own git credentials (a credential helper, SSH keys), agents run as that user and could use them if they get around the push deny rule. On a dedicated box or container this is a non issue. On your laptop it is not.
- Agents read ticket text and your repo. A malicious file or issue in the repo can try to steer them. Review the diff before you merge. Done means "an agent approved it", not "it is safe".
- State is one JSON file in `DATA_DIR`. Back up that folder if you care about ticket history.

## Layout

```
server/
  index.js          HTTP API, live updates (SSE), auth, static files
  orchestrator.js   column -> agent -> verdict -> next column, retries, budgets
  workspace.js      git branch + worktree per ticket
  store.js          JSON persistence
  agents/           prompts, real Claude runner, simulated runner
public/             the phone UI (plain JS, no build step) + PWA files
test/               npm test
```

## Tests

```sh
npm test
```

Covers the full pipeline against a real git repo (with simulated agents), send-back loops and caps, cancellation, restart recovery, concurrency, budgets, auth, CSRF and the agent sandbox settings.
