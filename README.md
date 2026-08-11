<p align="center">
  <a href="https://github.com/US-Department-of-the-Treasury/ship">
    <img src="web/public/icons/blue/android-chrome-512x512.png" alt="Ship logo" width="120">
  </a>
</p>

<h1 align="center">Ship</h1>

<p align="center">
  <strong>Project management that helps teams learn and improve</strong>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/US-Department-of-the-Treasury/ship/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
  <img src="https://img.shields.io/badge/Section_508-Compliant-blue.svg" alt="Section 508 Compliant">
  <img src="https://img.shields.io/badge/WCAG_2.1-AA-blue.svg" alt="WCAG 2.1 AA">
</p>

---

## ShipShape Audit — about this fork

> This is a fork of [US-Department-of-the-Treasury/ship](https://github.com/US-Department-of-the-Treasury/ship), audited for the GauntletAI **ShipShape** sprint. The upstream product documentation continues below and is unchanged.

| Deliverable | Location |
|---|---|
| **Audit report** — 68 findings across 8 categories, with methodology, raw data and severity ranking | [`audit/AUDIT_REPORT.md`](audit/AUDIT_REPORT.md) |
| **Codebase orientation** — architecture write-up, traced request flow, 10× assessment | [`audit/ORIENTATION.md`](audit/ORIENTATION.md) |
| **Per-category baselines** — machine-readable, used for before/after comparison | `audit/<category>/baseline.json` + `baseline.md` |

**Baseline:** commit `076a183`, measured 2026-07-27 against 500 documents / 20 users on PostgreSQL 15-alpine.
**Findings:** 4 Critical · 22 High · 29 Medium · 13 Low, across type safety, bundle size, API response time, database queries, test quality, error handling, accessibility, and Terraform/IaC.

No application or infrastructure source (`api/`, `web/`, `shared/`, `terraform/`) was modified during the audit phase — measurements reflect the commit above.

### Cold start (one command)

```bash
git clone https://github.com/US-Department-of-the-Treasury/ship.git
cd ship
./start.sh
```

That is the whole thing, from a genuinely clean checkout: it installs dependencies if needed, creates
the database, runs every migration (and independently verifies the count — see DB-1 below, not just
trusts the exit code), seeds sample data, finds free ports, starts both servers, and prints the URLs
to open. Re-running `./start.sh` is safe — every step is idempotent, so it heals a partially-set-up
checkout instead of assuming yesterday's state is still correct. `Ctrl-C` stops both servers.

`./start.sh` is a thin preflight (Node/pnpm present) wrapping `scripts/dev.sh`, which does the actual
work and is also what `pnpm dev` runs — there is exactly one implementation of "set up and start Ship,"
not two that can drift apart.

**Postgres.** By default this assumes a native PostgreSQL on `localhost` (no password) — the common
Homebrew/apt setup. No native Postgres installed? Bring up one of the two bundled Docker options first,
then point `start.sh` at it with `DATABASE_URL`:

```bash
# Option A — root docker-compose.yml (Postgres only, port 5432)
docker compose up -d
DATABASE_URL=postgresql://ship:ship_dev_password@localhost:5432/ship_dev ./start.sh

# Option B — docker-compose.local.yml (Postgres only, port 5433 — coexists with a native install)
docker compose -f docker-compose.local.yml up -d postgres
DATABASE_URL=postgresql://ship:ship_dev_password@localhost:5433/ship_dev ./start.sh
```

If Postgres isn't reachable at all, `./start.sh` fails immediately and says exactly what to start —
it does not proceed to start servers against a database it never confirmed existed.

### Things a new engineer hits, all audit findings

- **`pnpm db:migrate` used to stop after migration 010 and still exit `0`.** Fixed (DB-1 / TRO-178): the
  runner now throws — and `./start.sh`/`pnpm dev` independently re-verify every migration file on disk
  is recorded in `schema_migrations`, printing `Migrations: 42/42 applied`. Confirmed in this tree by
  running `runMigrations()` against the real 42-file migration set in
  `api/src/db/__tests__/migrationRunner.test.ts` and `verifyMigrations.test.ts`.
- **`pnpm test` TRUNCATEs whatever `DATABASE_URL` points at** (`api/src/test/setup.ts`, every api test
  file's `beforeAll`) — including the database `./start.sh`/`pnpm dev` just set up. Never run `pnpm test`
  against your dev database; give it an isolated one (`.factory-env` does this for factory worktrees).
  *(TEST-9, still open.)*
- **Root `pnpm test` runs both packages** (`test:api` then `test:web`) — this used to silently skip
  `web/` entirely; that is fixed (TEST-1 / TRO-223, PR #11). Use `pnpm test:web` to run the web suite
  alone.
- **`./start.sh`/`pnpm dev` pick their own ports** and write them to a repo-root `.ports` file — don't
  assume 3000/5173; read the printed URLs or `.ports`.

---

## What is Ship?

Ship is a project management tool that combines documentation, issue tracking, and plan-driven weekly workflows in one place. Instead of switching between a wiki, a task tracker, and a spreadsheet, everything lives together.

**Built by the U.S. Department of the Treasury** for government teams, but useful for any organization that wants to work more effectively.

---

## How to Use Ship

Ship has four main views, each designed for different questions:

| View | What it answers |
|------|-----------------|
| **Docs** | "Where's that document?" — Wiki-style pages for team knowledge |
| **Issues** | "What needs to be done?" — Track tasks, bugs, and features |
| **Projects** | "What are we building?" — Group issues into deliverables |
| **Teams** | "Who's doing what?" — See workload across people and weeks |

### The Basics

1. **Create documents** for anything your team needs to remember — meeting notes, specs, onboarding guides
2. **Create issues** for work that needs to get done — assign them to people and track progress
3. **Group issues into projects** to organize related work
4. **Write weekly plans** to declare what you intend to accomplish each week

Everyone on the team can edit documents at the same time. You'll see other people's cursors as they type.

---

## The Ship Philosophy

### Everything is a Document

In Ship, there's no difference between a "wiki page" and an "issue" at the data level. They're all documents with different properties. This means:

- You can link any document to any other document
- Issues can have rich content, not just a title and description
- Projects and weeks are documents too — they can contain notes, decisions, and context

### Plans Are the Unit of Intent

Ship is plan-driven: each week starts with a written plan declaring what you intend to accomplish and ends with a retro capturing what you learned. Issues are a trailing indicator of what was done, not a leading indicator of what to do.

1. **Plan (Weekly Plan)** — Before the week, write down what you intend to accomplish and why
2. **Execute (The Week)** — Do the work; issues track what was actually done
3. **Reflect (Weekly Retro)** — After the week, write down what actually happened and what you learned

This isn't paperwork for paperwork's sake. Teams that skip retrospectives repeat the same mistakes. Teams that write things down learn and improve.

### Learning, Not Compliance

Documentation requirements in Ship are visible but not blocking. You can start a new week without finishing the last retro. But the system makes missing documentation obvious — it shows up as a visual indicator that escalates from yellow to red over time.

The goal isn't to check boxes. It's to capture what your team learned so you can get better.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- [Docker](https://www.docker.com/) (for the database)

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/US-Department-of-the-Treasury/ship.git
cd ship

# 2. One command: installs deps, creates + migrates + seeds the database,
#    starts both servers. See "Cold start" above for Docker Postgres options.
./start.sh
```

Prefer to run the steps yourself? `./start.sh` (and `pnpm dev`) do the equivalent of:

```bash
pnpm install
pnpm build:shared
DATABASE_URL=... pnpm --filter @ship/api db:migrate   # applies schema.sql + every migration
DATABASE_URL=... pnpm --filter @ship/api db:seed      # idempotent — safe to re-run
pnpm dev
```

### Open the App

Once it's running, open your browser to:

**http://localhost:5173**

Log in with the demo account:
- **Email:** `dev@ship.local`
- **Password:** `admin123`

### What's Running

| Service | URL | Description |
|---------|-----|-------------|
| Web app | http://localhost:5173 | The Ship interface |
| API server | http://localhost:3000 | Backend services |
| Swagger UI | http://localhost:3000/api/docs | Interactive API documentation |
| OpenAPI spec | http://localhost:3000/api/openapi.json | OpenAPI 3.0 specification |
| PostgreSQL | localhost:5432 | Database (via Docker) |

### Common Commands

```bash
pnpm dev          # Start everything
pnpm dev:web      # Start just the web app
pnpm dev:api      # Start just the API
pnpm db:seed      # Reset database with sample data
pnpm db:migrate   # Run database migrations
pnpm test         # Run tests
```

---

## Technical Details

### Architecture

Ship is a monorepo with three packages:

- **web/** — React frontend with TipTap editor for real-time collaboration
- **api/** — Express backend with WebSocket support
- **shared/** — TypeScript types used by both

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React, Vite, TailwindCSS |
| Editor | TipTap + Yjs (real-time collaboration) |
| Backend | Express, Node.js |
| Database | PostgreSQL |
| Real-time | WebSocket |

### Design Decisions

- **Everything is a document** — Single `documents` table with a `document_type` field
- **Server is truth** — Offline-tolerant, syncs when reconnected
- **Boring technology** — Well-understood tools over cutting-edge experiments
- **E2E testing** — 73+ Playwright tests covering real user flows

See [docs/application-architecture.md](docs/application-architecture.md) for more.

### Repository Structure

```
ship/
├── api/                    # Express backend
│   ├── src/
│   │   ├── routes/         # REST endpoints
│   │   ├── collaboration/  # WebSocket + Yjs sync
│   │   └── db/             # Database queries
│   └── package.json
│
├── web/                    # React frontend
│   ├── src/
│   │   ├── components/     # UI components
│   │   ├── pages/          # Route pages
│   │   └── hooks/          # Custom hooks
│   └── package.json
│
├── shared/                 # Shared TypeScript types
├── e2e/                    # Playwright E2E tests
└── docs/                   # Architecture documentation
```

---

## Testing

```bash
# Run all E2E tests
pnpm test

# Run tests with UI
pnpm test:ui

# Run specific test file
pnpm test e2e/documents.spec.ts
```

Ship uses Playwright for end-to-end testing with 73+ tests covering all major functionality.

---

## Deployment

| Environment | Approach |
|-------------|---------------------|
| **Development** | `./start.sh` / `pnpm dev` — see "Cold start" above |
| **Shadow (UAT)** | Deploy from `feat/unified-document-model-v2` before merging to master |
| **Production** | AWS — Elastic Beanstalk (backend) + S3/CloudFront (frontend), provisioned via Terraform |

### Deploy scripts

```bash
./scripts/deploy.sh prod           # Backend → Elastic Beanstalk
./scripts/deploy-frontend.sh prod  # Frontend → S3/CloudFront
```

Run both — they're paired; deploying only one leaves the API and frontend out of sync.

### Post-deploy verification

`curl` can't catch JS errors, so verify with a browser. Health checks:

- **Prod API:** `https://ship.awsdev.treasury.gov/health` — goes through CloudFront, not a direct
  ALB hit. `terraform/security-groups.tf` restricts the ALB security group to CloudFront's
  origin-facing prefix list, so a direct connection to the ALB's own DNS name
  (`ship-api-prod.eba-xsaqsg9h.us-east-1.elasticbeanstalk.com`) will time out once that's live —
  the name still resolves, but traffic from outside CloudFront's IP ranges is silently dropped.
- **Prod Web:** `https://ship.awsdev.treasury.gov`

### Grader Access — Public API (OAuth)

Ship's Week 6 platform work (PLUGFORGE.MD) adds a versioned public API (`/api/v1`) authenticated via
OAuth 2.0. Per the same repo convention as the web app's grader login
(`alice.chen@ship.local` / `admin123` — see `FLEETGRAPH.MD`'s "Grader Access" section for that
account), the public API gets its own seeded, read-only grader credential — a first-party OAuth app
scoped to `documents:read`, `issues:read`, `sprints:read` only, so a grader account can read every
graded resource and mutate nothing.

**One-command setup**, from a clean checkout, alongside the normal `./start.sh` / `pnpm dev` flow:

```bash
GRADER_OAUTH_CLIENT_SECRET=<choose-a-secret-value> ./start.sh
# or, against an already-running dev environment:
GRADER_OAUTH_CLIENT_SECRET=<choose-a-secret-value> pnpm --filter @ship/api db:seed
```

`db:seed` is idempotent (safe to re-run, including with the variable unset — see below) and prints
the app's `client_id` on success:

```
✅ Created grader OAuth app (client_id: ship_app_...)
```

or, on a re-run against an already-seeded database:

```
ℹ️  Grader OAuth app already exists (client_id: ship_app_...)
```

- **`GRADER_OAUTH_CLIENT_SECRET`** is the raw client secret for the app — chosen by whoever runs the
  seed, never generated or printed by it, and never committed anywhere in this repo. Ship stores
  only its SHA-256 hash (`oauth_apps.client_secret_hash`, the same at-rest pattern as every other
  OAuth app and personal API token). Keep the value you chose; it is not recoverable from the
  database or re-printed on a later seed run.
- **Not set?** `db:seed` skips the grader app step entirely (no error, no row created) — this is the
  normal, unaffected path for every ordinary local `pnpm db:seed` / `./start.sh` run. The variable
  only needs to be set in an environment meant to actually host the grader's credential (a deployed
  grading instance's boot environment, provisioned via Terraform — PF-900).
- **Obtaining a working bearer token** for the grader's `client_id` + secret via the OAuth 2.0 Client
  Credentials grant will use `POST /oauth/token`, once PF-104 (`/oauth/token`) lands on this branch —
  it has not yet as of this section being written (2026-08-10/11); today, the seed proves the
  credential exists and is read-only-scoped (`api/src/platform/oauth/__tests__/seedGraderApp.test.ts`),
  but no token-issuing endpoint exists yet to exercise end-to-end. Do not read this section as
  claiming a live token round-trip works today — it does not.
- **Portal reachability** and **`/api/v1/openapi.json` being publicly resolvable** are DoD items for
  a deployed instance and depend on E5 (developer portal) and PF-202 (OpenAPI generator), neither of
  which exists on this branch yet — deliberately out of scope for the grader-app seed itself. See
  `PLUGFORGE.MD` §4 (PF-907) and §6 (MVP cut line) for the full epic breakdown.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `SESSION_SECRET` | Cookie signing secret | Required |
| `PORT` | API server port | `3000` |
| `GRADER_OAUTH_CLIENT_SECRET` | Raw secret for the seeded read-only grader OAuth app (see "Grader Access — Public API" above) | Unset — seed step no-ops without it |

---

## Security

- **No external telemetry** — No Sentry, PostHog, or third-party analytics
- **No external CDN** — All assets served from your infrastructure
- **Session timeout** — 15-minute idle timeout (government standard)
- **Audit logging** — Track all document operations

> **Reporting Vulnerabilities:** See [SECURITY.md](./SECURITY.md) for our vulnerability disclosure policy.

---

## Accessibility

Ship is Section 508 compliant and meets WCAG 2.1 AA standards:

- All color contrasts meet 4.5:1 minimum
- Full keyboard navigation
- Screen reader support
- Visible focus indicators

---

## Contributing

We welcome contributions. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

## Documentation

- [Application Architecture](./docs/application-architecture.md) — Tech stack and design decisions
- [Unified Document Model](./docs/unified-document-model.md) — Data model and sync architecture
- [Document Model Conventions](./docs/document-model-conventions.md) — Terminology and patterns
- [Week Documentation Philosophy](./docs/week-documentation-philosophy.md) — Why weekly plans and retros work the way they do
- [Accountability Philosophy](./docs/accountability-philosophy.md) — How Ship enforces accountability
- [Accountability Manager Guide](./docs/accountability-manager-guide.md) — Using approval workflows
- [Contributing Guidelines](./CONTRIBUTING.md) — How to contribute
- [Security Policy](./SECURITY.md) — Vulnerability reporting

---

## License

[MIT License](./LICENSE)
