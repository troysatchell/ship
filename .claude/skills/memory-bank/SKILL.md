---
name: memory-bank
description: Update the sprint memory bank (memory-bank/) after significant work or a focus shift — rewrite activeContext.md, append a dated entry to progress.md, and sync stable files if new facts were verified. Use when the user says "update the memory bank", at the end of a work session, or after completing a milestone.
argument-hint: [optional: one-line summary of what changed]
---

# Memory Bank Update

Refresh the sprint's working memory in `memory-bank/` so the next session starts oriented. This is a write ritual — do it from what actually happened this session, not from imagination.

## Files and their update rules

| File | Rule |
|---|---|
| `activeContext.md` | **Rewrite.** Current focus (max 3 items), active decisions, open questions, watch-outs. Keep under one screen; anything finished moves to progress.md. Stamp the date. |
| `progress.md` | **Append.** Update the status board rows that changed, then add a dated log entry at the top of the Log section: what was done, what was decided, what's next. Never rewrite history. |
| `systemPatterns.md` | Update only if a new architecture fact was *verified* this session (or a documented fact was disproven — record the discrepancy, don't silently overwrite). |
| `techContext.md` | Update only if the environment, commands, or tooling changed. |
| `productContext.md`, `projectbrief.md` | Almost never. Brief changes only if sprint scope/deadlines formally changed. |

## Process

1. Read `activeContext.md` and `progress.md` as they stand.
2. Diff against reality: this session's completed work, new findings (with finding IDs if from an audit), decisions made, anything now stale.
3. Apply the rules above. Absolute dates only (e.g., 2026-07-28), never "today" or "yesterday".
4. If audit artifacts were produced this session, reference them by path and finding ID (e.g., `audit/db-query/baseline.md`, DB-2) rather than duplicating their numbers into the bank.
5. End by printing a 3-line summary of what changed in the bank.

## Don'ts

- Don't copy metric tables into the bank — artifacts in `audit/` are the source of truth; the bank stores pointers and conclusions.
- Don't let activeContext.md grow — it's a viewport, not a journal. progress.md is the journal.
- Don't record speculation as fact; unverified hunches go under "Open questions".
