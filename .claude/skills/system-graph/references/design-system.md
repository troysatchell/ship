# The design system

Every rule here is enforced by code in `assets/`. If you want to change one, change
it in the token generator or the template — not in an individual diagram. A rule
that can be overridden per-diagram is not a rule, and within three diagrams you are
back to the bland, inconsistent output this skill exists to replace.

Evidence for each law is in `references/research.md`.

---

## LAW 1 — One model, many lenses

Structure, flow, and data are **views over one node set**, not three diagrams. A
node means the same thing in every lens; only the edges shown change.

Why: readers build one mental map and reuse it. Three separately-authored diagrams
of the same system force three maps, and they will disagree with each other within
a month.

Enforcement: `build.py` derives every view from the same `nodes:` list. A node
cannot exist in one lens and not another except by having no edges there.

Default lens assignment for edges:

| edge kind | appears in |
|---|---|
| `flow`, `control`, `violation` | structure, flow |
| `feedback`, `recursion` | flow (recursion also structure) |
| `data` | data |
| `gap` | flow |

Override per edge with `views: [...]`.

---

## LAW 2 — Layout is computed, never authored

ELK's layered algorithm, at build time, with these options (`ELK_BASE` in
`build.py`):

```
elk.algorithm                              layered
elk.hierarchyHandling                      INCLUDE_CHILDREN   # zones lay out as one graph
elk.edgeRouting                            ORTHOGONAL
elk.layered.layering.strategy              NETWORK_SIMPLEX    # compact, balanced layers
elk.layered.nodePlacement.strategy         BRANDES_KOEPF      # straightest edges
elk.layered.crossingMinimization.strategy  LAYER_SWEEP
elk.layered.cycleBreaking.strategy         DEPTH_FIRST
elk.spacing.nodeNode                       40
elk.layered.spacing.nodeNodeBetweenLayers  96
elk.spacing.edgeNode                       36
```

**Crossing count is the aesthetic that measurably matters most** for human
comprehension of a graph; bend count is second. Symmetry and grid-alignment
measure as near-worthless by comparison. So crossing minimisation and bend
reduction are the two things the config buys, and everything else yields.

**The layout search.** A 14-stage pipeline laid out left-to-right is a 20:1 sliver;
laid out top-down it is a 1:5 column; a dependency graph laid out with the wrong
grouping is a bowl of spaghetti. Rather than guess, `build.py` lays out every view
up to **twelve ways** — six strategies (linear, two wrapping modes, column,
column-tight, linear-merged) × two grouping modes (zones kept, zones flattened) —
measures each result, and keeps the best. The chosen configuration and its scores
are printed at build time.

The score, in priority order:

| term | weight | why |
|---|---|---|
| edge crossings per edge | 1.00 | the strongest measured predictor of graph comprehension |
| mean edge length | 0.50 | long detour routes are what makes a graph *feel* like spaghetti even when the crossing count is tolerable |
| aspect-ratio distance from 1.55 | 0.45 | a shape that does not fit a screen cannot be read at all |

Crossings are counted directly on the routed polylines — pairwise segment
intersection, excluding shared endpoints. It is not a perfect count (collinear
overlaps are skipped) but it is a faithful *relative* measure, which is all a search
needs. On a real 25-module dependency graph this changed the chosen layout from 32
crossings with a 2,114px mean edge to **10 crossings with a 655px mean edge** — the
difference between a hairball and a diagram.

**Off-page connectors.** When a wrapped layout produces a continuation edge that
travels backwards across more than 28% of the canvas, the artifact does not draw
it in full — a full-length wrap edge becomes a large bracket that the eye reads as
a container. It is drawn instead as a short stub at each end, labelled with the
far endpoint. This is the standard off-page-connector convention.

Never hand-edit coordinates. If a layout is wrong, the model is wrong (usually a
missing zone, or a node in the wrong zone), or the view needs `layoutOptions`.

---

## LAW 3 — One flow direction per canvas

Set per view (`direction: RIGHT` default). Never mixed within a canvas.

Why: a consistent direction lets the reader form one rule — "rightward means
later" — and stop re-deriving direction per edge. Mixed directions force per-edge
arrowhead inspection, which is serial, slow, and error-prone.

---

## LAW 4 — Grouping is enclosure, when it earns its place

