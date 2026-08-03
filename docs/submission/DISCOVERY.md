> **DRAFT** — for Troy to personalize before submission. Every technical claim below is sourced
> from this repo; the framing/voice is a starting point, not final copy.

# Discovery Write-Up: 3 Things I Didn't Know Before This Audit

## 1. `pg`'s `query()` generic defaults to `any`, not `unknown` — so "unannotated" silently means "unchecked," not "safe by default"

**Where I found it:** `@types/pg`'s `index.d.ts` (installed via `pg: "^8.13.1"`, `api/package.json:46`)
declares `query<R extends QueryResultRow = any, I = any[]>(...)`. The consequence lives in this repo
at `api/src/routes/*.ts` — **707** `pool/client/db.query(` call sites, **zero** of which supplied
the generic, making **767** `.rows` property accesses implicitly `any` (documented in
`audit/type-safety/baseline.md:123-131`, finding TS-2 / `TRO-207`). The fix — `api/src/routes/rowTypes.ts`
(77 lines) — hand-writes row interfaces per query, verified against `schema.sql:106-162`.

**What it does and why it matters:** I assumed `strict: true` plus `noImplicitAny` meant a raw driver
call would at least come back `unknown`, forcing me to narrow before touching a field. It doesn't —
the library's own type declares the default as `any`, which is an explicit escape hatch, not an
absence of information TypeScript could infer around. A renamed column or a JSONB key typo
(`properties->>'x'`) produces `undefined` in a live API response with zero compile-time signal
anywhere in the chain — `strict` mode is powerless against a type that was deliberately declared
`any` upstream.

**How I'd apply it next time:** on any project touching `node-postgres` (or any driver whose types
default a generic to `any`), I'd type the row shape at the query site from day one — either the
generic directly or a thin wrapper (`typedQuery<T>(pool, sql, params)`) that makes the untyped path
impossible to reach by accident. I'd also add a lint rule or a small AST script (like `count.sh` in
this repo) that flags any `.query(` call missing its generic, so the gap can't grow silently between
audits.

## 2. Express's `trust proxy` is a hop *count*, not a "trust this header" toggle — and getting the count wrong silently gives you the load balancer's IP for every request

**Where I found it:** `api/src/app.ts:134-175` (`resolveTrustProxyHops`, with the mechanism spelled
out in the comment block above it, applied at `app.ts:184`). This was TF-7 / `TRO-278`, found while
fixing the rate limiter (API-1).

**What it does and why it matters:** `trust proxy` doesn't mean "believe `X-Forwarded-For`" — it
tells Express (via `proxy-addr`) how many hops of `X-Forwarded-For` to peel off from the *end* of the
list, because each honest proxy appends exactly one entry as it forwards a request. With `N` trusted
hops, `req.ip` resolves to the `(N+1)`-th entry from the end. This repo's real AWS topology is
`client → CloudFront → ALB → app` — two hops — but it was configured with `trust proxy 1`, so
`req.ip` was resolving to CloudFront's own edge IP for *every single request*, not the client's. Any
code keying off `req.ip` (the rate limiter, audit logging) was treating every user as the same
"client." The fix makes the hop count environment-configurable and pairs it with a security-group
rule (`terraform/security-groups.tf`) that locks the ALB to only accept traffic from CloudFront's
prefix list — because trusting a hop count is only safe if you can also guarantee what's actually
sitting at that hop.

**How I'd apply it next time:** never copy a `trust proxy` value from a tutorial or a different
deployment's config. I'd draw the actual network path (client → every proxy/CDN/LB hop → app),
count it explicitly, and write a regression test that sends a forged `X-Forwarded-For` header and
asserts what `req.ip` resolves to — because this class of bug produces no error, no crash, and no
failing request; it just quietly computes the wrong "who is this."

## 3. `CREATE TABLE IF NOT EXISTS` is check-then-create, not atomic — so "idempotent" schema DDL can still lose a race

**Where I found it:** `api/src/db/migrationRunner.ts:44-66` (the reasoning, plus the advisory-lock
key) and `:307-352` (`runMigrations`, where the lock is acquired before anything else touches the
database and released in a `finally` on every exit path). This is DB-12 / `TRO-279`; the measured
evidence is in `CHANGES.md:2517-2560`.

**What it does and why it matters:** I'd always treated `IF NOT EXISTS` as "safe to run concurrently"
because it's idempotent — running it twice gives the same end state. That's true sequentially, but
Postgres still executes it as check-then-create: two processes can both pass the existence check
before either creates, and one loses on the catalog's own unique index. This repo's `Dockerfile` runs
migrations on every container boot, so a rolling deploy or a crash-restart overlapping a fresh boot
makes concurrent migration runs the normal case, not a hypothetical — and it was measured: **5 of 6**
simultaneous `schema.sql` applies failed, racing **434 times** on `pg_type_typname_nsp_index`. Worse,
because `schema.sql` runs as one implicit transaction, a duplicate-object error at statement *k* rolls
back statements `1..k-1` — under a retry policy tolerant enough to swallow that error class, a losing
run could apply *nothing* and still exit 0, which is exactly DB-1's silent-under-application failure
mode, reachable through a completely different door.

**How I'd apply it next time:** for any migration tool touching shared schema state, I'd wrap the
whole run in a Postgres session-level advisory lock (`pg_advisory_lock`/`pg_advisory_unlock` on a
fixed key) acquired before the very first query — not assume idempotent DDL implies safe-under-race.
And I'd verify that assumption once, directly: spin up N processes against a throwaway database and
watch what actually happens, rather than reasoning from the SQL text alone.

