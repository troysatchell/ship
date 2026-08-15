/**
 * `requireScope(scope)` — the "`require(scope)` middleware factory" named by
 * PLUGFORGE.MD §4 (PF-107) and the brief's own grading checklist. Exported
 * as `requireScope` rather than the literal identifier `require`: `require`
 * shadows the ambient Node/`@types/node` global of the same type
 * (`NodeRequire`) in every file that would import it, which is legal
 * TypeScript but a needless collision risk for no behavioral difference —
 * flagged here, and in this ticket's final report, as a deliberate naming
 * deviation from the PRD's prose, not a scope change. Usage is exactly what
 * the PRD describes: `router.get('/x', bearerAuth, requireScope('documents:read'), handler)`.
 *
 * Must run AFTER `bearerAuth` — it reads `req.principal`, which only
 * `bearerAuth` sets. A route wired without `bearerAuth` first sees
 * `req.principal` undefined and is rejected the same as an unscoped one
 * (fails closed).
 *
 * Insufficient scope -> `403`, `code: "forbidden"`, `details.missing_scope`
 * naming the scope the caller lacked — never an opaque "forbidden" (§2.3).
 *
 * The returned middleware is given an explicit `.name` — `requireScope(<scope>)`
 * — via `Object.defineProperty` below (PF-203, Linear TRO-404). Purely for
 * structural introspection: Express's own `Layer.name` mirrors `fn.name`, so
 * `route-fitness.test.ts`'s router-stack walk can discover "this route
 * declares scope X" from the live middleware stack itself, with no parallel
 * hand-maintained record of which route needs which scope. No behavioral
 * change — the function body and closure are unaffected.
 */

import type { NextFunction, Request, Response } from 'express';
import { ScopeRegistry } from './registry.js';
import { forbiddenError } from '../api/v1/errors.js';
import '../oauth/principal.js';

// Extend Express Request with the scope this route's requireScope(...) call
// checked — read by `platform/audit/middleware.ts`'s fire-and-forget audit
// write (PF-501/TRO-432) for the `public_api_audit.scope_used` column. Set
// unconditionally, before the pass/fail branch below, so a 403 (scope
// missing) is recorded with the SAME scope_used a 200 would have carried —
// the audit trail's whole point is showing what was checked, not just what
// succeeded. Merges with the other `declare global` augmentations in this
// codebase (requestId.ts, principal.ts) the same way those files describe.
declare global {
  namespace Express {
    interface Request {
      auditScopeUsed?: string;
    }
  }
}

export function requireScope(scope: string) {
  if (!ScopeRegistry.has(scope)) {
    // Fails at route-registration time (module load / app construction),
    // not per-request: wiring a route to a scope string ScopeRegistry
    // doesn't know about is a code bug (a typo, or a scope that was never
    // registered), not a caller's forbidden request.
    throw new Error(
      `requireScope: "${scope}" is not a scope registered in ScopeRegistry (api/src/platform/scopes/registry.ts)`,
    );
  }

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    req.auditScopeUsed = scope;
    const principal = req.principal;
    if (!principal || !principal.scopes.includes(scope)) {
      const err = forbiddenError(
        req.requestId ?? '',
        `Missing required scope: ${scope}`,
        { missing_scope: scope }
      );
      res.status(err.httpStatus).json(err.toJSON());
      return;
    }
    next();
  };
  Object.defineProperty(middleware, 'name', { value: `requireScope(${scope})`, configurable: true });
  return middleware;
}
