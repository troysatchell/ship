// Flat ESLint config (ESLint 9.x). See audit finding TS-6 (TRO-211): before this
// file existed, no `.eslintrc*` or `eslint.config.*` existed anywhere in the repo,
// and `pnpm lint` (`pnpm --recursive run lint`) silently matched zero package
// scripts and exited 0 — reporting a passing quality gate that did not exist.
//
// Scope, deliberately: `api/src`, `web/src`, `shared/src` only. Not `e2e/`, not
// config/script files, not `web/vite.config.ts` (see TS-9 — those are a separate,
// still-open finding).
//
// Ruleset, deliberately: a small, high-signal set, not a full `recommended`/
// `strict` preset and not stylistic/formatting rules (this repo uses Prettier
// for that, separately).
//
// - `eqeqeq` (`always`, with `null: 'ignore'`): every `== null` / `!= null` in
//   this repo is the deliberate "matches both null and undefined" idiom (e.g.
//   `api/src/collaboration/index.ts:330`, `.../concurrent-merge.test.ts:116`).
//   Forcing `=== null` there would *change behavior* (excluding `undefined`),
//   which is the opposite of what a correctness rule should do. With this
//   option the repo passes today with zero changes. Every other `==`/`!=`
//   (real ones, not the null idiom) is still an error.
// - `no-fallthrough`: 0 violations today (this repo already sets
//   `noFallthroughCasesInSwitch` in tsconfig, but that is a tsc check, not an
//   ESLint one — belt and suspenders). Error.
// - `no-floating-promises` / `no-misused-promises` (type-aware; catch real
//   unhandled-rejection and fire-and-forget bugs): the codebase did NOT pass
//   at the time this rule was introduced — 213 and 185 sites respectively
//   (see CHANGES.md for the original per-package counts). Per the ticket's own
//   decision rule ("fix if few and mechanical, otherwise warn and document"),
//   that was far past mechanical: most sites are React event handlers across
//   `web/src/pages/*.tsx`, and a meaningful chunk of the api-side sites sit
//   inside `api/src/collaboration/index.ts` — the file `ship-backend`'s own
//   brief flags as a stop-for-human zone with a documented history of
//   async-ordering bugs (ERR-1/ERR-2/ERR-10/ERR-11/ERR-12). WARN repo-wide
//   for now.
//
//   TRO-297 (TS-10) re-derived the live api-package count (10 sites — the
//   ticket's own cached count of 9 undercounted by one; see CHANGES.md for the
//   exact list) and fixed every one of them, including the collaboration.ts
//   sites — carefully, per the async-ordering pattern above, not as a
//   drive-by. `api/src/**` is promoted to `error` below; `shared/src/**` (0
//   sites, but not yet promoted — no dedicated ticket has verified it stays at
//   zero under `error` the way TRO-297 did for api) stays at `warn` until its
//   own ticket closes it.
//
//   TRO-306 (TS-10 follow-up, batch 1) re-derived the live `web/src/pages/*`
//   count (188 sites across 21 files — the ticket's cached "~389" figure was
//   for all of web/src, not just pages) and fixed every one of them. See
//   CHANGES.md for the exact list and before/after counts. `web/src/pages/**`
//   is promoted to `error` below; the rest of web/src (components, lib,
//   hooks, contexts — a separately-uncounted, still-open population) stays at
//   `warn` until its own ticket closes it. Do not widen the pages override's
//   `files` glob to the rest of web/src without re-verifying that population
//   independently, the same caution TRO-297's comment gives for shared/src.
// - `no-explicit-any` / `no-non-null-assertion`: WARN, not error — these are
//   the audit's counted, still-open violation classes (TS-4 non-null: 236
//   sites repo-wide; `any` tracked by TS-1/TS-2/TS-8), already being burned
//   down by dedicated TS-* tickets and blocked from growing by G7b's
//   review-pattern check. Failing CI on every existing instance today would
//   block every branch in flight; warn keeps them visible without doing that.
import tseslint from 'typescript-eslint';