Subsystems are `zones`: real containers with a boundary, a tinted surface, an
accent rule along the top, and a label.

Why: **common region** (a shared enclosing boundary) is a stronger grouping cue
than proximity, and stronger than colour similarity. Proximity-based grouping
collapses the moment a layout gets crowded; enclosure does not.

Zones cost vertical space. That is the correct trade — *when the grouping matches
the structure*. It often does not. Directory-based zones over a dependency graph are
the common failure: a module's directory is only weakly correlated with its position
in the dependency order, so the container boundaries force long detour routes and
the diagram ends up worse than with no grouping at all.

So the layout search (LAW 2) tries both. If flattening the zones improves the
combined score by more than 30%, the builder flattens them and prints a note saying
it did and why. Grouping has to earn its place like everything else.

Three to six zones is the useful range; past that they stop chunking anything.

---

## LAW 5 — Category is shape *and* colour

Seven node kinds, seven silhouettes, seven hues — under **two vocabularies**. A
codebase and a delivery pipeline are structurally the same object, so `module`,
`guard`, `datastore`, `api`, `orchestrator` and `vendor` are aliases that resolve to
`transform`, `gate`, `store`, `release`, `control` and `external`. The card, the
legend and the inspector all display whichever word the author actually wrote; the
geometry and the analysis use the canonical seven. Same grammar, two dialects. The silhouette is not decoration:
it is the redundant encoding that keeps the diagram readable under red-green colour
blindness, in greyscale print, and at a zoom level where fills are three pixels tall.

| kind | silhouette | rationale |
|---|---|---|
| `intake` | stadium cap on the left | flowchart terminal, "start" |
| `transform` | rounded rectangle | flowchart process |
| `gate` | chevron in, chevron out | a valve work must pass through |
| `store` | cylinder cap on the left | flowchart data store |
| `release` | stadium cap on the right | flowchart terminal, "end" |
| `control` | hexagon | flowchart preparation/orchestration |
| `external` | dashed border, desaturated | outside the boundary |

Card anatomy, top to bottom: kind label (8.5px, uppercase, tracked, accent hue),
title (13px/620), subtitle (10.5px, 68% opacity). Right side carries at most two
badges: `↻` if work returns to this stage, `!` if an open finding touches it.

Do not add an eighth kind. If something does not fit, it is a `transform` with a
better subtitle, or it belongs in a different diagram.

---

## LAW 6 — Return paths leave the layer stack

Feedback and recursion edges are **excluded from the layered layout entirely**, then
routed afterwards — dashed, in the gate hue (feedback) or store hue (recursion),
with the loop badge riding on the path.

*How* each return leaves the stack is decided per edge, by measurement, from six
candidates:

- four **local arcs** — two bow depths × two sides;
- two **perimeter channels** — orthogonal routes around the top or bottom of the
  whole graph, in stacked lanes so channels never overlap each other.

Every candidate is sampled and scored by how many sample points land on top of a
node card (weighted ~2000× per hit relative to length). A short return between
neighbours keeps its tight local arc; a long return across a wrapped layout is
walked around the outside instead of slicing through every row. Dense real-world
factories are what forced this: with ten returns converging on a hub, naive arcs
sweep the whole canvas and read as noise.

**De-emphasis at density.** When more than five return edges are visible in a lens,
they rest at 38% opacity and come to full strength on hover, or when their loop is
isolated from the panel. Their hue is the loudest in the palette by design — at
volume it has to yield, or it stops meaning anything (Tufte again: the smallest
effective difference).

Why this is the most important law in the file: a return path drawn as a straight
line through a forward-flowing layer stack is visually indistinguishable from a
forward dependency. The reader's single directional rule (LAW 3) breaks, and every
edge in the region has to be inspected individually. This is the defining failure
of hand-drawn architecture diagrams — the one that makes them feel like a wall of
spaghetti rather than a system.

The arc's bow direction is chosen by measuring which side of the straight line is
less crowded by other node rectangles. Same principle as LAW 2: measure, don't hope.

**Loop badges** follow the causal-loop-diagram convention: a pill at the arc apex
carrying the loop identifier and the edge polarity. `R` (amber) = reinforcing, the
loop compounds. `B` (cyan) = balancing, the loop seeks a goal. Classification comes
from polarity parity around the loop when every edge is labelled, and from the
return edge's own polarity otherwise.

