# FleetGraph demo script

Plain-English walkthrough for showing FleetGraph live. Everything below was checked against the
real, live, graded deployment tonight (2026-08-05) — not the design doc, the actual running site.

**Live site:** https://ship-rr6m.onrender.com
**Login:** `dev@ship.local` / `admin123`

---

## The one-sentence pitch

"FleetGraph is an agent that reads through Ship's projects, issues, and weekly plans the same way
a person would, and answers questions or drafts things — always citing exactly what it looked at,
and always leaving the final decision to a human."

---

## Part 1 — the main demo (do this one, it's the strongest, and it's live right now)

**What you're showing:** the agent answering a real question about a real issue, expanding outward
through related documents on its own, and citing every single thing it looked at.

1. Log in at the URL above.
2. Open the issue called **"Initial project setup."**
3. In the right-hand sidebar, click **"Ask FleetGraph"** to expand the chat panel.
4. Type a question — something simple works best, e.g. **"What is this about?"** or **"What's
   blocking this?"**
5. Hit Ask. You'll see the new animated orb (the "thinking" indicator we just shipped tonight) next
   to "Thinking…" while it works.
6. The answer comes back citing **12 different documents** — the issue itself, the sprint it
   belongs to, the project, the program, five other issues assigned to the same person, a weekly
   review, and two more issues from the same week. Every citation says *why* it was pulled in.
7. **Point out the last line of the answer:** "Reached the 12-document limit for this answer — some
   related documents were not explored." That's a deliberate, hard-coded safety cap, not a bug —
   say so. It's what keeps a single question from silently reading the entire company's data (and
   what keeps the cost from growing unbounded).

**What to say while it's running:** "It's not just looking at this one issue — it's walking outward
through everything connected to it: the sprint, the project, related issues, even a review from
the same week. And it's telling you exactly what it looked at, so you're never trusting an answer
you can't check."

---

## Part 2 — the inbox (show it, but be upfront that it's empty for this login)

1. Click the **Inbox** icon in the left rail.
2. It'll say something like "nothing needs you" — that's real, not broken. **Say why:** the one
   real example we have right now (a comment mentioning `@Alice Chen`, asking her to review before
   shipping) is addressed to a different person than the account you're logged in as. The inbox is
   per-person — it only ever shows *you* what's actually waiting on *you*, which is the whole point
   of it (a ranked "what needs you" list instead of a stream of notifications).
3. If you want to show it populated, you'd need to log in as the person a real mention/approval is
   waiting on — not set up for this login. Fine to just describe it: "this is where mentions,
   blocking approvals, and drafts waiting on you all show up in one ranked list, instead of getting
   pinged separately for each one."

---

## Part 3 — the engineering story (open `FLEETGRAPH.MD` in the repo, not the live site)

This is the "how it's built, and how we know it works" part — good for questions, not required if
time is short.

- **The graph diagram** (search the doc for "Graph Diagram"): one diagram, both modes (the
  on-demand chat you just showed, and a separate proactive mode that polls Ship for changes and
  never calls a model at all for the boring lookups). Point out it was built by reading the actual
  code, not drawn from the design doc, and the doc says so explicitly where the two disagree.
- **Real trace links** (search for "Execution Traces"): three actual LangSmith traces, one per
  execution path, showing they genuinely take different routes — 9 steps for the bare chat, 47 for
  the expansion you just watched, 14 for the deterministic no-model path.
- **Real cost, not a guess** (search for "Development and Testing Costs"): every real model call
  this whole sprint has been logged automatically, down to the token. Total spend to date is a
  fraction of a cent — say plainly that's because there's been almost no real traffic yet, not
  because it's magically cheap; the production cost projections further down the doc are the
  honest larger-scale numbers.

---

## What NOT to demo, and why (say this plainly if asked, don't dodge it)

- **Standup drafts have never run for real.** The code is built and tested, but nothing has
  triggered it in production yet (there's no scheduler deciding whose standup window is open —
  that's a known, documented gap, not a hidden one).
- **The "who's blocked by this across teams" use case is half-built.** Ship can now express "issue
  A blocks issue B" (that part shipped), and you can see it in an issue's sidebar — but the agent
  doesn't yet walk that relationship to find the right manager to notify. Also documented, not
  hidden.
- **One seed fixture (Test Case 1) doesn't currently fire** against the graded database, because
  its precondition ("an engineer with 3+ open issues in the *current* sprint") depends on which
  sprint is current *right now*, and that's drifted since the fixture was seeded. Known, written
  down, not something to discover live.

Saying these out loud if it comes up is a feature, not a weakness — it's the same "mark what's
real vs. what's designed" discipline the whole project runs on.
