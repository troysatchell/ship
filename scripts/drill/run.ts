#!/usr/bin/env node
/**
 * `pnpm drill <name>` — dispatcher (TRO-455 / PF-603). Today there is
 * exactly one drill (`ttfe`), but the PRD names the command as `pnpm drill
 * ttfe` (an argument, not the whole command), so this stays a thin router
 * rather than hardcoding `ttfe.ts` as the only possible entry — the same
 * shape a second future drill (e.g. a refresh-rotation or idempotency-key
 * drill promoted out of e2e/ into this CI-graded family) would slot into
 * without renaming anything already wired into `.gitlab-ci.yml`/`ci.yml`.
 */
const name = process.argv[2];

if (name === 'ttfe') {
  await import('./ttfe.js');
} else {
  console.error(`Unknown drill: ${JSON.stringify(name ?? '')}. Usage: pnpm drill ttfe`);
  process.exitCode = 2;
}
