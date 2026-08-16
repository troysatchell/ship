/**
 * TRO-444 (PF-908) — doc-drift guard for the FINAL demo script.
 *
 * `docs/submission/PLUGFORGE-DEMO-SCRIPT.md` quotes the exact stdout lines
 * a viewer will see from `ship login`, `ship webhooks tail` and `ship docs
 * create`, and `docs/submission/social-assets/w6/webhooks-tail-verified.txt`
 * is a verbatim capture of the tail. The failure mode this ticket fixed was
 * a script that had silently gone stale against the code (it still said
 * PF-600 was failing CI). This test pins the quoted strings to the command
 * sources so the next CLI wording change fails here, in `pnpm --filter
 * @ship/cli test`, instead of on camera.
 *
 * Pure filesystem reads — no server, no network, no token.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

const script = read('docs/submission/PLUGFORGE-DEMO-SCRIPT.md');
const captured = read('docs/submission/social-assets/w6/webhooks-tail-verified.txt');
const loginSrc = read('integrations/cli/src/commands/login.ts');
const tailSrc = read('integrations/cli/src/commands/webhooksTail.ts');
const docsSrc = read('integrations/cli/src/commands/docs.ts');
// Act 2 (portal) / Act 3 (CI drill) sources — added when the script was
// re-grounded on 6b60377b after TRO-615/616/621 changed what those surfaces
// print. Same guard, more surfaces.
const drillTtfeSrc = read('scripts/drill/ttfe.ts');
const drillThresholdsSrc = read('scripts/drill/thresholds.ts');
const ciYml = read('.github/workflows/ci.yml');
const auditPageSrc = read('web/src/pages/DeveloperAudit.tsx');

/** Literal user-visible strings the script quotes, each paired with the
 *  source file that must still contain it. */
const QUOTED: ReadonlyArray<{ line: string; source: string; sourceName: string }> = [
  { line: 'To authorize this CLI, open: ', source: loginSrc, sourceName: 'login.ts' },
  { line: 'And enter the code: ', source: loginSrc, sourceName: 'login.ts' },
  { line: 'Waiting for authorization...', source: loginSrc, sourceName: 'login.ts' },
  { line: 'Credentials saved to ', source: loginSrc, sourceName: 'login.ts' },
  { line: 'Waiting for deliveries. Press Ctrl+C to stop and clean up.', source: tailSrc, sourceName: 'webhooksTail.ts' },
  { line: 'Cleaning up...', source: tailSrc, sourceName: 'webhooksTail.ts' },
  { line: '✓ verified', source: tailSrc, sourceName: 'webhooksTail.ts' },
  { line: '✗ rejected', source: tailSrc, sourceName: 'webhooksTail.ts' },
  { line: 'Created document.', source: docsSrc, sourceName: 'docs.ts' },
  // Act 3 — the drill's own header, the two TRO-615 stages/lines, the verdict.
  { line: '=== TRO-455 / PF-603: TTFE drill ===', source: drillTtfeSrc, sourceName: 'ttfe.ts' },
  { line: 'tamper_reject', source: drillTtfeSrc, sourceName: 'ttfe.ts' },
  { line: 'first_delivery_bound: wait_for_delivery ', source: drillTtfeSrc, sourceName: 'ttfe.ts' },
  { line: 'delivery_p95_ms: ', source: drillThresholdsSrc, sourceName: 'thresholds.ts' },
  { line: 'ms budget', source: drillThresholdsSrc, sourceName: 'thresholds.ts' },
  { line: 'verdict: ', source: drillThresholdsSrc, sourceName: 'thresholds.ts' },
  // Act 3 — the two CI job display names the viewer is told to click.
  { line: 'drill · TTFE (PF-603)', source: ciYml, sourceName: 'ci.yml' },
  { line: 'drill · TTFE image-mode (TRO-621)', source: ciYml, sourceName: 'ci.yml' },
  { line: 'Run the TTFE drill against the container image', source: ciYml, sourceName: 'ci.yml' },
  // Act 2 — the optional Audit-page beat.
  { line: 'Public API audit log', source: auditPageSrc, sourceName: 'DeveloperAudit.tsx' },
  { line: 'No API calls recorded yet.', source: auditPageSrc, sourceName: 'DeveloperAudit.tsx' },
];

describe('PLUGFORGE-DEMO-SCRIPT.md quotes real CLI output (TRO-444 drift guard)', () => {
  it.each(QUOTED)('script line "$line" still exists in $sourceName', ({ line, source }) => {
    expect(script, 'the demo script no longer quotes this line — re-check the Act 1 expected output').toContain(line);
    expect(source, 'the CLI no longer prints this line — update PLUGFORGE-DEMO-SCRIPT.md Act 1').toContain(line);
  });

  it('the captured tail frame contains a verified line in formatDeliveryLine()\'s exact shape', () => {
    // `✓ verified  <ISO timestamp>  <event type>` — two spaces between fields,
    // per `formatDeliveryLine` in webhooksTail.ts.
    expect(captured).toMatch(/^✓ verified {2}\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z {2}document\.created$/m);
    expect(captured).toContain('Waiting for deliveries. Press Ctrl+C to stop and clean up.');
  });

  it('the script no longer carries the stale W5 claims that motivated this rewrite', () => {
    expect(script).not.toMatch(/PF-600 is failing CI/);
    expect(script).not.toMatch(/PF-602 isn't built|PF-602 is not started/);
  });
});
