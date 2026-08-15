/**
 * Ephemeral Ship API tokens minted for a single on-demand FleetGraph agent
 * chat request (TRO-342).
 *
 * Before this ticket, the agent process authenticated every outbound Ship
 * read — on-demand and proactive alike — with ONE `SHIP_API_TOKEN` env var,
 * contradicting FLEETGRAPH.MD's "Deployment model": "There is no service
 * account. Every API token belongs to a real user, so the agent runs under
 * each person's own token... It can reach anything you could reach, and
 * nothing you could not." `api/src/routes/agent.ts`'s `POST /chat` already
 * knows the requesting user (`req.userId`, from their own session) — this
 * module is what turns that identity into an actual Ship API token the
 * agent can authenticate with for THIS one request, reusing the SAME
 * `api_tokens` table and token format `routes/api-tokens.ts`'s self-service
 * "generate a personal access token" flow already uses (`ship_` + 32 random
 * bytes hex, SHA-256 hash stored — never the plaintext). No new
 * infrastructure: this is the existing mechanism, called server-side
 * instead of through a user-driven form.
 *
 * Deliberately NOT a thin wrapper around `routes/api-tokens.ts`'s own
 * `POST /` handler: that route is a self-service, human-facing flow (name
 * uniqueness conflict as a 409, audit-logged as `api_token.created`, no
 * built-in expiry unless the caller asks for one) and touching it risks
 * regressing its own tested behavior for a caller (`routes/agent.ts`) it was
 * never written for. This module owns its own minimal insert/revoke pair
 * instead.
 *
 * Naming (read before reusing this for anything else): `api_tokens` has
 * `UNIQUE(user_id, workspace_id, name)` (`migrations/014_api_tokens.sql`) —
 * NOT scoped to active (non-revoked) rows. A fixed name would collide with
 * this same user's own PRIOR ephemeral token the moment a second `/chat`
 * request came in for them, even though the first was already revoked (a
 * revoked row still occupies its `name` under that constraint). Every mint
 * below gets a fresh, globally-unique name (`agent-chat:<uuid>`) for exactly
 * this reason — verified against the migration's actual DDL, not assumed.
 *
 * Lifecycle: short expiry (`EPHEMERAL_TOKEN_EXPIRY_MS`) AND an explicit
 * revoke once the agent call this token was minted for has settled
 * (`routes/agent.ts`'s own `finally` block) — belt and braces. The explicit
 * revoke is what actually bounds a normal request's exposure window to
 * "this one outbound call"; the expiry is what bounds it even if the
 * process crashes between mint and revoke and the explicit call never runs.
 */
import crypto from 'crypto';
import { pool } from '../db/client.js';

/** How long an ephemeral agent token remains valid if `revokeAgentToken`
 * never runs (a crash between mint and revoke, or the outbound call to the
 * agent hanging past this window). Short on purpose — this token exists to
 * authenticate exactly ONE on-demand answer's worth of Ship reads, never to
 * be reused across requests. */
const EPHEMERAL_TOKEN_EXPIRY_MS = 5 * 60 * 1000;

export interface MintedAgentToken {
  /** `api_tokens.id` — pass to `revokeAgentToken` once the request this
   * token was minted for has settled. */
  id: string;
  /** The plaintext token. Only ever held in memory for the duration of one
   * outbound call to the agent service — never logged, never returned to
   * the browser, never persisted (only its SHA-256 hash is stored, same as
   * every other `api_tokens` row). */
  token: string;
}

/** Row shape for the `RETURNING id` below — named per RULE-21
 * (`pool.query` rows are untyped `any` otherwise). */
interface MintedTokenRow {
  id: string;
}

/**
 * Mints a short-lived Ship API token scoped to `userId`/`workspaceId`,
 * indistinguishable on Ship's own side from a token that person generated
 * themselves via `POST /api/api-tokens` — `authMiddleware`
 * (`middleware/auth.ts`) validates it the identical way, resolving
 * `req.userId`/`req.workspaceId`/`req.isSuperAdmin` from the SAME
 * `api_tokens` row shape, and never reads the `scopes` column at all
 * (verified directly, not assumed — `validateApiToken`'s own `SELECT`
 * omits it). This is the mechanism that makes the agent's on-demand Ship
 * reads genuinely run under the asking person's own permissions
 * (FLEETGRAPH.MD: "it can reach anything you could reach, and nothing you
 * could not") rather than the agent's own elevated identity.
 *
 * `scopes` (PF-703, TRO-435): optional, `undefined` by default — every
 * existing caller (`POST /chat`'s `askingUserToken`) is unaffected, and a
 * `NULL`-scopes row remains what it always was (the legacy-unscoped shape,
 * still perfectly valid for internal-API auth above). When a caller DOES
 * pass `scopes`, this becomes a "scoped personal token" — PF-107's SECOND
 * `/api/v1` bearer-auth token class (`bearerAuth.ts`'s own header:
 * "migration 043 only added the `scopes` column"; a `NULL`-scopes row is
 * rejected there, never a `[]`-scopes one). `routes/agent.ts`'s
 * `POST /accept-draft` is the one caller that passes it today, requesting
 * `['documents:write', 'issues:write']` so the SAME minted token
 * authenticates BOTH the internal write path (`authMiddleware`, scopes
 * ignored, as this doc comment states above) AND `agent/`'s sdk-mode
 * `GateShipClient` writes through `/api/v1/*` (`bearerAuth`, which DOES
 * check `scopes`) — one token, valid against whichever wire protocol the
 * running agent process happens to be configured for.
 */
export async function mintEphemeralAgentToken(
  userId: string,
  workspaceId: string,
  scopes?: string[]
): Promise<MintedAgentToken> {
  const randomBytes = crypto.randomBytes(32).toString('hex');
  const token = `ship_${randomBytes}`;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const prefix = token.substring(0, 12); // "ship_" + first 7 hex chars, matching routes/api-tokens.ts's own convention.
  // See this module's own docstring for why a per-mint random suffix is
  // required, not optional, here.
  const name = `agent-chat:${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + EPHEMERAL_TOKEN_EXPIRY_MS);

  const result = await pool.query<MintedTokenRow>(
    `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [userId, workspaceId, name, hash, prefix, expiresAt, scopes ?? null]
  );

  const row = result.rows[0];
  if (!row) {
    // Unreachable in practice (a successful INSERT ... RETURNING always
    // yields exactly one row) — kept as an explicit guard rather than a
    // non-null assertion (lessons.md #16/#21), matching this codebase's
    // "fails loudly rather than silently" posture elsewhere (graph.ts's own
    // require*Deps helpers).
    throw new Error('mintEphemeralAgentToken: INSERT ... RETURNING id returned no row');
  }

  return { id: row.id, token };
}

/**
 * Revokes an ephemeral token minted by `mintEphemeralAgentToken`. Idempotent
 * (the `revoked_at IS NULL` guard means a second call is a harmless no-op,
 * matching `routes/api-tokens.ts`'s own revoke semantics) and never throws —
 * callers treat this as best-effort cleanup (`routes/agent.ts`'s `finally`
 * block logs but does not fail the response if this fails), since the
 * token's own short expiry is the fallback guarantee.
 */
export async function revokeAgentToken(id: string): Promise<void> {
  await pool.query(`UPDATE api_tokens SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`, [id]);
}
