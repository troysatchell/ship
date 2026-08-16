/**
 * TRO-369 (W5 sweep) — `.gitlab-ci.yml` never invoked the agent's regression
 * suite. GitLab is the platform this submission is actually graded on
 * (`.gitlab-ci.yml`'s own header: assignment "Submission Requirements:
 * 'GitLab Repository'"), and before this ticket the file contained exactly
 * one `@ship/agent` filter line — `pnpm --filter @ship/agent build` inside
 * the `e2e-agent` job — and never `pnpm --filter @ship/agent test`, while
 * `.github/workflows/ci.yml:131-135` ran the suite with
 * `DATABASE_URL`/`NODE_ENV=test`. On the graded platform, all six FleetGraph
 * use cases' regression tests had zero coverage running at all.
 *
 * This asserts the actual YAML structure rather than trusting a comment.
 * Neither `js-yaml` nor `yaml` is a declared dependency of any package in
 * this repo (both appear only transitively, under lint/build tooling — see
 * the root `package.json`'s own `js-yaml` override comment) and adding one
 * solely for this test is unwarranted scope for a two-job, hand-maintained
 * CI file. Instead this slices out a named top-level job's own body — every
 * line indented under its `<name>:` header, stopping at the first
 * non-blank, unindented line (this file's own 2-space-indent convention
 * makes that boundary exact) — and asserts against that slice, so a match
 * only counts if it is actually inside the named job, not merely present
 * anywhere in the file. That distinction is the actual bug this ticket
 * fixes: `build` living in `e2e-agent` was real and legitimate; `test`
 * living nowhere was the gap.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readGitlabCi(): string {
  // agent/src/__tests__/ -> repo root is four levels up.
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../');
  return readFileSync(path.join(repoRoot, '.gitlab-ci.yml'), 'utf8');
}

/**
 * Extracts a top-level GitLab CI job's own body: every line after its
 * `<jobName>:` header (an exact, unindented line) up to but not including
 * the first non-blank line that is itself unindented — the next job's own
 * leading comment or key, whichever comes first. Throws if the job header
 * is not found, so a typo'd job name fails loudly rather than matching an
 * empty slice.
 */
function extractJobBody(yaml: string, jobName: string): string {
  const lines = yaml.split('\n');
  const startIndex = lines.findIndex((line) => line === `${jobName}:`);
  if (startIndex === -1) {
    throw new Error(`No top-level job named "${jobName}:" found in .gitlab-ci.yml`);
  }
  const rest = lines.slice(startIndex + 1);
  const endOffset = rest.findIndex((line) => line.trim().length > 0 && !line.startsWith(' '));
  const bodyLines = endOffset === -1 ? rest : rest.slice(0, endOffset);
  return bodyLines.join('\n');
}

describe('extractJobBody (test-helper self-check)', () => {
  it('finds the verify job and stops before the next top-level job', () => {
    const yaml = readGitlabCi();
    const body = extractJobBody(yaml, 'verify');
    expect(body).toContain('stage: verify');
    // e2e-agent's own body must not leak into verify's slice. `stage: e2e`
    // (not the string "e2e-agent", which verify's own comments legitimately
    // reference by name when explaining where `pnpm --filter @ship/agent
    // build` still runs) only ever appears inside e2e-agent's own body.
    expect(body).not.toContain('stage: e2e');
  });

  it('throws on an unknown job name rather than silently matching nothing', () => {
    const yaml = readGitlabCi();
    expect(() => extractJobBody(yaml, 'not-a-real-job')).toThrow(/No top-level job named/);
  });
});

/**
 * Matches only an actual GitLab CI `script:` list entry invoking the agent
 * test command — `^\s*-\s+` anchors to a real YAML list item, never a `#`
 * comment. This matters because `verify`'s own script block carries a
 * comment (just above the real invocation) that narrates the ticket's
 * before/after in prose and literally contains the substring
 * "`pnpm --filter @ship/agent test`" inside a NEGATION ("...it invoked
 * `pnpm --filter @ship/agent build` ... but never `pnpm --filter @ship/agent
 * test`"). The previous unanchored regex matched that comment line first —
 * so this test (and the `|| true` test below, which reused its match) passed
 * even with the real `- pnpm --filter @ship/agent test` list entry deleted
 * entirely, because the comment's own negated mention satisfied the regex on
 * its own.
 */
