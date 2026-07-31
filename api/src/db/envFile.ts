/**
 * Decides which dotenv file(s) `client.ts` should load, and with what
 * override precedence, given whether the process is running under vitest and
 * whether a dedicated `.env.test` file exists (TEST-9 / TRO-231).
 *
 * WHY THIS EXISTS
 *
 * `client.ts` used to unconditionally load `api/.env.local` (then `api/.env`)
 * on every import — `pnpm dev` and `pnpm test` alike. `api/.env.local` is
 * exactly the file `scripts/dev.sh` writes, pointing at a developer's DEV
 * database. `dotenv`'s `config()` does NOT override a `DATABASE_URL` already
 * present in `process.env` by default (verified directly: dotenv's
 * `populate()` only assigns a key when
 * `!Object.prototype.hasOwnProperty.call(target, key)`, i.e. `override` must
 * be passed explicitly to change that) — so the bug only bit a developer who
 * never explicitly exported `DATABASE_URL` in their shell, which is the
 * common case, since `pnpm dev` doesn't require one. That developer runs
 * `pnpm dev` (writes `.env.local`), then `pnpm test` — `client.ts` loads
 * `.env.local`'s `DATABASE_URL` into `process.env` at import time, and
 * `api/src/test/setup.ts`'s `beforeAll` then `TRUNCATE`s 16 tables in
 * whatever database that URL points at: the developer's own dev database.
 *
 * `process.env.VITEST` is vitest's own signal, not something invented for
 * this fix: vitest's CLI sets `process.env.VITEST = 'true'` unconditionally
 * in `prepareVitest()` and again passes it in the `env` it hands each worker
 * process it spawns (`node_modules/vitest/dist/chunks/cli-api.*.js`), before
 * any test file — including this module, imported from `setup.ts` — is ever
 * loaded. It is set far earlier and more reliably than `NODE_ENV`: `setup.ts`
 * only sets `process.env.NODE_ENV = 'test'` inside its `beforeAll`, which runs
 * *after* every test file's top-level imports (this module's included) have
 * already executed, so `NODE_ENV` cannot be the signal this decision uses.
 *
 * THE RULE
 *
 * - Not under vitest: unchanged from before this fix — load `.env.local` then
 *   `.env`, neither overriding a value already in `process.env`. This is
 *   `pnpm dev`'s (and production's) existing behavior.
 * - Under vitest, `.env.test` exists: load ONLY `.env.test`, with
 *   `override: true`. A developer who set up a dedicated test database wants
 *   that file to be the single source of truth for test runs, not silently
 *   second-guessed by a stray shell export or a leftover `.env`.
 * - Under vitest, `.env.test` does NOT exist: load NOTHING. Leave
 *   `DATABASE_URL` (and everything else) to whatever the environment already
 *   provided — the factory's `.factory-env`, CI's exported `CI_DATABASE_URL`,
 *   or an explicit developer export. `.env.local`'s dev database URL must
 *   never be the thing that ends up loaded, let alone truncated.
 */

export interface EnvFileLoadPlan {
  /** Absolute path to the dotenv file to load. */
  path: string;
  /** Passed through to dotenv's `config({ override })`. */
  override: boolean;
}

export interface ResolveEnvFilesToLoadInput {
  /** Whether the current process is running under vitest (`process.env.VITEST === 'true'`). */
  isVitest: boolean;
  /**
   * Whether `envTestPath` exists on disk. Callers pass this in (e.g. via
   * `fs.existsSync`) so this function stays pure and independently testable
   * without touching the filesystem or mocking dotenv.
   */
  envTestExists: boolean;
  /** Absolute path to `api/.env.local`. */
  envLocalPath: string;
  /** Absolute path to `api/.env`. */
  envPath: string;
  /** Absolute path to `api/.env.test`. */
  envTestPath: string;
}

/**
 * Pure decision function: given vitest/`.env.test` state, which dotenv
 * file(s) should `client.ts` load, in what order, and with what override
 * precedence. See the file header for the full rationale.
 */
export function resolveEnvFilesToLoad(input: ResolveEnvFilesToLoadInput): EnvFileLoadPlan[] {
  const { isVitest, envTestExists, envLocalPath, envPath, envTestPath } = input;

  if (isVitest) {
    if (envTestExists) {
      return [{ path: envTestPath, override: true }];
    }
    // No .env.test: do NOT fall back to .env.local or .env under vitest.
    return [];
  }

  return [
    { path: envLocalPath, override: false },
    { path: envPath, override: false },
  ];
}
