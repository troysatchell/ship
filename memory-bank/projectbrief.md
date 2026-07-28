# Project Brief — ShipShape Sprint

*Foundation document. Rarely changes. Everything else in the memory bank builds on this.*

## Mission

Audit and measurably improve the Ship codebase across **7 categories**, with baseline → fix → before/after evidence for every claim. This is the GauntletAI "ShipShape" sprint: the deliverable is proof of engineering judgment on an inherited production codebase, not a new feature.

## The 7 categories and their improvement targets

| # | Category | Target (phase 2) |
|---|----------|------------------|
| 1 | Type safety | −25% of violations, with real types (no `any`→`unknown` swaps) |
| 2 | Bundle size | −15% total, or −20% initial-load via code splitting |
| 3 | API response time | −20% P95 on ≥2 endpoints, identical conditions |
| 4 | DB query efficiency | −20% query count on a flow, or −50% on slowest query |
| 5 | Test coverage/quality | 3 meaningful tests on untested paths, or 3 flakes root-caused |
| 6 | Error/edge handling | 3 fixes, ≥1 real data-loss/confusion scenario |
| 7 | Accessibility | +10 Lighthouse on worst page, or all Critical/Serious fixed on top 3 pages |

## Deadlines (absolute)

- **Tue Jul 28, 2026 11:59 PM — audit report (HARD GATE).** All 7 baselines, methodology, findings ranked by severity. No fixes during audit.
- **Fri Jul 31, 2026 11:59 PM — implementation.** Measurable improvements with before/after evidence.
- **Sun Aug 2, 2026 11:59 AM — final submission.** Polish, documentation, presentation.

## Non-negotiable rules

1. Diagnosis before treatment — nothing is fixed during the audit phase.
2. Every number comes from a reproducible command; methodology is part of the deliverable.
3. Before/after comparisons run under identical conditions (seed volume, concurrency, hardware).
4. Fixes must preserve behavior — full test suite green after every fix.
5. Seed to realistic volume before perf measurement: 500+ documents, 100+ issues, 20+ users, 10+ sprints.

## Tooling

The audit is executed with the ShipShape skill set (`~/.claude/skills/`): `shipshape-audit` orchestrator + 7 category skills, each with `baseline` and `compare <label>` modes. Repo-specific facts live in `audit/shipshape.config.yaml`. Artifacts land in `audit/<category>/`.
