/**
 * GitHub App installation authentication (PF-804 / TRO-453) — the "Ship -> GitHub" direction's
 * auth: exchanging the App's own credentials for a short-lived token scoped to one installation,
 * per GitHub's documented flow
 * (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).
 *
 * Two steps:
 *   1. `signAppJwt` — a RS256 JWT signed with the App's own private key (`iss` = App ID,
 *      `iat`/`exp` a short window), proving "I am this GitHub App."
 *   2. `getInstallationAccessToken` — `POST /app/installations/{id}/access_tokens` with that JWT
 *      as a Bearer token, exchanged for a ~1-hour installation access token scoped to exactly the
 *      repos/permissions the human granted at install time.
 *
 * Hand-rolled RS256 signing via `node:crypto` rather than a `jsonwebtoken`/`jose` dependency —
 * this is `api/src` (first-party), not `integrations/*`, so the dependency-boundary rule
 * (`scripts/check-integration-deps.mjs`) doesn't technically apply here, but the JWT this
 * function needs is three base64url-encoded parts and one RSA-SHA256 signature: exactly what
 * `secretEncryption.ts`'s own header calls out as this directory's standing preference
 * ("dependency-free apart from `node:crypto`") for anything `node:crypto` already covers, without
 * pulling in a general-purpose JWT library for a single, fixed claim shape.
 */

import { createSign } from 'node:crypto'

export interface GithubAppCredentials {
  /** The GitHub App's numeric ID (`GITHUB_APP_ID`). */
  appId: string
  /** The App's PEM-encoded RSA private key, exactly as GitHub generates it
   *  (`GITHUB_APP_PRIVATE_KEY` — see README for how this env var is expected to be supplied:
   *  the raw PEM, newlines included, not a path or a base64 wrapper — matching how every other
   *  multi-line secret in this repo's env-var conventions is documented). */
  privateKey: string
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Signs a JWT per GitHub's App-authentication contract: `iat` one minute in the past (GitHub's
 * own docs: "to allow for a small amount of clock drift"), `exp` at most 10 minutes ahead (the
 * ceiling GitHub enforces — this uses 8 minutes to stay clear of a boundary rounding error), `iss`
 * the App ID.
 *
 * `now` is injectable (Unix seconds) for deterministic tests — same shape as
 * `platform/webhooks/signer.ts`'s own injected `Clock`.
 */
export function signAppJwt(credentials: GithubAppCredentials, now: number = Math.floor(Date.now() / 1000)): string {
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iat: now - 60,
    exp: now + 8 * 60,
    iss: credentials.appId,
  }

  const encodedHeader = base64url(Buffer.from(JSON.stringify(header)))
  const encodedPayload = base64url(Buffer.from(JSON.stringify(payload)))
  const signingInput = `${encodedHeader}.${encodedPayload}`

  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  const signature = base64url(signer.sign(credentials.privateKey))

  return `${signingInput}.${signature}`
}

/**
 * Exchanges an App JWT for an installation access token. `fetchImpl` is injectable (defaults to
 * global `fetch`) so tests never make a real network call — same convention as
 * `deliverer.ts`'s `fetchImpl` option.
 *
 * Throws on any non-2xx response (an installation token request failing is not a "retryable
 * delivery" the way an outbound webhook POST is — see `deliverer.ts`'s retry-on-5xx design; this
 * call sits inline in a single event-handler invocation with no retry queue behind it, so the
 * caller decides whether to catch/log or let it propagate, per `postBackService.ts`'s own
 * doc comment on how it handles this).
 */
/** GitHub's own timeout guidance for API calls doesn't specify a number, so this matches
 *  `deliverer.ts`'s outbound-HTTP default order of magnitude — long enough for a slow-but-live
 *  endpoint, short enough that a hung GitHub API can't block the `issue.status_changed` handler
 *  that calls this indefinitely. */
const INSTALLATION_TOKEN_TIMEOUT_MS = 10_000

export async function getInstallationAccessToken(
  appJwt: string,
  // `github_pr_links.installation_id` is BIGINT, which node-postgres reads back as a string
  // (see linkSyncService.ts's getLinksForIssue) — accept both rather than forcing every caller
  // to round-trip through Number() for a value only ever used as a URL path segment.
  installationId: string | number,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(INSTALLATION_TOKEN_TIMEOUT_MS),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`GitHub installation token request failed: ${response.status} ${body.slice(0, 500)}`)
  }

  const data: unknown = await response.json()
  if (
    typeof data !== 'object' ||
    data === null ||
    !('token' in data) ||
    typeof (data as { token: unknown }).token !== 'string' ||
    (data as { token: string }).token.length === 0
  ) {
    throw new Error('GitHub installation token response did not include a non-empty token string')
  }
  return (data as { token: string }).token
}
