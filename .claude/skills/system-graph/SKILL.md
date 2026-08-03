---
name: system-graph
description: Build rigorous, legible architecture and process diagrams as interactive artifacts — node-and-edge graphs with real layout, enforced visual hierarchy, explicit cycle/recursion encoding, and automatic detection of structural gaps. Use when asked to diagram, map, visualize, or explain a codebase, repo, module or dependency structure, system architecture, service topology, pipeline, workflow, software factory, agent fleet, or CI/CD process; when asked for a component diagram, dependency graph, data-flow or control-flow diagram, C4 model, or "show me how this system fits together"; when asked where the circular dependencies, loops, recursion, bottlenecks, god modules, or missing pieces are; when an existing diagram is called flat, bland, unreadable, or a hairball; or whenever a Mermaid/flowchart request involves more than ~8 nodes, containers, cycles, or feedback.
---

# system-graph

Ordinary HTML "diagram artifacts" fail for a specific, diagnosable reason: they draw
boxes and arrows without a **model**, without a **layout engine**, and without a
**visual grammar**. The result has no hierarchy, no grouping, no distinction between
a forward step and a return path, and no way to say *this connection should exist
and doesn't*. This skill replaces that with a pipeline that has all four.

**The rule that governs everything below: the diagram is a rendering of a model, and
the model is derived from evidence. Never draw boxes directly. Never hand-place a
node. Never hand-pick a colour.**

## Two profiles, one grammar

A codebase and a delivery pipeline are the same kind of object: things that receive,
do work, check, hold state, hand off, and route. They share seven silhouettes and
one edge vocabulary. Only the words and the checks differ.

| | `profile: code` | `profile: process` |
|---|---|---|
| nodes are | modules, services, packages | stages, steps, systems |
| edges are | imports, calls, references | work moving, results returning |
| cycles mean | circular dependency (usually a defect) | iteration (usually intended) |
| checks | god modules, hubs, oversized modules, layer violations, dead code | gates that can't reject, loops with no exit, missing failure paths, open loops |

The profile is inferred from the vocabulary you use, or set explicitly in
`meta.profile`. Kind aliases (`module`, `service`, `guard`, `datastore`, `api`,
`orchestrator`, `vendor`, …) resolve to the seven canonical kinds, and each card
keeps whichever word you wrote.

## The pipeline

```
repo / description  →  model.yaml  →  analyze  →  layout (ELK)  →  artifact.html
                                          ↓                     →  model.d2
                                    findings, loops, metrics
```

```bash
SKILL=<path to this skill dir>

# codebase: extract a draft, correct it, build
npx depcruise src --no-config --output-type json > deps.json
python3 $SKILL/assets/from_depcruise.py deps.json --root src > model.yaml   # then EDIT
python3 $SKILL/assets/build.py model.yaml -o architecture.html --d2 architecture.d2 --report

# process: write the model by hand, starting from examples/software-factory.yaml
python3 $SKILL/assets/analyze.py model.yaml     # findings report — read this first
python3 $SKILL/assets/build.py  model.yaml -o factory.html --d2 factory.d2 --report
```

`build.py` needs Node 18+ once, to fetch `elkjs` into `~/.cache/system-graph`.
Everything else is stdlib Python + PyYAML. The output HTML is fully self-contained:
no CDN, no runtime graph library, geometry baked at build time.

## Workflow

### 1. Ask what the diagram is *for* before building anything

A diagram answers a question. "Diagram my repo" is not a question. Establish which
of these it is, because it changes what goes in the model:

- *What depends on what, and what would break?* → structure lens, metrics on
- *What's the blast radius of changing X?* → structure lens, focus on X
- *Where does work get stuck?* → flow lens, gate and loop emphasis
- *What's missing?* → the findings panel is the deliverable; the graph is context

If the user is present and this is ambiguous, ask. If unattended, pick structure for
a repo and flow for a process, say which you picked, and proceed.

### 2. Derive the model from evidence, not from reading vibes

