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
//   unhandled-rejection and fire-and-forget bugs): the codebase does NOT pass
//   today — 213 and 185 sites respectively (see CHANGES.md for the exact
//   per-package counts). Per the ticket's own decision rule ("fix if few and
//   mechanical, otherwise warn and document"), this is far past mechanical:
//   most sites are React event handlers across `web/src/pages/*.tsx`, and a
//   meaningful chunk of the api-side sites sit inside
//   `api/src/collaboration/index.ts` — the file `ship-backend`'s own brief
//   flags as a stop-for-human zone with a documented history of async-ordering
//   bugs (ERR-1/ERR-2/ERR-10/ERR-11/ERR-12). Fixing those under a lint-config
//   ticket, at this volume, is exactly the kind of drive-by this ticket was
//   told not to do. WARN for now; burning this down is real, valuable
//   follow-up work for a dedicated ticket (see CHANGES.md).
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
  // See header comment: far past "few and mechanical" today. Counts in
  // CHANGES.md.
  '@typescript-eslint/no-floating-promises': 'warn',
  '@typescript-eslint/no-misused-promises': 'warn',
  // Counted, open audit findings (TS-1/TS-2/TS-4/TS-8) — warn, not error. See
  // the header comment and CHANGES.md for the current counts.
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-non-null-assertion': 'warn',
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
    files: ['api/src/**/*.ts', 'shared/src/**/*.ts'],
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
