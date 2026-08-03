# Repository → model

The goal is a model derived from **evidence**, with the parts that are guesses
marked as guesses. Work cheapest-first; stop as soon as you can answer the question
the diagram is for.

---

## Step 1 — Config mining (minutes, always do it)

The repository already describes its own component boundaries. Read that before
reading any code.

| file | tells you |
|---|---|
| `pnpm-workspace.yaml`, `package.json#workspaces`, `nx.json`, `turbo.json` | JS/TS package boundaries; `turbo.json` `tasks[].dependsOn` encodes build-order dependency |
| `Cargo.toml [workspace] members`, `go.work` | Rust / Go module boundaries |
| `docker-compose.yml` | **runtime** service topology, `depends_on`, shared networks — often the best single artifact in the repo |
| `k8s/*.yaml` | Deployments, Services, Ingress; `NetworkPolicy` approximates allowed edges |
| `*.tf` | `terraform graph \| dot -Tsvg` gives the infra dependency graph for free |
| `.github/workflows/*.yml` | the actual CI pipeline: stages, gates, triggers, what blocks what |
| `Dockerfile` per directory | one image ≈ one deployable component |

For Nx workspaces, `nx graph --file=graph.json` is a real dependency graph, not a
heuristic — use it directly.

Map: one component → one node. One directory group or deployable → one zone.

## Step 2 — Size and churn (minutes, language-agnostic)

```bash
scc --by-file --format json ./src > loc.json        # or: tokei --output json
git log --since="12 months ago" --name-only --pretty=format:'==%H==' \
  | awk '/^==/{next} NF{print}' | sort | uniq -c | sort -rn | head -40
```

Feeds `metrics.loc` / `metrics.churn`, and tells you which components deserve
detail. Co-change pairs (two files that always change together despite no import
between them) reveal hidden coupling no static tool sees — model those as `data`
edges with `confidence: heuristic`.

## Step 3 — Dependency extraction (per ecosystem)

**JS/TS** — there is a converter for this one:
```bash
npx depcruise src --no-config --output-type json > deps.json
python3 assets/from_depcruise.py deps.json --root src --zone-depth 1 > model.yaml
```
It derives nodes, edges, zones and LOC mechanically, **guesses every `kind` from
filename patterns**, and prints each guess to stderr so you can correct it. Correct
them — that step is most of the value. Other useful commands:

```bash
npx depcruise src --output-type json > deps.json    # modules[].dependencies[], .circular, .orphan
npx depcruise src --output-type err-html > report.html
npx skott --displayMode=webapp                       # newer alternative
npx knip                                             # unused files/exports/deps
```
Cycle rule: `{ "name": "no-circular", "from": {}, "to": { "circular": true } }`.
Orphan rule: `{ "name": "no-orphans", "from": { "orphan": true }, "to": {} }`.

**Python**
```bash
pip install pydeps import-linter
pydeps mypackage --show-cycles --max-bacon 2
lint-imports                                         # reads .importlinter / pyproject.toml
```
`import-linter` contract types map straight onto model concepts: `layers` →
architectural ordering (violations become `kind: violation` edges), `forbidden` →
a specific banned edge, `independence` → sibling isolation.

**Go**
```bash
go list -json ./...        # ImportPath, Imports, Deps — the compiler's own resolution
go mod graph
```

**Rust**
```bash
cargo modules dependencies --package mycrate --layout dot --acyclic
cargo tree -i <pkg>        # inverse: who depends on this
```

**JVM**
```bash
jdeps -v -R -cp 'lib/*' myapp.jar
```
ArchUnit `layeredArchitecture()` is the Java equivalent of `import-linter` layers.

**Anything else** — tree-sitter grammars give you a uniform AST-query mechanism for
import and call extraction in any language with a grammar.

## Step 4 — Call graphs, only where you need them

Expensive and imprecise in dynamic languages. Run only on the components the
diagram's question actually concerns.

- JS/TS: `jelly` (pointer-analysis based, research-grade), `scip-typescript`
- Python: `pyan3`, `code2flow`
- Cross-language: SCIP indexes (`scip-typescript`, `scip-python`, `scip-java`)
  reuse the language server's own resolution — the most accurate mechanical
  reference graph available without writing an analyzer.

## Step 5 — What tools cannot see

These require reading code, and they are usually where the interesting part of the
diagram lives:

- **Cross-service calls by string** — an HTTP client hitting a route that only
  exists in another service's router table. No static tool spans that boundary.
  Extract route strings from both sides and correlate by name.
- **Event/queue topology** — publishers and subscribers registered by topic name at
  runtime. Same correlation approach; this is exactly what `emits`/`consumes` is for.
- **DI / plugin dispatch** — Spring beans, FastAPI dependencies, plugin registries.
- **Human steps** — approvals, on-call, manual QA. They are part of the factory and
  they are usually the bottleneck. They appear in no dependency graph.
- **Feedback loops** — often entirely informal ("someone looks at the dashboard and
  files a ticket"). Draw them anyway. An informal loop is still a loop, and drawing
  it is how you discover it has no owner.

### Structured reading protocol

When no tooling exists, do not free-read. Run the same algorithm the tools do:

1. Enumerate files mechanically (glob), not by asking the model what exists.
2. Read one file at a time into a fixed record:
   `{file, exports, imports, calls_out, reads_from, writes_to, has_error_handling}`.
3. Resolve relative import paths against the file list by string matching.
4. Correlate — producer/consumer matching, fan-in/fan-out counting — as data
   operations over the collected records. Do not ask the model to hold the graph
   in its head.
5. Tag every string-matched edge `confidence: heuristic`.
6. Batch by directory, so each read is grounded in a coherent module.

## Step 5b — A worked example

`examples/codebase-architecture.yaml` is `sindresorhus/got` (25 modules, real
dependency-cruiser output, kinds corrected by hand). Its header records the exact
commands used. It is the shape a code model should end up in — and the findings it
produces (`options` coupled in both directions at 3,732 lines; `core` reaching into
13 modules) are real observations about that library, not synthetic examples.

## Step 6 — Assemble

- Component → node. Pick `kind` by what it *does*, not by what language it is in.
- Directory group / deployable / pipeline phase → zone.
- Import or call → `flow` edge. Queue/table/file access → `data` edge.
  Scheduler/trigger → `control` edge.
- Circular import (undeclared) → keep as `flow`; the analyzer will flag it as an
  undeclared cycle, which is the correct framing.
- Retry / rework / rejection path → `feedback` with `polarity: '-'`.
- Escalation that creates more work upstream → `feedback` with `polarity: '+'`.
- Layer-contract violation → `kind: violation`.
- Anything outside the boundary → `kind: external`. Draw them. An implicit boundary
  is an unexamined boundary.
- Every link you expected and did not find → `kind: gap`.

## Step 7 — Weight the nodes

From Martin's package metrics, computed automatically by `analyze.py`:

- fan-in (Ca), fan-out (Ce)
- instability `I = Ce / (Ca + Ce)` — 0 means everything depends on it and it depends
  on nothing (hard to change safely); 1 means it depends on everything and nothing
  depends on it (safe to change, expected to churn).

A node with I near 0 that also has high churn is the highest-risk thing in the
repository. Worth a manual finding.