Follow `references/extraction.md`. Cheapest first:

1. **Config mining** — workspace files, `docker-compose.yml`, k8s manifests, CI
   workflows. These name the components for you.
2. **Dependency extraction** — `dependency-cruiser`/`skott` (JS/TS),
   `import-linter`/`pydeps` (Python), `go list -json ./...` (Go),
   `cargo modules` (Rust), `jdeps` (JVM). `assets/from_depcruise.py` turns
   dependency-cruiser output straight into a draft model.
3. **Reading code** only for what tools cannot see: dynamic dispatch, cross-service
   calls made by string/route/topic name, and human steps in a process.

Mark anything inferred rather than resolved with `confidence: heuristic`. **A
diagram that hides its uncertainty is worse than no diagram.**

`from_depcruise.py` guesses every `kind` from filename patterns and prints each
guess to stderr. Correcting those guesses is the job, not a formality — whether a
module is your auth gate, your public surface, or just another module is most of
what makes the picture worth looking at.

### 3. Write or correct the model

`references/model-schema.md` is the reference.
`examples/codebase-architecture.yaml` (a real 25-module TypeScript library,
extracted with dependency-cruiser then hand-corrected) and
`examples/software-factory.yaml` are working examples. Non-negotiables:

- Every node gets a `kind` — one of the seven, or an alias. Nothing else parses.
- Every node that groups with others gets a `zone` — **but only if the grouping
  matches the structure.** Directory-based zones over a dependency graph usually
  fight the layering; the builder measures this and tells you.
- Every return path is `kind: feedback` (or `recursion`), never a plain `flow` edge
  pointing backwards.
- Every feedback edge gets a `polarity` (`+` amplifies, `-` corrects).
- Anything you believe *should* connect but doesn't gets `kind: gap`. This is the
  single highest-value thing the format does. Use it.
- `emits:`/`consumes:` names let the analyzer find producers with no consumer and
  consumers with no producer, and auto-populate the data lens.
- `sources:` anchors each node to real files (path, optional symbol/lines); with
  `meta.repoUrl` set they render as deep links in the inspector. This is what
  turns the graph from a summary into a surface you can answer questions from —
  click the claim, land in the code.

### 4. Read the findings before you show anyone the picture

Findings are *claims about the model*. Some will be wrong because the model is
incomplete — that is useful information. Fix the model and rerun; do not silence the
check. See `references/loop-analysis.md` for what each one means and which profile
it runs under. When you present the artifact, lead with the findings that survived.

### 5. Build, verify, deliver

The builder prints which layout it chose, its measured crossing count and mean edge
length, and whether it had to flatten your zones. Then **look at it** — screenshot
the HTML headless and read the image. An unviewed diagram is an unverified diagram.
Check: does any edge pass through a node? Is any label detached from its edge? Does
it fit at a readable zoom? If a lens looks wrong, fix the model or set
`layoutOptions` on that view; never nudge coordinates.

Deliver with `SendUserFile`. If it's a system the user will return to, also persist
it as an artifact.

## The design system — enforced, not suggested

Full rationale and citations in `references/design-system.md`. The laws:

1. **One model, many lenses.** Structure, flow, and data are views over the same
   node set, never separate diagrams.
2. **Layout is computed and *measured*, never authored.** ELK layered with
   orthogonal routing. Every view is laid out up to twelve ways — six strategies ×
   zoned/flattened — and scored on **edge crossings first**, mean edge length
   second, aspect ratio third. Crossings are the strongest measured predictor of
   whether a human can read a graph, so the search optimises for them rather than
   for a pretty rectangle full of spaghetti.
3. **One flow direction per canvas.** Set once, never mixed.
4. **Grouping is enclosure — when it earns its place.** Zones are containers with a
   common region. If flattening them cuts crossings and edge length decisively, the
   builder flattens and says so.
5. **Category is shape *and* colour, never colour alone.** Seven kinds, seven
   silhouettes. Survives colour-vision deficiency and greyscale.
