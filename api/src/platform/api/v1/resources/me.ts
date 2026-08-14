/**
 * `/api/v1/me` — PF-201 (Linear TRO-400, PLUGFORGE.MD §4).
 *
 * `GET /` returns `{ user, app, scopes }` for the calling principal
 * (`req.principal`, set by `bearerAuth` — PF-107/`platform/oauth/principal.ts`).
 * Works identically for either token class `bearerAuth` accepts:
 *
 *   - A personal-token principal (`api_tokens`, `principal.app === null`):
 *     `user` is populated, `app` is `null`.
 *   - A Client Credentials OAuth-token principal (PF-104/TRO-416,
 *     `oauth_tokens` with `user_id IS NULL`, `principal.user === null`):
 *     `app` is populated, `user` is `null`.
 *   - (A third shape `bearerAuth` can also produce — an OAuth token from
 *     `authorization_code` — has BOTH populated: `app` always present,
 *     `user` present because that grant always has an acting user. Not
 *     called out separately in the ticket's AC, but follows from the same
 *     `principal.app`/`principal.user` mapping and is covered by this
 *     handler with no special-casing.)
 *
 * `scopes` is always `principal.scopes` — the token's actual granted scopes,
 * for either class.
 *
 * **Scoping decision: no `requireScope(...)` on this route — any valid
 * bearer token may call it, whatever scopes it holds.** Reasoning (ticket
 * asks this be stated, not just decided silently): `/me`-shaped identity
 * endpoints in comparable APIs are gated on "is this token valid" alone, not
 * on holding a specific resource scope — GitHub's `GET /user` and Google's
 * `https://openidconnect.googleapis.com/v1/userinfo` both work for any
 * authenticated token regardless of which resource scopes it was granted,
 * precisely because a client needs to be able to ask "who/what am I, and
 * what CAN I do" before it knows which resource scope to check for. Gating
 * `/me` on a scope most tokens won't have would make the introspection
 * endpoint unusable by the tokens most likely to need it (e.g. a
 * Client-Credentials app with only `webhooks:manage`, which has no
 * `documents:read`/`issues:read`/etc. at all). `bearerAuth` alone (a valid,
 * unexpired, unrevoked token) is therefore the complete authorization
 * requirement here — matching how `v1Routes.get('/health', ...)` needs no
 * auth at all and `resources/documents.ts` needs `bearerAuth` +
 * `requireScope` for its resource-specific reads/writes: `/me` sits between
 * the two, authenticated but not resource-scoped.
 */

import { Router } from 'express';
import type { Request, Router as RouterType } from 'express';
import { bearerAuth } from '../../../oauth/bearerAuth.js';
import { rateLimitBuckets } from '../../../ratelimit/middleware.js';
import { asyncHandler } from '../errorMiddleware.js';
import { serverError } from '../errors.js';

export const meRouter: RouterType = Router();

function requestIdOf(req: Request): string {
  return req.requestId ?? 'missing-request-id';
}

// ─── GET /api/v1/me ─────────────────────────────────────────────────────

meRouter.get(
  '/',
  bearerAuth,
  rateLimitBuckets,
  asyncHandler(async (req, res) => {
    const requestId = requestIdOf(req);

    const principal = req.principal;
    if (!principal) {
      // Unreachable in practice — bearerAuth never calls next() without
      // setting req.principal — but TypeScript can't see that guarantee
      // statically (req.principal is typed optional). Same defensive
      // pattern as every other v1 resource in this ticket.
      throw serverError(requestId);
    }

    res.status(200).json({
      user: principal.user
        ? { id: principal.user.id, email: principal.user.email, name: principal.user.name }
        : null,
      app: principal.app
        ? {
            id: principal.app.id,
            client_id: principal.app.clientId,
            name: principal.app.name,
            is_first_party: principal.app.isFirstParty,
          }
        : null,
      scopes: principal.scopes,
    });
  })
);
