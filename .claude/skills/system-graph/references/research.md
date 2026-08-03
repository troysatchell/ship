# Why the rules are these rules

Evidence behind the design system. Cite this when someone asks why the diagram
looks the way it does, or wants to override a law.

---

## Which layout aesthetics actually help

Purchase et al. tested aesthetic criteria against measured human task performance
(time and error rate), not preference. The ranking that came out:

1. **Edge crossings** — by far the strongest predictor. Consistently replicated.
2. **Edge bends** — second; each bend adds tracing cost.
3. **Symmetry** — real but modest, and expensive to compute.
4. **Minimum angle** — weak, often not significant on its own.
5. **Orthogonality / grid alignment** — *not* statistically significant for
   comprehension, despite looking tidy.

→ LAW 2: optimise crossings first, bends second, let the rest go.

Crossing *angle* matters as a second-order effect (Huang, Eades & Hong): crossings
near 90° cost almost nothing, shallow near-parallel crossings slow tracing sharply.
But Kobourov et al. found the angle effect is strongest around 40 nodes and
essentially disappears by 120 — past a density threshold the whole drawing is
illegible and micro-aesthetics stop mattering. → LAW 9: change representation
instead of micro-optimising.

- Purchase 1997, *Which Aesthetic Has the Greatest Effect on Human Understanding?*
  https://link.springer.com/chapter/10.1007/3-540-63938-1_67
- *State of the Art in Empirical User Evaluation of Graph Layouts*
  https://eprints.gla.ac.uk/227646/1/227646.pdf
- Huang et al., *Larger crossing angles make graphs easier to read*
  https://www.sciencedirect.com/science/article/abs/pii/S1045926X14000317
- Kobourov et al., *Are Crossings Important for Drawing Large Graphs?*
  https://www2.cs.arizona.edu/~kobourov/crossings.pdf

## Why layered (Sugiyama) layout, and how back edges are conventionally drawn