const AGENT_TEST_LIST_ENTRY = /^\s*-\s+pnpm --filter @ship\/agent test(?:\s|$)/m;

describe('.gitlab-ci.yml — verify job runs the agent regression suite (TRO-369)', () => {
  it('invokes `pnpm --filter @ship/agent test` as a real script list entry inside the verify job, not merely in a comment', () => {
    const yaml = readGitlabCi();
    const verifyBody = extractJobBody(yaml, 'verify');

    expect(verifyBody).toMatch(AGENT_TEST_LIST_ENTRY);
  });

  it("sets DATABASE_URL and NODE_ENV=test on the verify job, mirroring ci.yml:131-135's env for the same command", () => {
    const yaml = readGitlabCi();
    const verifyBody = extractJobBody(yaml, 'verify');

    expect(verifyBody).toMatch(/DATABASE_URL:\s*"?\$CI_DATABASE_URL"?/);
    expect(verifyBody).toMatch(/NODE_ENV:\s*test\b/);
  });

  it('runs the agent test step without `|| true` (unlike api/web, the agent suite has no quarantine baseline to diff against)', () => {
    const yaml = readGitlabCi();
    const verifyBody = extractJobBody(yaml, 'verify');
    const agentTestLine = verifyBody
      .split('\n')
      .find((line) => AGENT_TEST_LIST_ENTRY.test(line));

    expect(agentTestLine, 'expected a real `- pnpm --filter @ship/agent test` list entry inside the verify job').toBeDefined();
    expect(agentTestLine).not.toMatch(/\|\|\s*true/);
  });

  it('still builds (never tests) the agent package inside e2e-agent — that job is for Playwright flows, not unit/integration coverage', () => {
    const yaml = readGitlabCi();
    const e2eAgentBody = extractJobBody(yaml, 'e2e-agent');

    expect(e2eAgentBody).toMatch(/pnpm --filter @ship\/agent build\b/);
    expect(e2eAgentBody).not.toMatch(/pnpm --filter @ship\/agent test\b/);
  });

  it('matcher correctly rejects `test:unit` variant to prevent false positives', () => {
    const testUnitVariant = '  - pnpm --filter @ship/agent test:unit';
    expect(testUnitVariant).not.toMatch(AGENT_TEST_LIST_ENTRY);

    const actualCommand = '  - pnpm --filter @ship/agent test';
    expect(actualCommand).toMatch(AGENT_TEST_LIST_ENTRY);

    const actualCommandWithWhitespace = '  - pnpm --filter @ship/agent test ';
    expect(actualCommandWithWhitespace).toMatch(AGENT_TEST_LIST_ENTRY);
  });
});

/**
 * TRO-440 (PF-704) — "CI runs agent tests with flag on and off." Asserts
 * the SECOND invocation exists as a real script list entry with
 * `AGENT_PLATFORM_MODE=sdk` set, inside the same `verify` job, distinct
 * from the flag-off invocation above.
 */
describe('.gitlab-ci.yml — verify job runs the agent suite a second time with AGENT_PLATFORM_MODE=sdk (TRO-440)', () => {
  const AGENT_TEST_SDK_MODE_ENTRY = /^\s*-\s+AGENT_PLATFORM_MODE=sdk pnpm --filter @ship\/agent test(?:\s|$)/m;

  it('invokes the agent suite a second time with AGENT_PLATFORM_MODE=sdk as a real script list entry', () => {
    const yaml = readGitlabCi();
    const verifyBody = extractJobBody(yaml, 'verify');

    expect(verifyBody).toMatch(AGENT_TEST_SDK_MODE_ENTRY);
  });

  it('the flag-off invocation (no AGENT_PLATFORM_MODE) still exists alongside the flag-on one — both, not a replacement', () => {
    const yaml = readGitlabCi();
    const verifyBody = extractJobBody(yaml, 'verify');

    expect(verifyBody).toMatch(AGENT_TEST_LIST_ENTRY);
    expect(verifyBody).toMatch(AGENT_TEST_SDK_MODE_ENTRY);
  });
});

