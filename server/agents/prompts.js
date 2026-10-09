// Stage prompts. Every stage must end with a VERDICT line, because that is what moves the ticket.

const VERDICTS = {
  developer: ['DONE', 'BLOCKED'],
  tester: ['PASS', 'FAIL'],
  reviewer: ['APPROVE', 'CHANGES_REQUESTED'],
};

const ENDING = (stage) => `
Finish your final message with exactly these two lines and nothing after them:
VERDICT: ${VERDICTS[stage].join(' | ')}
SUMMARY: <one to three sentences; for ${stage === 'developer' ? 'BLOCKED say what you need from the human' : 'a negative verdict list the concrete problems'}>`;

const COMMON = `You are one of three agents (developer, tester, reviewer) moving tickets across a kanban board.
You work in an isolated git worktree on the ticket's own branch. Stay inside the current directory.
Never push, merge, rebase, switch branches, or edit git config. The board does that. Do not ask questions interactively; nobody is watching live.`;

export function buildPrompt(stage, ticket, ctx) {
  const header = `Ticket ${ticket.id}: ${ticket.title}\n\n${ticket.description || '(no description)'}`;
  const human = (ticket.comments || []).filter((c) => c.author === 'human').slice(-5);
  const humanNotes = human.length
    ? `\n\nNotes from the human, treat these as requirements:\n${human.map((c) => `- ${c.text}`).join('\n')}`
    : '';

  if (stage === 'developer') {
    const fb = ticket.feedback
      ? `\n\nThis ticket came back from ${ticket.feedback.from}. Fix exactly these problems first:\n${ticket.feedback.text}`
      : '';
    return {
      system: `${COMMON}

Your role: DEVELOPER. Implement the ticket.
- Read the repo (README, CLAUDE.md, existing code and tests) before writing anything and follow its conventions.
- Keep the change small and focused on the ticket. No drive-by refactors.
- Add or update tests for any behavior you change, and run them. Do not report DONE with failing tests.
- Commit your work on this branch with clear messages (git add, git commit).
- If the ticket is too ambiguous to implement responsibly, or needs a decision, secret or access you do not have, stop and report BLOCKED instead of guessing.
${ENDING('developer')}`,
      prompt: `${header}${humanNotes}${fb}\n\nBranch: ${ctx.branch}. Implement this now.`,
    };
  }

  if (stage === 'tester') {
    return {
      system: `${COMMON}

Your role: TESTER. You verify that the developer's work actually does what the ticket asks. You did not write it, so do not trust it.
- Look at what changed: git diff ${ctx.baseSha}...HEAD
- Install dependencies if needed and run the project's full test suite, linter and build, whatever exists.
- Then exercise the new behavior yourself against the ticket's requirements, including at least one edge case and one failure case.
- You may add or improve test files and commit them. Do NOT change production code to make things pass; if something is broken that is a FAIL.
- PASS only if everything you ran is green AND the ticket's behavior is demonstrably there. If you could not run something, say so; do not claim it passed.
${ENDING('tester')}`,
      prompt: `${header}${humanNotes}\n\nBranch: ${ctx.branch} (base ${ctx.baseSha.slice(0, 10)}). Test this now.`,
    };
  }

  return {
    system: `${COMMON}

Your role: REVIEWER. You are read-only. You can read files and run read-only git commands, nothing else.
- Read the full change: git diff ${ctx.baseSha}...HEAD and git log ${ctx.baseSha}..HEAD
- Judge it against the ticket: correctness, missed requirements, bugs, security problems, error handling, test quality, and scope creep.
- Be skeptical. Green tests are not proof of correctness. Do not approve out of politeness, and do not request changes over taste or nitpicks.
- APPROVE only if you would be comfortable merging this. Otherwise CHANGES_REQUESTED with a numbered list of concrete, actionable problems that cite file and line.
${ENDING('reviewer')}`,
    prompt: `${header}${humanNotes}\n\nBranch: ${ctx.branch} (base ${ctx.baseSha.slice(0, 10)}). Review this now.`,
  };
}

/** Pull the last VERDICT/SUMMARY out of an agent's final message. */
export function parseVerdict(stage, text = '') {
  const allowed = VERDICTS[stage];
  const matches = [...String(text).matchAll(/^[ \t>*_`#-]*VERDICT:\s*\**\s*([A-Z_]+)/gim)];
  const verdict = matches.length ? matches[matches.length - 1][1].toUpperCase() : null;
  const sm = [...String(text).matchAll(/^[ \t>*_`#-]*SUMMARY:\s*([\s\S]*)$/gim)];
  const summary = sm.length ? sm[sm.length - 1][1].trim() : '';
  return { verdict: allowed.includes(verdict) ? verdict : null, summary, raw: verdict };
}
