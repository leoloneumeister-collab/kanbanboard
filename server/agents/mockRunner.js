// Offline stand-in for the real agents. Lets you try the whole board (and run the tests)
// without an API key or any spend. Drop "[fail-test]" or "[fail-review]" into a ticket
// description to watch the send-back loop. Both fail once, then pass on the retry.
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  });

export function createMockRunner(config) {
  const delay = config.mockDelayMs;
  return {
    name: 'mock',
    async run({ stage, ticket, cwd, signal, onLog }) {
      const step = async (kind, text) => {
        await sleep(delay, signal);
        onLog(kind, text);
      };
      const attempt = ticket.loops + 1;

      if (stage === 'developer') {
        await step('say', `Reading the ticket "${ticket.title}" (attempt ${attempt}).`);
        await step('tool', 'Read README.md');
        const file = path.join(cwd, `${ticket.id.toLowerCase()}.md`);
        fs.writeFileSync(file, `# ${ticket.title}\n\n${ticket.description}\n\nattempt ${attempt}\n`);
        await step('tool', `Write ${path.basename(file)}`);
        await step('say', 'Implemented. Committing.');
        return { text: 'VERDICT: DONE\nSUMMARY: Mock developer wrote a notes file for the ticket.', costUsd: 0.01 };
      }
      if (stage === 'tester') {
        await step('tool', 'Bash: npm test');
        const fail = /\[fail-test\]/i.test(ticket.description) && ticket.loops === 0;
        await step('say', fail ? '1 test failing: edge case not handled.' : 'All checks green.');
        return fail
          ? { text: 'VERDICT: FAIL\nSUMMARY: Edge case with empty input is not handled.', costUsd: 0.01 }
          : { text: 'VERDICT: PASS\nSUMMARY: Mock suite green, behavior verified.', costUsd: 0.01 };
      }
      await step('tool', 'Bash: git diff');
      const bad = /\[fail-review\]/i.test(ticket.description) && ticket.loops === 0;
      await step('say', bad ? 'Found a problem in error handling.' : 'Change looks right and minimal.');
      return bad
        ? { text: 'VERDICT: CHANGES_REQUESTED\nSUMMARY: 1. Errors are swallowed in the main path.', costUsd: 0.01 }
        : { text: 'VERDICT: APPROVE\nSUMMARY: Looks good to merge.', costUsd: 0.01 };
    },
  };
}
