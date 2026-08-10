# X thread — FleetGraph (Week 5)

> **DRAFT for Troy.** Agent-only. Every number is sourced in the table at the bottom. Ship is a fork
> of the U.S. Treasury's already-public open-source project
> (`github.com/US-Department-of-the-Treasury/ship`). No internal hostnames, account IDs, or
> credentials appear in this thread.
>
> Assets live in `docs/submission/social-assets/w4-w5/`. The image for each tweet is named inline.

## The thread (12 tweets, all under 280 chars)

**1/12** — 119 chars · 🖼 `01-hero.png`

> I took a legacy repo from the US Treasury and in 2 weeks
> overhauled performance and built an agent on top
> 🧵 @gauntletai

**2/12** — 214 chars · 🖼 `02-thesis.png`

> the agent is the second week. here's the idea
>
> Ship makes people write down what happened — standups, plans, retros
>
> FleetGraph already knows what happened
>
> so it writes the first draft and tells you what needs you

**3/12** — 262 chars · 🖼 `02-thesis.png` (or no image)

> the obvious build was a compliance bot. flag the thin standup. chase the missing retro
>
> I killed it
>
> pointing an AI at a federal employee's performance doc to tell them their writing looks thin is surveillance, not help
>
> people write "stuff" because it's tedious

**4/12** — 209 chars · 🖼 `03-embedded.png`

> so the rule became: remove the tedium, don't grade the person
>
> the chat lives on every screen but it is never a chatbot page
>
> it's seeded by whatever doc you already have open. you never type "about issue #42"

**5/12** — 227 chars · 🖼 `04-citations.png`

> ask it something and it walks outward from that doc — the sprint, the project, sibling issues, a standup from the same week
>
> then it names all 12 documents it read, and why each one
>
> hard cap at 12. it tells you when it hits it

**6/12** — 219 chars · 🖼 `05-two-modes.png`

> two modes, one graph
>
> on-demand: you ask
> proactive: nobody's there and it runs anyway
>
> same compiled graph, same nodes. a router reads the trigger and picks the path
>
> that's the difference between a graph and a pipeline

**7/12** — 239 chars · 🖼 `06-trigger.png`

> Ship has no event bus, so "event" has to mean observed change
>
> hybrid, polling as the backbone. the editor saves on a 2s delay and always stamps last-updated — that timestamp is a complete signal. the history table isn't
>
> 3 tiers, 60s tick

**8/12** — 209 chars · 🖼 `07-detection.png`

> requirement: surface an event in under 5 minutes
>
> comment written at 16:27:50Z
> in her ranked inbox at 16:28:11Z
>
> 21 seconds, carrying the id of that exact comment
>
> measured on the deployed service, not derived

**9/12** — 221 chars · 🖼 `08-inbox.png`

> and what lands is one ranked list of what needs you. not a notification stream
>
> mentions, approvals you're blocking, drafts waiting on you — with the reason
>
> the hardest parts need no model. mention resolution is a lookup

**10/12** — 231 chars · 🖼 `09-traces.png`

> three real traces, three real shapes
>
> 9 spans for a bare chat
> 47 for the expansion above
> 14 for the proactive path — which spends $0 and burns zero tokens, because it never calls a model
>
> read back from the trace API, not eyeballed

**11/12** — 243 chars · 🖼 `10-gate.png`

> the part I'd defend hardest:
>
> the agent cannot write to Ship. not "configured not to" — it holds no credential that could
>
> every write goes through one gate carrying the acting human's own token
>
> a draft stays a draft until a person accepts it

**12/12** — 242 chars · 🖼 `12-cost.png`

> total real model spend for the whole build: $0.006055 across 7 invocations, logged to the token
>
> at scale it projects to ~$4.47/user/month, and on-demand is 64% of it
>
> deployed with terraform, destroyed and re-applied to prove it
>
> @gauntletai

---

## Assets

| # | File | Size | Real screenshot? |
|---|---|---|---|
| 1 | `01-hero.png` | 2400×1350 | designed |
| 2, 3 | `02-thesis.png` | 2400×1350 | designed |
| 4 | `03-embedded.png` | 2400×1782 | **yes** — chat in the 4-panel app |
| 5 | `04-citations.png` | 2400×2038 | **yes** — all 12 sources + cap line |
| 6 | `05-two-modes.png` | 2400×1352 | designed |
| 7 | `06-trigger.png` | 2400×1352 | designed |
| 8 | `07-detection.png` | 2400×1352 | designed |
| 9 | `08-inbox.png` | 2400×2198 | **yes** — the 5-item ranked inbox |
| 10 | `09-traces.png` | 2400×1352 | designed |
| 11 | `10-gate.png` | 2400×1352 | designed |
| 12 | `12-cost.png` | 2400×1352 | designed |

Two cards are built but unassigned — use them if a tweet gets replaced, or as reply-thread depth:
`11-resilience.png` (timeouts, backoff on idempotent reads only, circuit breaker, degradation) and
the spare half of `05-two-modes.png`.

## Sources

| Tweet | Claim | Source |
|---|---|---|
| 2, 3 | The responsibility decision, and the rejected compliance framing | `FLEETGRAPH.MD` § Agent Responsibility |
| 4 | Chat embedded in context, seeded by the open document | `web/src/components/agent/AgentPill.tsx`; `AgentChatPanel.tsx` |
| 5 | 12 cited sources with reasons, hard cap | verified live 2026-08-09 — the screenshot is that run |
| 6 | One graph, trigger-routed | `agent/src/graph.ts` — one `buildGraph()`, seven trigger kinds |
| 7 | Hybrid, 3 tiers, 60s steady tick | `FLEETGRAPH.MD` § Trigger Model; `agent/src/config.ts` |
| 8 | 21s: 16:27:50Z → 16:28:11Z, bar 300s | measured live on the deployed service, 2026-08-09 |
| 9 | Ranked inbox, deterministic floor | `agent/src/proactive.ts`; screenshot from the live deploy |
| 10 | 9 / 47 / 14 spans; proactive at 0 tokens | `FLEETGRAPH.MD` § Execution Traces — 3 public traces |
| 11 | Agent holds no write credential | `agent/src/gate.ts`; `__tests__/graphWriteBoundary.test.ts` |
| 12 | $0.006055 / 7 invocations | `agent/cost-ledger-snapshot.jsonl` |
| 12 | ~$4.47/user/month, on-demand 64% | `FLEETGRAPH.MD` § Production Cost Projections |
| 12 | destroy-and-redeploy proof | `terraform/render/plan/tro-316-destroy-redeploy-proof.md` |

## Notes before posting

- **Tweet 1 keeps the two-week framing** as the hook, then pivots to the agent in tweet 2. If you'd
  rather the thread be agent-only from the first word, swap tweet 1 for: *"I built an AI agent into
  a US Treasury project-management app. it reads the project, tells you what needs you, and can't
  write a thing without your say-so 🧵 @gauntletai"* (198 chars).
- **"legacy"** — the repo is a fork of an actively-maintained public project, not an abandoned one.
  Fine as voice; worth knowing if someone in the replies knows the repo.
- **Don't claim the rollback is complete** if it comes up. It's a real, scheduled, tested trigger on
  sustained unreadiness — deliberately not counted as meeting "if a CI run fails," because it isn't
  that.
- **Standup and retro drafts compose and are traced, but nothing schedules them yet.** If asked what
  isn't done, that's the honest answer.
