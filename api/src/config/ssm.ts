/**
 * SSM Parameter Store - Application Configuration
 *
 * This file loads application configuration from AWS SSM Parameter Store.
 *
 * Secrets Storage:
 * ─────────────────
 * SSM Parameter Store (/ship/{env}/):
 *   - DATABASE_URL, SESSION_SECRET, CORS_ORIGIN
 *   - Application config that changes per environment
 *   - CAIA OAuth credentials (CAIA_ISSUER_URL, CAIA_CLIENT_ID, etc.)
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// Lazy-initialized client to avoid keeping Node.js alive during import tests
let _client: SSMClient | null = null;

function getClient(): SSMClient {
  if (!_client) {
    _client = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return _client;
}

/**
 * Bounded timeout + retry policy for SSM calls (TRO-248 / RULE-7).
 *
 * FAILURE MODE THIS PROTECTS AGAINST: before this, a single SSM call had no
 * per-request timeout and no retry — one transient blip (a cold VPC
 * endpoint, a brief throttle, a dropped connection) either hung boot
 * indefinitely or failed on the first attempt. On AWS, where production has
 * no `DATABASE_URL`/`SESSION_SECRET` env fallback, that failure falls
 * straight through `loadProductionSecrets`'s catch block below to the
 * `throw`, which crash-loops the container. Transient SSM latency at boot is
 * not the same failure as SSM being genuinely unreachable; this bounds how
 * long any one attempt can hang and absorbs a small number of transient
 * failures before giving up to that same fallback path.
 */
const SSM_REQUEST_TIMEOUT_MS = 5000;
const SSM_MAX_ATTEMPTS = 3; // 1 initial attempt + 2 retries
const SSM_RETRY_BASE_DELAY_MS = 200;
const SSM_RETRY_MAX_DELAY_MS = 2000;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with full jitter, capped at `SSM_RETRY_MAX_DELAY_MS`.
 * Jittered (rather than a fixed schedule) so that if several secrets are
 * fetched concurrently (`loadProductionSecrets`'s `Promise.all` below) and
 * all fail on the same underlying blip, their retries don't land in lockstep
 * and re-create the load they're backing off from.
 */
function ssmRetryDelayMs(attempt: number): number {
  const cap = Math.min(SSM_RETRY_BASE_DELAY_MS * 2 ** attempt, SSM_RETRY_MAX_DELAY_MS);
  return Math.round(Math.random() * cap);
}

/**
 * Runs one SSM call with a per-attempt timeout, retrying transient failures
 * (network errors, throttling, the timeout itself) up to `SSM_MAX_ATTEMPTS`
 * times total. Concurrency note: this is a bounded, one-shot retry inside a
 * single call — not a `setInterval` — so there is no in-flight-guard
 * question; `loadProductionSecrets` awaits it once at boot before the app is
 * created (`index.ts`), and nothing else invokes it concurrently.
 */
async function sendWithRetry<T>(
  label: string,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < SSM_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SSM_REQUEST_TIMEOUT_MS);
    try {
      return await fn(controller.signal);
    } catch (err) {
      lastErr = isAbortError(err)
        ? new Error(`${label} timed out after ${SSM_REQUEST_TIMEOUT_MS}ms`)
        : err;
      if (attempt < SSM_MAX_ATTEMPTS - 1) {
        await sleep(ssmRetryDelayMs(attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function getSSMSecret(name: string): Promise<string> {
  const command = new GetParameterCommand({
    Name: name,
    WithDecryption: true,
  });

  const response = await sendWithRetry(`SSM parameter ${name}`, (signal) =>
    getClient().send(command, { abortSignal: signal })
  );
  // Reached only after a successful call — the parameter genuinely doesn't
  // exist (or has no value), which is a permanent condition. Retrying it
  // above would not help, which is why this check sits outside the retry.
  if (!response.Parameter?.Value) {
    throw new Error(`SSM parameter ${name} not found`);
  }
  return response.Parameter.Value;
}

export async function loadProductionSecrets(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    return; // Use .env files for local dev
  }

  const environment = process.env.ENVIRONMENT || 'prod';
  const basePath = `/ship/${environment}`;

  console.log(`Loading secrets from SSM path: ${basePath}`);

  try {
    const [databaseUrl, sessionSecret, corsOrigin, cdnDomain, appBaseUrl] = await Promise.all([
      getSSMSecret(`${basePath}/DATABASE_URL`),
      getSSMSecret(`${basePath}/SESSION_SECRET`),
      getSSMSecret(`${basePath}/CORS_ORIGIN`),
      getSSMSecret(`${basePath}/CDN_DOMAIN`),
      getSSMSecret(`${basePath}/APP_BASE_URL`),
    ]);

    process.env.DATABASE_URL = databaseUrl;
    process.env.SESSION_SECRET = sessionSecret;
    process.env.CORS_ORIGIN = corsOrigin;
    process.env.CDN_DOMAIN = cdnDomain;
    process.env.APP_BASE_URL = appBaseUrl;

    console.log('Secrets loaded from SSM Parameter Store');
    console.log(`CORS_ORIGIN: ${corsOrigin}`);
    console.log(`CDN_DOMAIN: ${cdnDomain}`);
    console.log(`APP_BASE_URL: ${appBaseUrl}`);
  } catch (err) {
    // SSM is the AWS delivery mechanism, not the only one. On a platform that
    // injects secrets as environment variables directly (Render, Fly, a plain
    // container), there are no AWS credentials and this call cannot succeed —
    // previously it threw and killed the process before the app ever started.
    //
    // Fall back only when the environment already supplies what SSM would have
    // provided, so a genuine AWS misconfiguration still fails loudly instead of
    // starting a server with no database.
    const message = err instanceof Error ? err.message : String(err);

    if (process.env.DATABASE_URL && process.env.SESSION_SECRET) {
      console.warn(
        `SSM unavailable (${message}) — continuing with secrets supplied by the environment.`
      );
      return;
    }

    console.error(
      `SSM unavailable (${message}) and neither DATABASE_URL nor SESSION_SECRET is set in the ` +
      `environment. Provide them directly, or grant this runtime read access to ${basePath}/*.`
    );
    throw err;
  }
}