const correctnessRules = {
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-fallthrough': 'error',
  // See header comment: warn repo-wide by default. api/src overrides both to
  // 'error' below (TRO-297); shared/src and web/src stay here until their own
  // tickets close them out.
  '@typescript-eslint/no-floating-promises': 'warn',
  '@typescript-eslint/no-misused-promises': 'warn',
  // Counted, open audit findings (TS-1/TS-2/TS-4/TS-8) — warn, not error. See
  // the header comment and CHANGES.md for the current counts.
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-non-null-assertion': 'warn',
};

// api/src only (TRO-297 / TS-10): both promise-safety rules promoted to
// 'error'. Verified zero violations at this severity as of TRO-297 — see
// CHANGES.md for the exact command and count. Do not widen this override's
// `files` glob to shared/src or web/src without re-verifying each package
// independently; shared/src being 0 sites today is not the same as it having
// been proven to stay that way under 'error'.
const apiCorrectnessRules = {
  ...correctnessRules,
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
};

// web/src/pages/** only (TRO-306 / TS-10 follow-up, batch 1): both
// promise-safety rules promoted to 'error'. Verified zero violations at this
// severity across all 21 files in web/src/pages as of TRO-306 — see
// CHANGES.md for the exact command and count. Do not widen this override's
// `files` glob to the rest of web/src (components/, lib/, hooks/, contexts/)
// without re-verifying that population independently — see the header
// comment above.
const webPagesCorrectnessRules = {
  ...correctnessRules,
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
};

// api/src/platform/api/v1/** only (TRO-399 / PF-003): the public v1 router
// layer may not import the internal route handlers under api/src/routes/**
// — PLUGFORGE.MD §2.1's Day-1 one-way boundary door ("Both layers call the
// same domain services"). There is no path alias to api/src/routes today, so
// every legal import of it is a relative path (e.g. '../../../routes/documents');
// `no-restricted-imports`'s `patterns` matches against that string as written
// (not the resolved file path), so '**/routes/**' catches any relative depth
// and would equally catch a future absolute/aliased form. Deliberately NOT
// '**/routes*' or a bare 'routes' — this must not false-positive on an
// unrelated 'services/foo' import or a same-named local file.
const apiV1BoundaryRules = {
  ...apiCorrectnessRules,
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['**/routes/**', '**/routes'],
          message:
            'api/src/platform/api/v1/** must not import api/src/routes/** (internal route handlers) — PLUGFORGE.MD §2.1. Both layers call the same domain services; import the service, not the route.',
        },
      ],
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      'e2e/**',
      'scripts/**',
      'audit/**',
      'memory-bank/**',
      '**/*.config.{js,cjs,mjs,ts}',
      'web/scripts/**',
      // Excluded from api/tsconfig.json's program (`exclude: ["src/test/**/*"]`),
      // so there is no tsconfig that covers these for type-aware linting.
      'api/src/test/**',
    ],
  },
  {
    files: ['api/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: apiCorrectnessRules,
  },
  {
    // Placed after the general api/src/**/*.ts block above so this rule's
    // 'error' severity applies specifically to the public v1 router layer
    // (flat config merges same-key rules from later-matching configs over
    // earlier ones — same technique web/src/pages/** uses below).
    files: ['api/src/platform/api/v1/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: apiV1BoundaryRules,
  },
  {
    files: ['shared/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: correctnessRules,
  },
  {
    // TRO-313/315/316 (PR-B): new agent/ workspace package. Scoped the same
    // way as shared/src — same default correctness rules, not yet promoted to
    // the api/src-only 'error' overrides above (no ticket has verified this
    // population stays at zero under 'error' the way TRO-297 did for api).
    files: ['agent/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: correctnessRules,
  },
  {
    // TRO-405 (PF-400): new sdk/ workspace package. Scoped the same way as
    // shared/src and agent/src when each was added — same default
    // correctness rules, not yet promoted to the api/src-only 'error'
    // overrides above (no ticket has verified this population stays at zero
    // under 'error' the way TRO-297 did for api).
    files: ['sdk/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: correctnessRules,
  },
  {
    files: ['web/src/**/*.ts', 'web/src/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: correctnessRules,
  },
  {
    // Placed after the general web/src/** block above so these two rules'
    // 'error' severity wins for files under web/src/pages/** (flat config
    // merges same-key rules from later-matching configs over earlier ones).
    files: ['web/src/pages/**/*.ts', 'web/src/pages/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: webPagesCorrectnessRules,
  },
);
