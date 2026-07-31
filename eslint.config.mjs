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
//   zero under `error` the way TRO-297 did for api) and `web/src/**` (~389
//   sites) stay at `warn` until their own tickets close them. Recommended
//   split for web: by directory (e.g. a few `web/src/pages/*` batches), not
//   one mega-ticket — see CHANGES.md.
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
);
