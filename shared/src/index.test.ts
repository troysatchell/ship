import { describe, it, expect } from 'vitest';
import * as sharedBarrel from './index.js';
import * as typesBarrel from './types/index.js';

// Both barrels are `export * from './x.js'` chains — real, executable
// statements, not type-only declarations, so they belong in coverage. The
// meaningful failure mode this guards against is re-export drift on the
// exports checked below: a symbol gets renamed or removed from its source
// file but the barrel's re-export line is left stale, so what used to be
// `typesBarrel.computeICEScore` silently becomes `undefined`. Asserting
// import-time success plus a known value (rather than just "the module
// loaded") catches that — an interface-only export can't be checked by
// value, so HTTP_STATUS/computeICEScore are the concrete, checkable things
// available here. This does NOT guard against a brand-new source file being
// added under types/ and never wired into types/index.ts at all — only
// against drift on the exports this file actually asserts against.
describe('shared/src/index.ts (root barrel)', () => {
  it('re-exports the runtime values from constants.ts', () => {
    expect(sharedBarrel.HTTP_STATUS.OK).toBe(200);
    expect(sharedBarrel.SESSION_TIMEOUT_MS).toBe(900_000);
  });
});

describe('shared/src/types/index.ts (types barrel)', () => {
  it('loads without throwing and re-exports document.ts\'s runtime helper', () => {
    // user.ts/api.ts/auth.ts/workspace.ts are interface-only; document.ts is
    // the one file in this barrel with a real runtime export
    // (computeICEScore, also exercised directly in types/document.test.ts).
    // There is nothing value-level to assert about an interface, so a
    // successful import plus the one real function it does carry is the
    // meaningful assertion: it proves every `export * from './x.js'` path in
    // this barrel still resolves, not just that the module object exists.
    expect(typeof typesBarrel.computeICEScore).toBe('function');
  });
});
