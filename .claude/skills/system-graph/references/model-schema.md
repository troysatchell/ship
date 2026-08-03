# Model schema

YAML or JSON. `examples/software-factory.yaml` is a complete working example.

```yaml
meta:
  title: string            # header
  subtitle: string         # one line of context
  source: string           # repo @ commit — say where this came from
  profile: code|process    # optional; inferred from the kind vocabulary you use.
                           # switches the panel wording and which checks run.
  repoUrl: https://github.com/org/repo   # optional; makes every source ref a
  branch: main                           # clickable link (GitHub/GitLab style)

zones:                     # optional but strongly recommended (LAW 4)
  - id: build
    label: Build
    accent: transform      # any node kind; tints the zone's top rule
    note: string           # one line, shown under the zone label

nodes:
  - id: impl                    # required, unique, referenced by edges
    label: Implementation       # required, ~24 chars before it clips
    kind: transform             # required. canonical: intake|transform|gate|store|
                                #   release|control|external
                                # or a code alias: module, service, component,
                                #   entrypoint, handler, guard, policy, validator,
                                #   datastore, cache, repository, queue, api,
                                #   endpoint, orchestrator, router, vendor, …
    zone: build                 # optional
    subtitle: Agent fleet       # optional, ~34 chars
    detail: |                   # optional, shown in the inspector — use it
      Prose. This is where the nuance lives: why this stage exists, what it
      assumes, what breaks it.
    emits:    [changeset]       # names this stage produces (queue/topic/table/artifact)
    consumes: [approved-plan]   # names this stage requires
    owner: string               # optional
    sources:                    # optional but what makes the node CHECKABLE:
      - src/core/engine.ts      #   plain path, or
      - path: src/core/engine.ts
        symbol: RetryLoop       #   optional symbol name
        lines: [120, 184]       #   optional range -> deep link #L120-L184
        note: the retry loop    #   optional one-liner
    views: [flow, structure]    # optional; default = wherever it has edges
    metrics:                    # optional; fanIn/fanOut/instability are computed
      loc: 2400
      churn: 31

edges:
  - id: e05                     # optional but makes diffs readable
    from: planreview
    to: impl
    kind: flow                  # flow|control|data|feedback|recursion|violation|gap
    label: approved             # short; long labels are clipped
    polarity: '-'               # REQUIRED on feedback/recursion: + amplifies, - corrects
    loop: B2                    # optional; auto-assigned if omitted
    confidence: heuristic       # mark inferred edges. default: resolved
    note: string                # shown on hover / in the inspector
    views: [flow]               # optional; default by kind

loops:                          # optional — derived automatically. Declare only to
  - id: B1                      # override the label or type of a specific loop.
    type: balancing             # balancing|reinforcing
    label: Test-fix cycle
    note: string

findings:                       # optional — derived automatically. Add your own for
  - id: manual-1                # anything the analyzer cannot see.
    severity: high              # high|medium|low
    kind: some-slug
    title: One sentence
    nodes: [review]
    detail: Why it matters, and what to check.

views:                          # optional; defaults to flow / structure / data
  - id: flow
    label: Flow
    blurb: How work moves, and where it comes back around.
    direction: RIGHT            # RIGHT|DOWN|LEFT|UP
    layoutOptions: {}           # raw ELK options; setting this disables the
                                # aspect-ratio search for this view
```

## Kind vocabulary

The canonical seven are `intake`, `transform`, `gate`, `store`, `release`,
`control`, `external`. Every alias resolves to one of them:

| canonical | aliases |
|---|---|
| `intake` | entrypoint, entry, handler, cli, webhook, listener |
| `transform` | module, service, component, package, library, worker |
| `gate` | guard, policy, validator, middleware, auth, check |
| `store` | datastore, database, db, cache, repository, queue, bucket |
| `release` | api, endpoint, publisher, artifact, sink |
| `control` | orchestrator, router, scheduler, dispatcher, container |
| `external` | vendor, thirdparty, dependency, upstream |

The card and inspector show the word you wrote; the layout and analysis use the
canonical kind. Using any code alias sets `meta.profile: code` automatically, which
switches the panel wording and swaps the process-soundness checks for coupling
checks. An unknown kind is a hard error, not a silent default.

## Rules that are not optional

**Every node has a `kind`.** Canonical or alias — nothing else parses. If nothing
fits, it is a `transform`/`module` with a clearer subtitle.

**Backwards edges are `feedback`, never `flow`.** A `flow` edge that points upstream
gets swept into cycle-breaking by the layout engine and reads as a forward
dependency. This is the failure mode the whole design exists to prevent.

**Feedback edges carry `polarity`.** `-` means the return corrects (a failing test
sending work back — the loop converges). `+` means it amplifies (an incident
creating more backlog which creates more incidents — the loop compounds). Without
polarity the analyzer cannot classify the loop and the reader cannot tell a
self-correcting system from a runaway one.

**Use `kind: gap` liberally.** A gap edge draws a link that *should* exist and does
not. This is the single highest-leverage thing the format does — a missing feedback
path is invisible in every other diagramming tool, because absence has no syntax.
Here it does.

**Fill in `emits`/`consumes` for anything queue-, topic-, table-, or file-shaped.**
That is what lets the analyzer report "nothing produces X" (a deadlock signature)
and "nothing consumes Y" (an orphaned output). Names must match exactly across
nodes — that is the point.

**Anchor nodes with `sources`.** A card without a source ref is a summary the
reader must trust; a card with one is a claim the reader can check. The
depcruise extractor fills these automatically; hand-written models should name
at least the primary file per node. With `meta.repoUrl` set they become deep
links in the inspector.

**Mark inferred edges `confidence: heuristic`.** Especially cross-service calls
matched by route/topic string rather than resolved by a type checker.

## Sizing

Nodes are a fixed 216px wide, 60px tall (76px with a subtitle). Uniform width is
deliberate: it produces clean columns and makes the layout engine's job tractable.
Labels clip rather than wrap — if a label does not fit, it is too long for a
diagram, and the detail belongs in `detail:`.

## Validation

`analyze.py` hard-fails on an edge referencing an unknown node id. `build.py` hard-
fails if the generated palette misses a WCAG threshold, or if no view contains any
node. Everything else is a finding, not an error.
