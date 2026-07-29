# Findings awaiting a Linear ticket

**Queue is empty.** Everything recorded here has been filed.

## Why this file exists

On 2026-07-29 the Linear workspace hit its free issue limit mid-run —
`"You've exceeded the free issue limit for this workspace"` (HTTP 400 on `save_issue`). That breaks
step 7 of the factory loop: triage is supposed to turn review findings into *new* tickets, which is
how the factory grows its own backlog instead of losing findings in PR threads.

Existing tickets could still be updated; only creation was blocked. So findings were written here
with full provenance rather than dropped, and moved into Linear once the limit was lifted.

**If it happens again:** record the finding here in the same shape — what was observed vs derived,
where, and what "done" means — then file it and empty this file again. A finding that exists only in
a PR comment is a finding that will be lost.

## Filed on 2026-07-29 (workspace upgraded)

All six are **post-baseline** and must never be counted toward the audit report's 68 findings.

| Ticket | Finding | Priority | Source |
|---|---|---|---|
| TRO-276 | **ERR-10** — any authenticated user can kill the API with one malformed WebSocket frame | Urgent | confirmed while fixing ERR-1/ERR-2 (PR #7) |
| TRO-277 | **TEST-12** — pre-existing load-sensitive api flake, invisible to the quarantine | High | isolated while fixing DB-1 (PR #8) |
| TRO-278 | **TF-7** — `trust proxy 1` with ALB open to `0.0.0.0/0` makes `req.ip` spoofable | High | found while fixing API-1 (PR #9) |
| TRO-279 | **DB-12** — migration runner takes no advisory lock; concurrent runs can race | Medium | CodeRabbit on PR #8, deferred there |
| TRO-280 | **API-7** — rate limits are per-process, so the real ceiling is N instances × configured | Medium | found while fixing API-1 (PR #9) |
| TRO-281 | **A11Y-9** — project context sidebar lists have no accessible name | Low | found while fixing A11Y-1 (PR #6) |

Two of these correct or complicate things we already believed, which is the point of writing them
down properly rather than as one-line notes:

- **TRO-276 disproves the hypothesis recorded in TRO-188.** The `yjs_state` loader is not the crash
  path — it is already wrapped in try/catch. `lib0/decoding.js:36` builds its error as a module-scope
  singleton whose stack is captured at import time, so every crash trace pointed at `index.ts:21`
  regardless of where the throw actually happened. The stack was never the throw site.
- **TRO-278 composes with the TRO-172 fix rather than sitting beside it.** The new rate limiter's
  per-IP flood floor is the backstop against forged-cookie key rotation, and a spoofable `req.ip` is
  precisely what defeats that backstop.