Four phases: cycle removal → layer assignment → crossing reduction → coordinate
assignment. It encodes direction *spatially*, so the reader forms one rule ("right
means later") instead of re-deriving direction per edge.

Edges reversed during cycle removal are the true back edges. Convention is to draw
them visually distinct and routed around the outside of the layer stack rather than
through it — a back edge drawn straight through a forward-flowing layout gets read
as a forward dependency. → LAW 3 and LAW 6.

- https://blog.disy.net/sugiyama-method/
- ELK layered reference: https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html

## Grouping: enclosure beats proximity beats colour

Classical Gestalt cues are probabilistic and weak. Two modern additions dominate:

- **Common region** (Palmer): elements inside a shared boundary group together even
  when far apart or dissimilar. Stronger than proximity alone.
- **Uniform connectedness** (Palmer & Rock; Han, Humphreys & Chen 1999): elements
  joined by a visible connector group as a unit, and this is computed *earlier* in
  visual processing than grouping by similarity — it can override it. Connectedness
  reliably beats similarity; it is roughly comparable to proximity.

Practical ranking when cues conflict: enclosure > connectedness ≈ proximity >
colour similarity > continuity > closure. This is *why* node-link diagrams convey
relationships at all, and why containers beat spacing for subsystem grouping.
→ LAW 4.

- Han, Humphreys & Chen 1999: https://link.springer.com/article/10.3758/BF03205537
- https://lawsofux.com/law-of-uniform-connectedness/

## Colour: how many, and how to generate them

Cleveland–McGill / Mackinlay rank channels for *quantitative* accuracy. For
*categorical* data the preattentive identity channels are hue, shape, and spatial
grouping. Both hue and shape pop out in under ~250ms, in parallel — but they should
not encode two different dimensions simultaneously unless the reader must
cross-reference them.

Practical categorical ceiling is roughly 6–8 colours; beyond that readers fall back
to legend lookup and the preattentive benefit is gone. → LAW 7 (five hues + two
neutrals + one reserved alert).

Okabe-Ito and ColorBrewer qualitative sets solve colour-vision deficiency by varying
lightness *as well as* hue. This skill takes the other route: fixed lightness (so no
category looks more important) plus a **distinct silhouette per kind**, which is a
shape channel and immune to CVD entirely. → LAW 5.

OKLCH matters because HSL's lightness is not perceptual — yellow at L=80% looks far
brighter than blue at L=80%, and that inequality reads as a claim about importance.
OKLCH is perceptually uniform, so fixing L and C and sweeping H gives genuinely
equal visual weight.

WCAG: **1.4.11** requires ≥3:1 for graphical objects needed to understand content
(node borders, icons, edge strokes — not just text). **1.4.3** requires ≥4.5:1 for
text, including labels sitting on a coloured node fill. Both are checked on every
build, both themes, every kind, as a hard gate.

- Okabe-Ito: https://journal.r-project.org/articles/RJ-2023-071/
- WCAG 1.4.11: https://www.wcag.com/designers/1-4-11-non-text-contrast/
- OKLCH: https://colorarchive.org/guides/oklch-color-space-guide/

## Visual hierarchy

Tufte's *layering and separation* and *smallest effective difference*: make
structural and contextual elements differ from content by the minimum amount that
still separates them. Every unit of contrast spent on gridlines, containers, and
background nodes is a unit unavailable to what the reader must act on. → LAW 8.

## How many nodes fit

Ghoniem, Fekete & Castagliola compared node-link against adjacency matrices at
20/50/100 nodes: node-link wins clearly at small sizes, and the advantage shrinks as
size and density grow; for tasks other than path-finding, matrices overtake it.
Working memory holds about four chunks (Cowan's revision of Miller). Combined
practical ceiling: ~20–30 simultaneously visible nodes.

Shneiderman's mantra — *overview first, zoom and filter, details on demand* — is the
mitigation, and it is a load-management strategy, not a UI flourish. At each zoom
level the visible primitive count should stay near the ceiling. → LAW 9.

- Ghoniem et al.: https://journals.sagepub.com/doi/10.1057/palgrave.ivs.9500092
- Shneiderman 1996: https://www.cs.umd.edu/~ben/papers/Shneiderman1996eyes.pdf

## Encoding feedback and recursion

Causal loop diagrams (systems-thinking tradition) annotate every link with polarity
(`+`/`-`) and every closed loop with an identifier and a type marker: **R**
reinforcing (even number of negatives — compounds) or **B** balancing (odd — seeks a
goal). The parity rule is a formal test, and practice is to re-trace and verify
rather than eyeball it.

The reason to adopt this rather than just drawing an arrow: tracing a loop by eye is
a serial, non-preattentive task — exactly the thing that overloads working memory.
Annotating the loop moves that work into the diagram.

Compiler/CFG visualisation practice contributes the rest: classify back edges by DFS,
draw them distinctly, keep self-loops compact and visually separate from long-range
back edges, and highlight strongly connected components as a group so mutual
recursion is one glance rather than a traced path. → LAW 6 and
`references/loop-analysis.md`.

- https://thesystemsthinker.com/causal-loop-construction-the-basics/
- https://pages.cs.wisc.edu/~fischer/cs701.f14/finding.loops.html

## Gaps as a first-class concept

Workflow-net soundness (van der Aalst) gives a finite checklist for "what is
structurally missing" in a process: option to complete, proper completion, no dead
transitions, no deadlock, no livelock. Each maps to a check in `analyze.py`. This is
where the skill's ability to say "this link should exist and doesn't" comes from —
absence is not something a drawing tool can express, but it is something a model can.

- van der Aalst, *Verification of Workflow Nets*: https://www.vdaalst.com/publications/p44.pdf
- *Soundness of workflow nets: classification, decidability, and analysis*:
  https://www.researchgate.net/publication/220102180

## Node weighting

Robert C. Martin's package metrics: instability `I = Ce/(Ca+Ce)`, abstractness
`A = Na/Nc`, distance from the main sequence `D = |A + I − 1|`. High D means either
the "zone of pain" (concrete and heavily depended on — dangerous to change) or the
"zone of uselessness" (abstract and depended on by nothing). `analyze.py` computes
fan-in, fan-out and instability automatically.

- https://en.wikipedia.org/wiki/Software_package_metrics

## Anti-patterns, and which law kills each

| anti-pattern | killed by |
|---|---|
| force-directed hairball | LAW 2 (layered), LAW 4 (zones), LAW 9 (node ceiling) |
| rainbow / HSL hue-rotation palette | LAW 7 (OKLCH, fixed L) |
| decorative gradients and shadows | LAW 10 |
| inconsistent arrowheads | LAW 3, fixed edge grammar |
| the same line style meaning different things in different regions | fixed edge grammar |
| spaghetti routing | LAW 2 (orthogonal + crossing minimisation) |
| colour encoding category *and* state at once | LAW 7 (alert hue reserved for state) |
| back edges drawn through the layer stack | LAW 6 |
