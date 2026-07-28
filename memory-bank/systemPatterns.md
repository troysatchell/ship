# System Patterns — Architecture Facts for Auditing

*How the system is built, filtered to what the audit needs. `.claude/CLAUDE.md` and `docs/` are the full picture; this file records what we verified ourselves and where our findings disagree with the docs.*

## Verified architecture (orientation, 2026-07-27)

- **Monorepo:** pnpm workspaces — `web/` (React 18 + Vite 6 + TipTap), `api/` (Express 4), `shared/` (types). Node ≥20.
- **DB layer:** raw `pg` Pool (`api/src/db/client.ts`, max 20/10 conns, 30s statement timeout) — inline parameterized SQL in route files, no ORM. Schema: `api/src/db/schema.sql` + **42 migration files** (verified via DB-1; `schema_migrations` tracks applied).
- **Unified `documents` table:** `document_type` enum (10 types), `content` JSONB (TipTap), `yjs_state` BYTEA, `properties` JSONB (GIN-indexed), `parent_id` self-FK with circular-parent trigger, soft delete via `archived_at`/`deleted_at`.
- **Associations:** `document_associations` junction (parent / project / sprint / program). **Docs discrepancy:** `.claude/CLAUDE.md` says legacy `program_id`/`project_id` columns still exist, but migrations 027/029 removed them — trust the migrations, verify live with `\d documents` before citing.
- **Routing:** ~33 route modules mounted in `api/src/app.ts:173-237` under `/api/*`; helmet + session cookies + csrf-sync + express-rate-limit (`loginLimiter` on login). Swagger at `/api/docs/`.
- **Realtime:** WebSocket collab at `/collaboration/{docType}:{docId}` (`api/src/collaboration/`), Yjs state persisted to Postgres. **Verified 2026-07-27:** session is validated only at the WS *upgrade* (`collaboration/index.ts:659`), never per-message — so a revoked/expired session keeps writing on an open socket (ERR-2). Doc load (`getOrCreateDoc`) reads `yjs_state`, falling back to converting `content` JSON; an undecodable `yjs_state` produced an *uncaught* lib0 crash in the probe log (ERR-1 boot-crash note — needs a clean repro).

## Index reality (db-query audit foundation)

Present on `documents`: workspace_id, parent_id, document_type, GIN(properties), visibility combos, partial archived/deleted, `(workspace_id, document_type)` active partial, conversion partials, person user_id expression index.
**Absent:** `ticket_number`, `created_by`, `updated_at`.

## Audit-relevant pattern observations

- Web `tsconfig.json` does **not** extend the root config — missing `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch` that api/shared inherit. (Type-safety lead TS-candidate #1.)
- Web has 24 explicit `any` but **433 `as` assertions** — the type-safety story here is assertions, not `any`.
- Code splitting exists only for 13 document-tab components (`web/src/lib/document-tabs.tsx`); no route-level lazy loading, no `manualChunks`, no analyzer installed.
- API vitest declares v8 coverage but `@vitest/coverage-v8` is not installed — coverage tooling is broken as shipped. Root `pnpm test` runs api only; web's 16 unit test files are never run by it.
- E2E: 71 spec files / ~866 tests, per-worker Postgres testcontainers + `vite preview` (dev server documented to blow up memory). Retries 2 CI / 1 local — flakiness measurement must track first-attempt results.
- A11y: `e2e/accessibility*.spec.ts` run AxeBuilder scans with WCAG-numbered phases; USWDS + Radix primitives supply baseline semantics. **Refined 2026-07-27:** those specs assert only `impact === 'critical'`, so Serious/Moderate/Minor pass by construction. The independent axe superset (pages + interactive states) found 2 Critical + 3 Serious the specs and Lighthouse (95–100) both miss — see `audit/a11y/baseline.md` (A11Y-1 sidebar `role="tree"`, A11Y-2 editor `aria-expanded`, A11Y-3 /my-week contrast). A seeded user with an overdue action item gets an "Action Items" `role=dialog` that auto-opens on every nav and traps focus (Escape closes it) — dismiss it before scanning.

## House rules that constrain fixes (from repo CLAUDE.md — follow them)

Everything is a document (no new content tables) · reuse the shared `Editor` · migrations only, never edit schema.sql for existing tables · all API routes registered with OpenAPI (`/ship-openapi-endpoints`) · philosophy review via `/ship-philosophy-reviewer` · never `git commit --no-verify` · e2e via `/e2e-test-runner`, never raw `pnpm test:e2e`.
