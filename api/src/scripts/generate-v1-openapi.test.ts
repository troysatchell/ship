/**
 * Regression test for PF-204 (Linear TRO-409): the CI drift check must
 * actually be able to fail. Exercises `diffAgainstCommitted` /
 * `renderV1OpenApiSpec` directly against throwaway files under `os.tmpdir()`
 * — never the real `docs/openapi.json` — so this suite has no risk of
 * corrupting the committed spec if it fails partway through, and needs no
 * database (matches `platform/openapi/__tests__/document.test.ts`'s own
 * "no database" note; this file calls the identical
 * `generateV1OpenAPIDocument()` code path one layer up).
 *
 * The PR's drift-simulation evidence (hand-editing the real, committed
 * `docs/openapi.json`, running `pnpm openapi:check`, seeing it fail with a
 * real diff, then reverting and seeing it pass — see CHANGES.md) is the
 * end-to-end proof for a human reader. This test is the same claim, pinned
 * as an automated regression so it can't silently regress later: the CI
 * step is only as strong as `diffAgainstCommitted`'s ability to detect a
 * real difference and correctly recognize a real match.
 */
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffAgainstCommitted, renderV1OpenApiSpec } from './generate-v1-openapi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '..', '..');
const TSX_BIN = path.join(API_ROOT, 'node_modules/.bin/tsx');
const SCRIPT_PATH = path.join(__dirname, 'generate-v1-openapi.ts');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf204-openapi-drift-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tmpFile(name: string): string {
  return path.join(tmpDir, name);
}

describe('PF-204: renderV1OpenApiSpec()', () => {
  it('produces a valid, non-empty OpenAPI 3.1 document with a trailing newline', () => {
    const rendered = renderV1OpenApiSpec();
    expect(rendered.endsWith('\n')).toBe(true);

    const parsed = JSON.parse(rendered);
    expect(parsed.openapi).toMatch(/^3\.1\.\d+$/);
    expect(Object.keys(parsed.paths).length).toBeGreaterThan(0);
  });

  it('is deterministic across two calls in the same process (no random/time-based fields)', () => {
    expect(renderV1OpenApiSpec()).toBe(renderV1OpenApiSpec());
  });
});

describe('PF-204: diffAgainstCommitted() — the CI drift check', () => {
  it('reports no drift when the committed file exactly matches the current registry', () => {
    const committedPath = tmpFile('openapi.json');
    fs.writeFileSync(committedPath, renderV1OpenApiSpec(), 'utf-8');

    const result = diffAgainstCommitted(committedPath);

    expect(result.drift).toBe(false);
    expect(result.missing).toBe(false);
  });

  it('DRIFT SIMULATION: reports drift when the committed file has been hand-edited', () => {
    // This is the automated form of the PR's manual drift-simulation
    // evidence: take a byte-for-byte-correct spec, corrupt one field the
    // way a stale/hand-edited docs/openapi.json would be, and confirm the
    // check does NOT silently pass.
    const committedPath = tmpFile('openapi.json');
    const rendered = renderV1OpenApiSpec();
    const parsed = JSON.parse(rendered);
    parsed.info.title = 'Ship Public API — DRIFTED';
    fs.writeFileSync(committedPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');

    const result = diffAgainstCommitted(committedPath);

    expect(result.drift).toBe(true);
    expect(result.missing).toBe(false);
    // The rendered (correct) spec and the corrupted committed file must
    // actually differ — a red test for the right reason, not a vacuous one.
    expect(result.committed).not.toBe(result.rendered);
  });

  it('DRIFT SIMULATION: reports drift when a route is undocumented (registry gains a path the committed file lacks)', () => {
    // Simulates the other drift shape the ticket names explicitly: an
    // undocumented route landing without its OpenAPI registration being
    // regenerated. Modeled by removing a real, currently-registered path
    // from the "committed" copy — from the check's point of view this is
    // indistinguishable from "the registry gained a path the file doesn't
    // have yet".
    const committedPath = tmpFile('openapi.json');
    const parsed = JSON.parse(renderV1OpenApiSpec());
    expect(parsed.paths['/documents']).toBeDefined();
    delete parsed.paths['/documents'];
    fs.writeFileSync(committedPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');

    const result = diffAgainstCommitted(committedPath);

    expect(result.drift).toBe(true);
  });

  it('reports missing (not just drift) when the committed file does not exist at all', () => {
    const committedPath = tmpFile(`does-not-exist-${randomBytes(4).toString('hex')}.json`);

    const result = diffAgainstCommitted(committedPath);

    expect(result.drift).toBe(true);
    expect(result.missing).toBe(true);
    expect(result.committed).toBeNull();
  });
});

describe('PF-204: CLI entrypoint (`tsx generate-v1-openapi.ts --check`)', () => {
  // CodeRabbit finding on this ticket: `main()`'s direct-execution guard
  // compares `import.meta.url` against a hand-built `file://${process.argv[1]}`
  // string. If that guard silently fails to match (a relative argv[1], an
  // encoded path, a future refactor), `main()` never runs — the process
  // still exits 0 with NO output, which is indistinguishable from "checked,
  // no drift" in a CI log. Every test above exercises the pure functions
  // directly and would stay green even if the guard were completely broken,
  // so it cannot catch this. This test actually spawns the script exactly
  // as CI does (`pnpm openapi:check` -> tsx generate-v1-openapi.ts --check`)
  // and asserts real, visible stdout — a broken guard produces silent exit
  // 0 with empty stdout, which fails the `toContain` assertion below.
  //
  // Runs `--check` (never plain refresh) so it only ever READS the real,
  // committed docs/openapi.json — it cannot corrupt it if this suite fails
  // partway through, and its precondition is exactly what the rest of this
  // PR already guarantees: the committed spec matches the registry.
  it('exits 0 and prints a real OK line against the actual committed docs/openapi.json', () => {
    const result = spawnSync(TSX_BIN, [SCRIPT_PATH, '--check'], {
      cwd: API_ROOT,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('matches the in-process /api/v1 OpenAPI registry');
  });
});
