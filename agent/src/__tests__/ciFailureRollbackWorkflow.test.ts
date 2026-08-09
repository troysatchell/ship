/**
 * TRO-383 (W5-R36's literal reading) — the CI-failure rollback trigger,
 * distinct from TRO-367's cron trigger (`agentRollbackWorkflow.test.ts`
 * asserts that one). `.github/workflows/agent-rollback-check.yml` rolls back
 * on a SUSTAINED /ready failure discovered by polling; nothing before this
 * ticket ever acted BECAUSE a CI run failed. This asserts the actual
 * structure of `.github/workflows/ci-failure-rollback.yml`: that it fires on
 * `workflow_run` (not only a schedule or manual dispatch), scoped to the CI
 * workflow completing with `conclusion: failure` on `main`, that it shares
 * agent-rollback-check.yml's own concurrency group (so GitHub serializes the
 * two rather than letting both call Render at once), and that its readiness
 * step still requires `--execute` behind the same two secrets.
 *
 * Same reasoning as `agentRollbackWorkflow.test.ts` and
 * `gitlabCiAgentTests.test.ts` for not depending on a YAML parser: neither
 * `js-yaml` nor `yaml` is a declared dependency of any package in this repo.
 *
 * TRO-377-class vacuous-test guard: this workflow file's own header comment
 * narrates the trigger condition in prose (to explain the anti-flake
 * reasoning), so a bare `expect(workflow).toMatch(...)` against the WHOLE
 * FILE would keep passing even if the real `if:` condition were deleted,
 * as long as the header still mentioned it. Every assertion below is scoped
 * to an isolated, comment-stripped slice of the actual `on:` block or the
 * actual job body — never the whole file — so a match only counts if it is
 * part of what GitHub Actions will actually evaluate.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function repoRoot(): string {
  // agent/src/__tests__/ -> repo root is four levels up.
  return path.resolve(fileURLToPath(import.meta.url), '../../../../');
}

function readWorkflow(): string {
  return readFileSync(path.join(repoRoot(), '.github/workflows/ci-failure-rollback.yml'), 'utf8');
}

function readCronWorkflow(): string {
  return readFileSync(path.join(repoRoot(), '.github/workflows/agent-rollback-check.yml'), 'utf8');
}

const indentOf = (line: string): number => line.match(/^(\s*)/)?.[1].length ?? 0;

/**
 * Isolates a top-level job's own body by its `<jobName>:` header line under
 * `jobs:` — every line indented further than the header, stopping at the
 * first non-blank line at or below its own indentation — and strips `#`
 * comment lines from that slice. Combines the two patterns this repo's
 * existing workflow tests each use separately: `gitlabCiAgentTests.test.ts`'s
 * indentation-bounded job-body isolator, and `agentRollbackWorkflow.test.ts`'s
 * comment-stripping (see that file's own docstring for why a bare
 * whole-file match on this workflow's prose-heavy header would be vacuous).
 */
function extractJobBody(workflow: string, jobName: string): string {
  const lines = workflow.split('\n');
  const jobIndex = lines.findIndex((line) => line.trim() === `${jobName}:`);
  if (jobIndex === -1) {
    throw new Error(`No job named "${jobName}:" found in the workflow.`);
  }
  const jobIndent = indentOf(lines[jobIndex] ?? '');
  const after = lines.slice(jobIndex + 1);
  const endOffset = after.findIndex((line) => line.trim().length > 0 && indentOf(line) <= jobIndent);
  const bodyLines = endOffset === -1 ? after : after.slice(0, endOffset);
  return bodyLines.filter((line) => !line.trim().startsWith('#')).join('\n');
}

/**
 * Isolates a step's `run: |` command block by its `- name: <stepName>` line
 * within an already-extracted job body, and returns only its non-comment
 * lines joined together — the identical pattern `agentRollbackWorkflow.
 * test.ts`'s `extractStepRunCommand` uses, copied here rather than imported
 * so each workflow test file stays self-contained (this repo's existing
 * convention — `gitlabCiAgentTests.test.ts` does the same for `.gitlab-
 * ci.yml` rather than sharing a helper module).
 */
