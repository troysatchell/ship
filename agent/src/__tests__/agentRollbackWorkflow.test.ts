/**
 * TRO-367 (W5-R36) — the automatic trigger itself, not just its decision
 * logic. `runReadinessCheck` (`check-readiness-and-rollback.test.ts`) proves
 * the poll -> evaluate -> decide -> call-Render pipeline is wired together
 * correctly; this proves the pipeline is actually invoked automatically,
 * without a human running a command, by asserting the structure of
 * `.github/workflows/agent-rollback-check.yml` — that it fires on a
 * schedule (not only `workflow_dispatch`, which still needs a human to
 * click a button) and that its readiness-check step passes `--execute`
 * (without which a sustained failure would only be reported, never acted
 * on). Before this ticket, `check-readiness-and-rollback.ts`'s own docstring
 * stated plainly that it was "NOT wired into any live trigger against
 * production" — no workflow like this one existed at all.
 *
 * Same reasoning as `gitlabCiAgentTests.test.ts` for not depending on a YAML
 * parser: neither `js-yaml` nor `yaml` is a declared dependency of any
 * package in this repo. Plain-text/regex assertions against the file are
 * sufficient to prove the specific structural facts this test cares about.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readWorkflow(): string {
  // agent/src/__tests__/ -> repo root is four levels up.
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../');
  return readFileSync(path.join(repoRoot, '.github/workflows/agent-rollback-check.yml'), 'utf8');
}

/**
 * Isolates a step's `run: |` command block by its `- name: <stepName>` line,
 * and returns only its non-comment lines joined together. Guards against the
 * exact vacuous-match bug this test used to have: this workflow's own header
 * comment (lines 1-51) narrates the real invocation in prose — "calls
 * `check-readiness-and-rollback.ts --execute`" — so a bare
 * `expect(workflow).toMatch(/--execute\b/)` against the WHOLE file still
 * passed even with `--execute` deleted from the actual `run:` line below,
 * because the comment's own prose satisfied the regex on its own. Scoping to
 * the step's run block, then stripping `#` comment lines from that block,
 * means a match only counts if it is part of the command GitHub Actions will
 * actually execute.
 */
function extractStepRunCommand(workflow: string, stepName: string): string {
  const lines = workflow.split('\n');
  const indentOf = (line: string): number => line.match(/^(\s*)/)?.[1].length ?? 0;

  const stepIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (stepIndex === -1) {
    throw new Error(`No step named "${stepName}" found in the workflow.`);
  }
  const stepIndent = indentOf(lines[stepIndex] ?? '');
  const afterStep = lines.slice(stepIndex + 1);
  const stepEndOffset = afterStep.findIndex((line) => line.trim().length > 0 && indentOf(line) <= stepIndent);
  const stepBody = stepEndOffset === -1 ? afterStep : afterStep.slice(0, stepEndOffset);

  const runIndex = stepBody.findIndex((line) => line.trim() === 'run: |');
  if (runIndex === -1) {
    throw new Error(`Step "${stepName}" has no \`run: |\` block.`);
  }
  const runIndent = indentOf(stepBody[runIndex] ?? '');
  const afterRun = stepBody.slice(runIndex + 1);
  const runEndOffset = afterRun.findIndex((line) => line.trim().length > 0 && indentOf(line) <= runIndent);
  const runLines = runEndOffset === -1 ? afterRun : afterRun.slice(0, runEndOffset);

  return runLines.filter((line) => !line.trim().startsWith('#')).join('\n');
}

describe('extractStepRunCommand (test-helper self-check)', () => {
  it('finds the readiness step and excludes the header comment that mentions the same flags in prose', () => {
    const workflow = readWorkflow();
    const runCommand = extractStepRunCommand(workflow, 'Check agent readiness, roll back on sustained failure');
    expect(runCommand).toContain('pnpm --filter @ship/agent check:readiness');
    // The header comment block (lines 1-51) narrates this same invocation in
    // prose, including its own `--service-id`-free summary sentences — this
    // proves the slice is actually the run block, not the whole file.
    expect(runCommand.trim().split('\n').every((line) => !line.trim().startsWith('#'))).toBe(true);
  });

  it('throws on an unknown step name rather than silently matching nothing', () => {
    const workflow = readWorkflow();
    expect(() => extractStepRunCommand(workflow, 'not a real step')).toThrow(/No step named/);
  });
});

describe('.github/workflows/agent-rollback-check.yml — the automatic rollback trigger (TRO-367)', () => {
  it('fires on a schedule (cron), not only on manual dispatch', () => {
    const workflow = readWorkflow();
    // Scoped to the `on:` block specifically, not merely "a cron string
    // appears somewhere" — this repo's other workflow (ci.yml) has no
    // schedule trigger at all, so a loose match could pass against the
    // wrong file's content if this test were ever copy-pasted carelessly.
    const onBlockMatch = workflow.match(/^on:\n([\s\S]*?)\n(?:\S|$)/m);
    expect(onBlockMatch, 'expected a top-level `on:` block').not.toBeNull();
    const onBlock = onBlockMatch?.[1] ?? '';
    expect(onBlock).toMatch(/schedule:/);
    expect(onBlock).toMatch(/cron:\s*'[^']+'/);
  });

  it('invokes check-readiness-and-rollback with --execute, guarded by a real service id and API key, not merely a dry run', () => {
    const workflow = readWorkflow();
    const runCommand = extractStepRunCommand(workflow, 'Check agent readiness, roll back on sustained failure');

    // These three specifically are asserted against the isolated, non-comment
    // run block — see extractStepRunCommand's docstring for why the whole-file
    // version of this assertion was vacuous.
    expect(runCommand).toMatch(/check:readiness/);
    expect(runCommand).toMatch(/--execute\b/);
    expect(runCommand).toMatch(/--service-id/);
    expect(workflow).toMatch(/RENDER_API_KEY/);
    expect(workflow).toMatch(/RENDER_AGENT_SERVICE_ID/);
  });

  it('never cancels an in-progress run (a rollback in flight must not be interrupted by the next scheduled tick)', () => {
    const workflow = readWorkflow();
    expect(workflow).toMatch(/cancel-in-progress:\s*false/);
  });

  it('gates every real step on the two required secrets being present, rather than failing loudly or silently no-op-ing', () => {
    const workflow = readWorkflow();
    const guardedSteps = workflow.match(/if:\s*steps\.secrets_check\.outputs\.configured == 'true'/g) ?? [];
    // checkout, pnpm setup, node setup, install, build, and the readiness
    // check itself — six steps genuinely depend on the secrets being real.
    expect(guardedSteps.length).toBeGreaterThanOrEqual(6);
  });
});
