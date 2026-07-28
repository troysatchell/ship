# Product Context — What Ship Is

*Why the product exists and who it serves. Stable; update only when understanding deepens.*

Ship is a project-management tool built by the U.S. Department of the Treasury: documentation, issue tracking, and sprint planning in one app — a Notion/Linear hybrid. Everything (wiki docs, issues, programs, projects, sprints/weeks, people, standups, weekly plans/retros/reviews) is a **document** in a single unified table; the type lives in a `document_type` field and type-specific data in JSONB `properties`.

**Users:** internal teams organized into programs (seeded: SHIP, AUTH, API, UI, INFRA), each with projects, weekly sprints, and an accountability workflow (weekly plans, standups, retros, manager reviews).

**Product claims relevant to the audit:**
- Real-time collaborative editing (TipTap + Yjs CRDTs over WebSocket) — data-loss behavior under disconnect/concurrency is a prime error-handling target.
- Section 508 / WCAG 2.1 AA compliance — a testable claim, not a fact; the a11y audit verifies it.
- Government deployment context (AWS Elastic Beanstalk + S3/CloudFront, Terraform) — security and compliance posture matters.

**Why this matters to the audit:** the unified document model concentrates all load on one table and one editor pipeline, so single findings (a missing index, an unbatched association fetch, an editor a11y gap) tend to affect every document type at once. High-leverage fixes live there.

Deeper reading (on demand, don't preload): `docs/unified-document-model.md`, `docs/application-architecture.md`, `docs/document-model-conventions.md`.
