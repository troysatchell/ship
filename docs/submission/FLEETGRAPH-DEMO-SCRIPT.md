# FleetGraph demo script — 4:00 recording

Timecoded walkthrough for a **4-minute** demo video of FleetGraph (Week 5 final submission).

**Every claim below was re-verified against the live graded deployment on 2026-08-09**, not read
off the design docs. Where something is derived rather than observed, it says so.

| | |
|---|---|
| Live site | `https://ship-rr6m.onrender.com` |
| Login (record as this account) | `alice.chen@ship.local` / `admin123` |
| Second login (to generate the event) | `dev@ship.local` / `admin123` |
| Deployed build | `last-modified: Fri, 07 Aug 2026 15:17:33 GMT` — observed today. That is `32e54ba`. Everything merged 2026-08-08/09 (PRs #156–#163) was docs, CI and audit only; **no UI change is missing from the deployed build.** |

**Verified live today (observed, 2026-08-09 ~16:28 UTC):**

- On-demand chat answered in **~9.3 seconds**, citing **12 documents**, ending with the cap line.
- Proactive detection: comment written at `16:27:50Z` → inbox item `createdAt 16:28:11.056Z` =
  **~21 seconds** end to end. The bar is 300 seconds.
- Alice's inbox was then **staged to 5 real mention items** so beat 3 doesn't open on an empty list.

---

## Preflight — do this 15 minutes before you record

1. **Wake both services.** Render spins idle services down. Hit `https://ship-rr6m.onrender.com/health`
   (expect `{"status":"ok"}`), then send one throwaway chat question so the agent process is warm.
   A cold first answer can take 30+ seconds; a warm one took 9.3s today.
2. **Alice's inbox is pre-filled with 5 real mention items** (staged 2026-08-09 ~16:50 UTC, so you
   don't record against an empty list). Confirm it still has them before you roll:
   `GET /api/agent/inbox` as Alice, or just open the rail icon and look for the badge.

   | Item | Document |
   |---|---|
   | Mention | Ship sprint timeline UI for active weeks |
   | Mention | Project Overview |
   | Mention | Fix flaky websocket reconnect test |
   | Mention | Add pagination to issue list API |
   | Mention | Remove last manual DB edit from sprint close-out |

   **If it comes back empty, don't panic — it self-heals.** The item store is in-memory, so an agent
   restart wipes it (that's why it was empty this morning despite being verified full on 2026-08-07).
   But the poller's initial lookback is 24 hours, so the first tick after a restart re-detects those
   same five comments. Wait one minute and re-check. More than ~24h after staging, post fresh
   `@Alice Chen` comments instead — any issue, any author but Alice.
3. **Two browser windows, side by side.** Window A logged in as `alice.chen@ship.local` (the one you
   record). Window B logged in as `dev@ship.local` (used once, to post the comment).
4. **Open the demo issue in Window A:** "Ship sprint timeline UI for active weeks"
   (`343d850f-dc9c-4c83-8f15-7f752cb9813d`). It has a sprint, a project, a program and sibling
   issues, so the expansion is visibly rich.
5. **Have these tabs pre-opened** so you never wait on a page load: the three LangSmith trace links
   (FLEETGRAPH.MD § Execution Traces), and `terraform/render/plan/tro-316-destroy-redeploy-proof.md`.
6. **Sessions idle out after 15 minutes.** Re-login right before you hit record.

---

## The script (4:00)

**The budget:** 529 spoken words ≈ 3:32 at a normal 150 wpm, leaving ~28 seconds of deliberate dead
air — the ~9s the answer takes, and the 20–60s wait for detection (which has its own SAY line to
cover it). If you speak fast, you gain room; if detection takes a full poll interval, you spend it.
Don't add material.

### 0:00–0:20 — What it is (50 words)

> **SAY:** "Ship asks people to write down what happened — standups, weekly plans, retros. Its
> accountability engine can tell you a document is missing. It can't tell you whether it's true, or
> write it for you. FleetGraph is the layer that already knows what happened — so it drafts the
> first version, and it tells you what needs you."

**SHOW:** Ship logged in as Alice, on the issue. The "5 overdue accountability items" banner is
visible — point at it as the *deterministic* engine you're building on top of, not the agent.

### 0:20–1:20 — On-demand: chat that is embedded in context (145 words)

**SHOW:** Click the **FleetGraph pill** at the bottom of the content area. The card expands upward.
Note the context chip naming the open document.

> **SAY:** "The chat lives on every screen, but it is never a standalone chatbot. It's seeded by
> whatever document you have open — you never type 'about issue such-and-such'. On a screen with no
> document open, the input is disabled and says so."

**Type:** `What is this about and what is blocking it?` → Ask.

> **SAY (while the orb spins):** "It doesn't stop at this issue. It walks outward — the week, the
> project, the program, other issues assigned to the same person, a standup from the same week."

**SHOW:** The answer, then scroll the citation list.

> **SAY:** "Twelve documents, and every one says *why* it was pulled in. And read the last line —
> 'reached the 12-document limit'. That's a hard cap, deliberately. It's what stops one question
> from reading the entire organization, and it's the single most important cost control in the
> design."

### 1:20–2:15 — Proactive: the timed detection test, live (130 words)

> **SAY:** "The second mode runs with nobody present. The requirement is five minutes from an event
> landing in Ship to the agent surfacing it. Let's time it."

**SHOW:** Switch to Window A first. Click the **Inbox** icon in the left rail — five real items, each
naming the document it came from and carrying the comment id as its evidence.

> **SAY:** "This is Alice's list — everything waiting on her, ranked, in one place. Watch a new one
> arrive."

**SHOW:** Window B (as Dev User) → the open issue → post a comment: `@Alice Chen can you confirm the
timeline scope before we ship this week?` **Say the time out loud** as you hit post. Switch back to
Window A and leave the Inbox open.

> **SAY (while waiting):** "Ship has no event bus, so this is polling — a sixty-second steady tick
> against a change feed, plus Ship's own five-second lag margin so a slow transaction can't be
> skipped. That's the hybrid trigger model, defended in FLEETGRAPH.md."

**SHOW:** A sixth item lands: *"Mentioned in a comment on 'Ship sprint timeline UI for active
weeks'"*, carrying the id of the comment you just wrote.

> **SAY:** "Twenty-one seconds when I measured it this morning. The bar was three hundred. And it's
> one ranked list of what needs *you* — not a notification stream."

**Do NOT click the item.** See "What not to show" below.

### 2:15–2:55 — One graph, two triggers, and the gate (100 words)

**SHOW:** The three LangSmith trace tabs, side by side.

> **SAY:** "Same graph, both modes — only the trigger differs. These are three real public traces:
> nine spans for a bare chat, forty-seven for the expansion you just watched, fourteen for the
> proactive path — which never calls a model at all. LangSmith reports zero tokens for it. Different
> execution paths, not one pipeline relabeled."

> **SAY:** "And the agent has no write access to Ship. Structurally — it holds no token that could
> write. Every action goes through a gate that takes *your* token, so anything that reaches Ship was
> confirmed by a human first."

### 2:55–3:25 — Deployed, tested, rolled back (70 words)

**SHOW:** `terraform/render/plan/tro-316-destroy-redeploy-proof.md`.

> **SAY:** "The agent service is defined in Terraform, and I proved the config is the source of
> truth by destroying the environment and re-applying from the config alone. Both modes have
> end-to-end tests in CI — including a test that asserts detection latency against that same
> five-minute bar. Tests use stable fakes, never the live model."

### 3:25–4:00 — What it costs, and what isn't done (85 words)

> **SAY:** "Every real model call this sprint is logged to the token: seven invocations, six-tenths
> of a cent, reproducible from a clean clone. At scale, the projection is about four-forty-seven per
> user per month — on-demand answers are sixty-four percent of it, because following the graph
> outward is what makes it useful."

> **SAY:** "Two things I'd fix next. Standup drafts compose and are traced, but nothing schedules
> whose window is open. And the rollback fires on the deployed service going unready, not literally
> on a failed CI run — that's documented as a partial, not a pass."

**SHOW:** FLEETGRAPH.MD § Cost Analysis, then cut.

---

## What each beat proves (keep this straight in your head)

| Beat | Requirement it satisfies |
|---|---|
| Pill + context chip + disabled empty state | Chat embedded in context; no standalone chatbot |
| 12 citations + cap line | On-demand reasoning over real Ship data; the cost cliff constraint |
| Live comment → inbox item | Proactive mode; < 5 min detection latency, verified by timed run |
| Three traces, 9/47/14 spans | Traces show genuinely different execution paths |
| Gate / no agent token | Human-in-the-loop gate |
| Destroy-and-redeploy proof | Terraform is the source of truth |
| Ledger + projections | Cost analysis, measured not estimated |

---

## What NOT to show, and why

- **Never click an inbox item.** Its link is `/issue/<uuid>`; the router only has `issues/:id`, so
  it lands on **"Page not found"** — I loaded it in a real browser today and read the heading. This
  is a known filed defect (TRO-353), and it hits mentions, not just drafts. Show the list, describe
  what the action does, move on. If a grader clicks it, own it: the item and its evidence are real,
  the destination route is wrong.
- **Don't demo a standup draft.** The composition path is built, traced, and has one real invocation
  on the cost ledger — but no scheduler decides whose window is open, so there is nothing to trigger
  it live. Say that plainly if asked; it's in FLEETGRAPH.md.
- **Don't recite FLEETGRAPH.md's Use Case 5 note.** That line still says the blocker fan-out's agent
  side is unbuilt. **It shipped** (TRO-346) and has its own passing test case and trace. The file
  contradicts itself; the fix is filed as TRO-381. If it comes up, the built thing is what's true.
- **Don't claim the rollback is complete.** It's a real, scheduled, tested trigger on sustained
  unreadiness — deliberately *not* counted as meeting "if a CI run fails", because it isn't that.

Saying these out loud is the point, not a weakness — it's the same evidence discipline the whole
project runs on.

---

## Trimming and stretching

- **To 3:00:** drop 2:55–3:25 (Terraform/CI) entirely and cut the cost beat to one sentence. Never
  cut the live detection test — it's the only beat that proves a graded number on camera.
- **To 5:00:** after the traces, open the graph diagram in FLEETGRAPH.md and trace the on-demand
  path node by node; add the human-gate write-boundary test as a second piece of evidence.

## Backup facts for questions

- **Why polling, not webhooks?** Ship has no event bus. The editor saves on a 2-second delay and
  always stamps last-updated, so that timestamp is a complete signal; the history table is only
  partial. Hybrid, with polling as the backbone — argued in FLEETGRAPH.md § Trigger Model.
- **Detection latency, both numbers:** ~21s observed today; 42.6s observed in the timed test of
  2026-08-07; ~60s derived worst case (poll interval + tick processing). Only the first two were
  measured.
- **Dev spend:** $0.006055 across 7 invocations (1,860 input / 839 output tokens), reproducible via
  `pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts -- --ledger cost-ledger-snapshot.jsonl`.
- **Capacity, honestly:** the 10,000-user column is a cost projection, not a capacity claim — the
  per-IP rate limit binds around 2,000 users first.