6. **Return paths leave the layer stack.** Feedback and recursion are routed
   outside the forward flow — a tight local arc when the return is short, a
   perimeter channel around the graph when it is long — chosen per edge by sampling
   each candidate route and counting node overlaps. Dashed, badged with loop id and
   polarity; when more than five returns are visible they rest dimmed and light up
   on hover or loop-select. A return path drawn *through* the stack reads as a
   forward dependency — the defining failure of hand-drawn architecture diagrams.
7. **Colour is generated, not chosen.** OKLCH at fixed lightness and chroma. The
   palette is regenerated and WCAG-validated on every build; a failing contrast
   ratio blocks the build.
8. **Context recedes.** External and out-of-scope nodes are desaturated neutral.
9. **~20–30 nodes per view, hard.** Past that, comprehension degrades regardless of
   layout quality. Aggregate, split, or collapse a subsystem into one node.
10. **Nothing is decorative.** Point at any visual difference and answer "it means
    X". If you can't, delete it.

## The node taxonomy — fixed

| canonical | code aliases | process meaning | silhouette |
|---|---|---|---|
| `intake` | entrypoint, handler, cli, webhook, listener | work enters here | left stadium cap |
| `transform` | module, service, component, package, library, worker | work is done | plain rounded box |
| `gate` | guard, policy, validator, middleware, auth | a check or decision | chevron in / chevron out |
| `store` | datastore, database, cache, repository, queue | durable state | cylinder cap |
| `release` | api, endpoint, publisher, artifact | work leaves here | right stadium cap |
| `control` | orchestrator, router, scheduler, dispatcher | routes or schedules | hexagon |
| `external` | vendor, thirdparty, dependency, upstream | outside the boundary | dashed, desaturated |

## The edge grammar — fixed

| kind | code meaning | process meaning | style |
|---|---|---|---|
| `flow` | depends on / calls | work moves forward | solid, orthogonal |
| `control` | registers, wires, dispatches | triggers or schedules | dotted |
| `data` | reads or writes shared state | data is read or written | thin, open head |
| `feedback` | callback, inversion of control | a result returns upstream | dashed arc, badged |
| `recursion` | mutually or self-recursive | the stage re-enters itself | fine dash arc |
| `violation` | breaks the layering contract | breaks a stated rule | solid, alert hue |
| `gap` | a dependency that should exist and doesn't | a link that should exist and doesn't | ghost dots, alert hue |

## Handing an artifact to an agent or LLM

Every artifact is self-describing to a machine, by construction:

- An **HTML comment at the top of the file** tells any agent where to look and
  defines the vocabulary (kinds, edge semantics, loop types, findings).
- The complete analysed model — every node with its `detail` prose and metrics,
  every edge with polarity and confidence, loops, findings — is embedded in
  `<script type="application/json" id="system-graph-model">`. An agent should read
  that one element and ignore the rest of the file. It contains strictly more than
  a human can see on screen.
- The **Copy brief** header button produces the same model as a markdown narrative
  for pasting into a chat; `build.py --brief out.md` writes it to a file.

Hand an agent the HTML (best), the brief, or the model YAML — never a screenshot.
A screenshot loses hover detail, softened return edges, and clipped labels; the
file loses nothing.

## When *not* to use this

- Fewer than ~6 nodes with no cycles and no grouping — plain Mermaid renders inline
  on GitHub and is fine. Say so rather than over-building.
- A sequence/timing diagram (who calls whom in what order over time). This models
  topology, not chronology.
- A pure data chart. Use the `dataviz` skill.

## References

| file | read it when |
|---|---|
| `references/design-system.md` | changing any visual rule, or justifying one |
| `references/model-schema.md` | writing or extending a model |
| `references/extraction.md` | pointing this at a real repository |
| `references/loop-analysis.md` | interpreting findings, adding a check |
| `references/research.md` | someone asks "why is it like that" |
| `references/tooling.md` | choosing renderers, or asked why not Mermaid |