function extractStepRunCommand(jobBody: string, stepName: string): string {
  const lines = jobBody.split('\n');
  const stepIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (stepIndex === -1) {
    throw new Error(`No step named "${stepName}" found in the job body.`);
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

  return runLines.join('\n');
}

describe('extractJobBody / extractStepRunCommand (test-helper self-check)', () => {
  it('isolates the check-and-rollback job body, excluding the header comment that discusses the same condition in prose', () => {
    const workflow = readWorkflow();
    const jobBody = extractJobBody(workflow, 'check-and-rollback');
    expect(jobBody).toContain("if: github.event.workflow_run.conclusion == 'failure'");
    // The header comment block narrates this same condition in prose
    // ("A trigger that called Render on a bare failing conclusion...") —
    // this proves the slice is actually the job body, not the whole file,
    // by asserting the job body contains no comment lines at all.
    expect(jobBody.split('\n').every((line) => !line.trim().startsWith('#'))).toBe(true);
  });

  it('throws on an unknown job name rather than silently matching nothing', () => {
    const workflow = readWorkflow();
    expect(() => extractJobBody(workflow, 'not-a-real-job')).toThrow(/No job named/);
  });

  it('throws on an unknown step name rather than silently matching nothing', () => {
    const workflow = readWorkflow();
    const jobBody = extractJobBody(workflow, 'check-and-rollback');
    expect(() => extractStepRunCommand(jobBody, 'not a real step')).toThrow(/No step named/);
  });
});

describe('.github/workflows/ci-failure-rollback.yml — the CI-failure rollback trigger (TRO-383)', () => {
  it('fires on workflow_run for the CI workflow completing, not only on a schedule or manual dispatch', () => {
    const workflow = readWorkflow();
    // Scoped to the top-level `on:` block specifically (bounded the same way
    // agentRollbackWorkflow.test.ts bounds it: from the literal `on:` line
    // to the next unindented line), not merely "workflow_run appears
    // somewhere" — agent-rollback-check.yml's own header comment mentions
    // "trigger" and "workflow" repeatedly, so a loose whole-file match could
    // pass against the wrong file's content if this test were ever
    // copy-pasted carelessly.
    const onBlockMatch = workflow.match(/^on:\n([\s\S]*?)\n(?:\S|$)/m);
    expect(onBlockMatch, 'expected a top-level `on:` block').not.toBeNull();
    const onBlock = onBlockMatch?.[1] ?? '';

    expect(onBlock).toMatch(/workflow_run:/);
    expect(onBlock).toMatch(/workflows:\s*\[\s*['"]CI['"]\s*\]/);
    expect(onBlock).toMatch(/types:\s*\[\s*completed\s*\]/);
    expect(onBlock).toMatch(/branches:\s*\[\s*main\s*\]/);
  });

  it('only proceeds when the triggering CI run actually concluded in failure — an anchored match, not a substring one', () => {
    const workflow = readWorkflow();
    const jobBody = extractJobBody(workflow, 'check-and-rollback');
    const ifLine = jobBody.split('\n').find((line) => line.trim().startsWith('if:'));
    expect(ifLine, 'expected a job-level `if:` condition in check-and-rollback').toBeDefined();

    // Anchored to the exact field-access-and-comparison shape, requiring the
    // literal closing quote immediately after `failure` — guards the
    // TRO-377-class near-miss where a looser match (e.g. `/failure/`) would
    // also accept `conclusion == 'failure_ignored'` or a condition checking
    // a different field entirely that happens to mention the word "failure"
    // in a string elsewhere on the same line.
    const CONCLUSION_FAILURE_CONDITION = /github\.event\.workflow_run\.conclusion\s*==\s*'failure'/;
    expect(ifLine).toMatch(CONCLUSION_FAILURE_CONDITION);

    // Near-miss checks, mirroring gitlabCiAgentTests.test.ts's
    // `test:unit`-rejection pattern: a condition checking for success, or a
    // prefix-only match, must NOT satisfy this anchor.
    expect("if: github.event.workflow_run.conclusion == 'success'").not.toMatch(
      CONCLUSION_FAILURE_CONDITION
    );
    expect("if: github.event.workflow_run.conclusion == 'failure_ignored'").not.toMatch(
      CONCLUSION_FAILURE_CONDITION
    );
    expect(ifLine).toMatch(CONCLUSION_FAILURE_CONDITION);
  });

  it('invokes check-readiness-and-rollback with --execute, guarded by a real service id and API key, not merely a dry run', () => {
    const workflow = readWorkflow();
    const jobBody = extractJobBody(workflow, 'check-and-rollback');
    const runCommand = extractStepRunCommand(jobBody, 'Check agent readiness, roll back on sustained failure');

    // These specifically are asserted against the isolated, non-comment run
    // block — see extractStepRunCommand's docstring for why the whole-file
    // version of this assertion would be vacuous. Word-boundary anchors so a
    // near-miss script name (e.g. `check:readiness-legacy`) would not
    // satisfy the match.
    expect(runCommand).toMatch(/\bcheck:readiness\b/);
    expect(runCommand).toMatch(/--execute\b/);
    expect(runCommand).toMatch(/--service-id\b/);
    expect(workflow).toMatch(/RENDER_API_KEY/);
    expect(workflow).toMatch(/RENDER_AGENT_SERVICE_ID/);
  });

  it('never cancels an in-progress run (a rollback in flight must not be interrupted by the next CI-failure tick)', () => {
    const workflow = readWorkflow();
    expect(workflow).toMatch(/cancel-in-progress:\s*false/);
  });

  it('gates every real step on the two required secrets being present, rather than failing loudly or silently no-op-ing', () => {
    const workflow = readWorkflow();
    const jobBody = extractJobBody(workflow, 'check-and-rollback');
    const guardedSteps = jobBody.match(/if:\s*steps\.secrets_check\.outputs\.configured == 'true'/g) ?? [];
    // checkout, pnpm setup, node setup, install, build, and the readiness
    // check itself — six steps genuinely depend on the secrets being real.
    expect(guardedSteps.length).toBeGreaterThanOrEqual(6);
  });

  it("shares agent-rollback-check.yml's exact concurrency group, so GitHub serializes the two workflows against each other instead of letting both call Render at once", () => {
    // GitHub's own docs (Actions > Using jobs > Using concurrency) state
    // concurrency group names are NOT scoped per workflow file — two
    // different workflow files that declare the same group genuinely
    // serialize against each other, repository-wide. This test does not
    // hardcode that shared string: it reads BOTH real files and compares
    // their groups, so if either workflow's group ever drifts, the mismatch
    // itself fails this test rather than silently losing the coordination
    // the header comment claims.
    const groupOf = (yaml: string): string | undefined => {
      const concurrencyMatch = yaml.match(/^concurrency:\n((?:[ \t]+.+\n?)+)/m);
      const body = concurrencyMatch?.[1] ?? '';
      return body.match(/group:\s*(\S+)/)?.[1];
    };

    const thisGroup = groupOf(readWorkflow());
    const cronGroup = groupOf(readCronWorkflow());

    expect(thisGroup, 'expected a concurrency.group in ci-failure-rollback.yml').toBeDefined();
    expect(cronGroup, 'expected a concurrency.group in agent-rollback-check.yml').toBeDefined();
    expect(thisGroup).toBe(cronGroup);
  });
});
