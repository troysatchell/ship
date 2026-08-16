<!-- PLUGFORGE.MD p.12: every PR names the acceptance criterion it advances and confirms the
     fitness test passed. Keep each section to a few lines; link, don't paste. -->

## Ticket(s)

TRO-___ — one line on what this slice does.

## Acceptance criterion this slice advances

> Quote the exact PLUGFORGE.MD / brief line (ticket ID + "*AC:* ..." text), or the audit finding.

## Fitness test

Which ran and the result — `route-fitness` (v1 routes ↔ OpenAPI) / `parity` (OpenAPI ↔ SDK) /
`drill` (TTFE) / other suite. Name the command and quote its summary line
(e.g. `Tests  N passed (N)`). If none applies, say why.

## Evidence

- `scripts/factory/gate.sh` verdict: `pass` / `fail` (attempt N of 3)
- Before → after: what was observed broken, what is observed now (mark **observed** vs **derived**)
- Red-before-green for any new regression test: quote the failing assertion

## Rollback

Revert this PR (state it if anything else — a migration, a seed, an env var — must move too).
