# Tooling: what this skill uses, and what it rejected

---

## The stack

| layer | choice | why |
|---|---|---|
| model | YAML/JSON, this skill's schema | git-diffable, tool-agnostic, expresses gaps and polarity — which no diagram DSL does |
| analysis | `analyze.py` (stdlib) | SCC, loop derivation, Martin metrics, workflow-soundness gap checks |
| layout | **ELK layered** via `elkjs`, at build time | best-in-class layered algorithm; deep option surface; genuine hierarchy support |
| render | hand-written SVG + ~14 kB vanilla JS | total control over the visual grammar; zero runtime dependencies |
| static export | **D2** (`to_d2.py`) | terse, diffable, renders anywhere; the file you commit |

### Why layout at build time instead of in the browser

Computing the layout once, at build time, and baking the geometry into the artifact
buys four things at once:

1. **Self-contained output.** No CDN, no `<script src>`, no network at view time.
   Works offline, works inside a sandboxed artifact panel, works when emailed.
2. **Deterministic geometry.** Same model → same coordinates → a reviewable diff.
   A layout that reshuffles on every page load cannot be reviewed.
3. **Instant render.** No 1.6 MB layout engine to download and run before the first
   pixel.
4. **Freedom in the renderer.** Nothing to fight. Every shape, dash, badge and chip
   is exactly what the design system specifies, because we draw it ourselves.

The cost is that node positions are fixed. For a *diagram* — as opposed to an
*editor* — that is not a cost.

### ELK options that matter

Full set in `ELK_BASE` in `build.py`. The load-bearing ones:

- `elk.hierarchyHandling: INCLUDE_CHILDREN` — lays out the whole hierarchy as one
  graph, so zones and their contents cohere. Without it each zone is laid out in
  isolation and cross-zone edges route terribly.
- `elk.layered.cycleBreaking.strategy` — `DEPTH_FIRST` here. Mostly moot, because
  feedback edges are removed before layout (LAW 6); this catches residual cycles.
- `elk.layered.nodePlacement.strategy: BRANDES_KOEPF` — optimises for straight
  edges. `NETWORK_SIMPLEX` is more compact; swap if density is the problem.
- `elk.edgeRouting: ORTHOGONAL` — right-angle routing, which the renderer then
  draws with 9px rounded corners so bends stay traceable without the circuit-board
  look.
- `elk.layered.wrapping.strategy` — `SINGLE_EDGE` / `MULTI_EDGE`. This is what
  rescues long pipelines from being 20:1 slivers. `build.py` searches across
  wrapping strategies and picks by measured aspect ratio.

**One trap worth knowing.** Under `INCLUDE_CHILDREN`, ELK hoists all edges to the
root's edge list, but their coordinates remain relative to the **least common
ancestor of the two endpoints** — not to the node they are listed under. Treating
them as root-relative silently draws intra-zone edges hundreds of pixels away from
the boxes they connect. `absolutise()` in `build.py` computes the LCA origin per
edge. If you ever port this, port that function first.

---

## What was rejected, and why

### Mermaid — not as the primary renderer

Mermaid's advantage is distribution (GitHub, GitLab and Notion render it inline),
not rendering quality. Concretely:

- Default layout is dagre, with well-documented crossing and overlap problems on
  moderately complex graphs (mermaid-js issues #5601, #5060, #7492).
- An ELK layout package (`@mermaid-js/layout-elk`) exists *because* the default was
  insufficient — but it is opt-in and platforms that render Mermaid natively do not
  support it.
- `subgraph` is a visual box, not a first-class container: no expand/collapse, no
  per-container layout options, and cross-boundary edges route poorly.
- Styling is `classDef` plus a limited theme-variable system. No per-edge control
  comparable to what the grammar in LAW 5/6 requires.
- Rendering degrades noticeably past a few dozen nodes.

**Use Mermaid when** the graph is small, acyclic, ungrouped, and the point is that it
renders in a README. Say so plainly rather than over-building. Everything else is
what this skill is for.

### D2 — used for export, not as the artifact

Genuinely good: clean DSL, containers, `classes`/`vars` for a real design system,
several layout engines. `to_d2.py` emits it with the same tokens, so a `d2` render
and the HTML artifact are siblings.

Not the primary artifact because: the best layout engine (TALA) is commercial; the
free dagre default breaks on ancestor→descendant edges; one label per edge; no
interactivity; and the browser path is a Web Worker plus a large WASM payload.

```bash
d2 --layout elk --theme 200 factory.d2 factory.svg
```

### Structurizr / C4 — a complementary model, not a replacement

Structurizr DSL and the C4 model are the right tool for *containment levels*
(context → container → component → code) and export widely (PlantUML, Mermaid, D2,
DOT). LikeC4 is the modern alternative with better DX and an interactive React
renderer.

They are weak at exactly what this skill is for: dynamic views are ordered traces,
not control flow, so there is no first-class way to express a loop, a polarity, a
retry, or a link that should exist and doesn't.

If the user is already a C4 shop, model in Structurizr and use this skill for the
process/flow lens on top.

### Cytoscape.js, React Flow, Graphviz

- **Cytoscape.js + cytoscape-elk** — the strongest *runtime* option: compound nodes,
  taxi edges, built-in Tarjan SCC, CSS-like stylesheets, single-script CDN embed.
  Rejected only because build-time layout gives self-containment and determinism
  that a runtime engine cannot. Reach for it if you need drag/edit interactivity.
- **React Flow / xyflow** — an editor library. Needs React, and is disproportionate
  weight for a read-only diagram.
- **Graphviz** — still the cleanest manual control over feedback edges anywhere
  (`constraint=false` draws an edge while excluding it from rank assignment — the
  original version of LAW 6). Loses on styling vocabulary, container depth, and
  browser embedding.

---

## Verification

Every artifact should be looked at before it is delivered.

```bash
node -e "
const {chromium} = require('playwright');
(async () => {
  const b = await chromium.launch();          // add executablePath if pinned
  const p = await b.newPage({viewport:{width:1680,height:1000}, deviceScaleFactor:2});
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('file://' + process.cwd() + '/factory.html');
  await p.waitForTimeout(800);
  await p.screenshot({path:'check.png'});
  await b.close();
})();
"
```

Then read the image. Checklist:

- Does any edge pass through a node body?
- Is any label detached from the edge it belongs to?
- Does the graph fit at a zoom where 13px titles are legible?
- Are the feedback arcs distinguishable from the flow edges at a glance?
- Does the legend account for every visual difference on the canvas?

`assets/palette.py` run standalone re-validates every contrast pair and exits
non-zero on failure; `build.py` runs the same check and refuses to write a file that
fails it.