/**
 * TRO-440 (PF-704), CodeRabbit finding on this ticket's own PR — the
 * GitLab-side fitness test above had no `.github/workflows/ci.yml`
 * equivalent, so a future edit could silently desync the two platforms with
 * nothing structural to catch it (exactly the class of gap TRO-369's own
 * `.gitlab-ci.yml` test exists to prevent, just on the other file).
 *
 * GH Actions' YAML shape differs from GitLab's (a job's `steps:` is a list
 * of `- name: ... / run: ...` pairs, not a flat `script:` list), so this
 * reuses the same "slice out one top-level job's own body, stop at the next
 * unindented top-level key" technique `extractJobBody` above already
 * established, rather than force-fitting GitLab's job-extraction helper
 * onto a differently-shaped file.
 */
function readGithubCi(): string {
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../');
  return readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
}

function extractGithubJobBody(yaml: string, jobName: string): string {
  const lines = yaml.split('\n');
  const startIndex = lines.findIndex((line) => line === `  ${jobName}:`);
  if (startIndex === -1) {
    throw new Error(`No top-level job named "  ${jobName}:" found in .github/workflows/ci.yml`);
  }
  const rest = lines.slice(startIndex + 1);
  // A GH Actions job's own top-level keys (steps:, runs-on:, needs:, ...)
  // sit at 4-space indent under the 2-space job name — the boundary is the
  // first non-blank line indented by 2 spaces or less (the next job, or a
  // workflow-level key), same "stop before the next unindented key" idea
  // extractJobBody uses, just at this file's own indent depth.
  const endOffset = rest.findIndex((line) => line.trim().length > 0 && !line.startsWith('    '));
  const bodyLines = endOffset === -1 ? rest : rest.slice(0, endOffset);
  return bodyLines.join('\n');
}

describe('.github/workflows/ci.yml — verify job runs the agent suite a second time with AGENT_PLATFORM_MODE=sdk (TRO-440)', () => {
  it('finds the verify job and stops before the next top-level job', () => {
    const yaml = readGithubCi();
    const body = extractGithubJobBody(yaml, 'verify');
    expect(body).toContain('Agent tests');
    // drill-ttfe is a distinct top-level job — its own name must not leak
    // into verify's slice.
    expect(body).not.toContain('drill · TTFE');
  });

  it('has both the flag-off "Agent tests" step and the flag-on "Agent tests (AGENT_PLATFORM_MODE=sdk)" step', () => {
    const yaml = readGithubCi();
    const body = extractGithubJobBody(yaml, 'verify');

    expect(body).toMatch(/- name: Agent tests\s*$/m);
    expect(body).toMatch(/- name: Agent tests \(AGENT_PLATFORM_MODE=sdk\)/);
  });

  it('the flag-on step actually sets AGENT_PLATFORM_MODE: sdk in its own env block, not just its name', () => {
    const yaml = readGithubCi();
    const body = extractGithubJobBody(yaml, 'verify');
    const stepStart = body.indexOf('- name: Agent tests (AGENT_PLATFORM_MODE=sdk)');
    expect(stepStart).toBeGreaterThan(-1);
    // The step's own body: from its header to the next `- name:` (or end).
    const afterStep = body.slice(stepStart);
    const nextStepOffset = afterStep.indexOf('\n      - name:', 1);
    const stepBody = nextStepOffset === -1 ? afterStep : afterStep.slice(0, nextStepOffset);

    expect(stepBody).toMatch(/AGENT_PLATFORM_MODE:\s*sdk\b/);
    expect(stepBody).toMatch(/run:\s*pnpm --filter @ship\/agent test\b/);
  });
});