---

## LAW 7 — Colour is generated, not chosen

`assets/palette.py` builds the whole palette in **OKLCH** at fixed lightness and
fixed chroma, varying only hue. Run it to see the values; do not paste hex codes
anywhere else.

```
python3 assets/palette.py          # table + WCAG validation
python3 assets/palette.py --json   # tokens
```

Why OKLCH: in HSL, equal numeric lightness across hues produces wildly unequal
*perceived* lightness — a yellow at 80% looks far brighter than a blue at 80%. That
inequality reads as "the yellow category is more important", which is a claim the
diagram never intended to make. OKLCH is perceptually uniform, so fixing L and C
and sweeping H yields categories of genuinely equal visual weight.

Five categorical hues (intake 264°, transform 152°, gate 82°, store 310°,
release 196°) plus two structural neutrals (control, external) plus one reserved
alert hue (27°). **Five to seven is the ceiling** — beyond roughly eight, colours
stop being identifiable at a glance and the reader falls back to legend lookup,
which forfeits the entire benefit of colour coding.

The alert hue is reserved for *state* (violations, gaps, findings). It is never a
category. Colour encodes one dimension only; overloading it with two is unreadable.

**Validation is a build gate.** `build.py` regenerates the palette, runs the WCAG
checks — 3:1 for every accent against the canvas (1.4.11, non-text contrast) and
4.5:1 for every label against its own fill (1.4.3) — and **refuses to emit a file**
if any pair fails. Both themes, every kind.

---

## LAW 8 — Context recedes

External and out-of-scope nodes get the desaturated neutral. Wrap continuation
edges get 1.25px strokes and muted chips. Zone notes sit at 75% opacity.

Tufte's smallest effective difference: every unit of contrast spent on structure is
a unit unavailable to the content. The goal is not maximum separation between layers
— it is the *minimum separation that still reliably separates them*.

---

## LAW 9 — Twenty to thirty nodes per view, hard

Node-link representations beat the alternatives at small sizes and lose that
advantage as graphs grow; comprehension degrades regardless of layout quality once
a view passes roughly 20–30 simultaneously visible nodes. Working memory holds
about four chunks.

So: aggregate into zones (each zone is one chunk), split into more lenses, or
collapse a subsystem to a single node and give it its own diagram. The artifact's
focus mode — click a node, everything more than one hop away dims to 13% — is the
"details on demand" half of *overview first, zoom and filter, details on demand*.

Note the mechanism: focus **dims**, it does not **delete**. Removing context would
destroy the spatial memory the reader just built.

---

## LAW 10 — Nothing is decorative

No gradients. No drop shadows on content (one soft shadow on loop badges, so they
read as floating above the arc rather than as a break in it). No colour that does
not encode something. No line style that does not mean something.

The test: point at any visual difference in the output and answer "it means X". If
you cannot, delete it.

---

## Spacing, type, motion

- Spacing scale: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. Nothing off-scale.
- Radii: 6 (chips) / 10 (cards) / 14 (panels) / 16 (zones).
- Type: system UI stack. 8.5px tracked caps for kind labels and section headers,
  10.5–11.5px for secondary, 13px/620 for titles, 16px for the inspector heading.
  Monospace only for identifiers, metrics, and keyboard hints.
- Motion: 120–180ms, `cubic-bezier(.2,.7,.3,1)`, on opacity and brightness only.
  Nothing moves position after layout. A node that moves is a node the reader has
  to re-find.
- Both themes ship in every artifact and both are validated. Dark is the default
  because these are read on screens, next to a terminal.

---

## Interaction contract

| gesture | effect |
|---|---|
| `1` `2` `3` | switch lens |
| click node | focus: node + one hop stay lit, everything else dims; inspector opens |
| click loop badge, or a loop in the panel | isolate that cycle |
| click a finding | isolate the stages it concerns |
| `f` / `g` | toggle feedback / gaps |
| `[` / `]` | collapse the left controls / right details panel |
| `\` | presentation mode: hide both panels, only the graph (press again to restore) |
| `0` | fit |
| `Esc` | clear focus |
| wheel / drag | zoom / pan |

The right panel always shows loops and open questions, even when nothing is
selected. Those two lists are the reason the artifact exists; they are not a
detail view.
