# Loops, recursion, and gaps

What `analyze.py` computes, why each check exists, and how to read the results.

---

## How loops are derived

**A loop is a back edge plus the forward path it closes.**

The obvious alternative — run Tarjan's algorithm and call each strongly connected
component a loop — fails badly on real systems. In any factory with one feedback
edge from operations back to intake, nearly every stage lands in one giant SCC.
That is mathematically correct and completely useless: it tells you "everything is
in a cycle" and nothing about which cycle.

So instead: every edge marked `feedback` or `recursion` is a declared back edge. For
each one, BFS the forward-only graph from its target back to its source. That path,
plus the back edge, is the loop. The author's own statement of "this returns" is the
right anchor, because it is a claim about intent, not just topology.

SCCs are still computed — but on the **forward** graph only, where any cycle found
is one nobody declared. Those are reported separately as `undeclared-cycle`, which
is usually an accidental circular dependency rather than intentional iteration.

That distinction is the whole point: *intentional iteration and accidental circular
dependency are the same shape and opposite things.* Marking one as `feedback` is how
you tell them apart, and the analyzer holds you to it.

## How loops are classified

Causal-loop-diagram convention. Each link carries a polarity: `+` (same direction —
more of A means more of B) or `-` (opposite — more of A means less of B).

- If **every** edge in the loop has a polarity, count the negatives. Odd → balancing
  (`B`, cyan). Even → reinforcing (`R`, amber). This is the formal parity rule.
- If only the back edge is labelled, use it: a corrective return (`-`) is balancing,
  an amplifying return (`+`) is reinforcing. Pragmatic shorthand, and right in
  practice for software pipelines.
- If nothing is labelled, the loop is `unlabelled` and you get a low-severity
  finding telling you to label it.

**Balancing** loops seek a goal and settle. A failing test sending work back to
implementation converges: eventually the tests pass. **Reinforcing** loops compound.
Incidents creating remediation work that displaces quality work that causes more
incidents is a reinforcing loop, and it does not settle on its own.

A factory diagram whose loops are all `R` is describing a system that is
accelerating in some direction. That is worth knowing before you optimise anything
in it.

---

## The gap checks

Grounded in workflow-net soundness (van der Aalst): *option to complete, proper
completion, no dead transitions*, plus deadlock and livelock. Each check is the
software-pipeline translation of one soundness property.

Checks are **profile-gated**. A leaf utility module with no outbound dependency is
perfectly healthy; a pipeline stage that produces nothing is a bug. Same graph
shape, opposite verdicts — so the process-soundness checks only run under
`profile: process`, and the coupling checks only under `profile: code`. Running the
wrong set is how you get twenty confident findings that are all noise.

### Process profile

| finding | severity | soundness property | what it means |
|---|---|---|---|
| `unreachable` | medium | no dead transitions | nothing upstream leads here. Dead stage, out-of-band trigger, or a missing edge. |
| `dead-end` | high | option to complete | a non-release stage with no outgoing edge. Work that arrives can never reach release. |
| `gate-cannot-reject` | high | — | a gate with no feedback or error path out. A gate that can only pass is not a gate. |
| `no-failure-path` | medium | — | transforms whose every outgoing edge is a success edge. Where does failure go? |
| `ungated-path` | high | — | a path from intake to release crossing zero gates. A hotfix lane, or an escape hatch nobody meant to leave open. |
| `unbounded-loop` | high | livelock | a loop with no forward edge leaving it and no release inside it. Which stage decides to stop retrying? |
| `loop-never-releases` | medium | option to complete | the loop has exits, but none reach a release stage. |
| `dangling-feedback` | high | — | an edge marked feedback whose target has no forward path back to its source. It closes no loop. Either the forward path is missing from the model, or it is not really feedback. |
| `undeclared-cycle` | high | — | a cycle in the forward graph. Probably an accidental circular dependency; it makes build order, failure order, and reasoning order all ambiguous. |
| `unsatisfied-input` | high | deadlock | something is `consume`d that nothing `emit`s. This stage waits on input that will not arrive — or the producer is outside the boundary and should be drawn as an external node. |
| `unconsumed-output` | medium | proper completion | something is `emit`ted that nothing consumes. A real deliverable, or a downstream stage that was deleted while its producer kept running. |
| `open-loop` | high | — | the model has no feedback edge at all. A factory with no feedback cannot learn: nothing observed at release re-enters intake. |
| `unlabelled-loop` | low | — | a loop with no polarities, so it cannot be classified as convergent or compounding. |

### Both profiles

| finding | severity | what it means |
|---|---|---|
| `unreachable` | medium | nothing leads here from any entry point. Dead code, an out-of-band trigger, or a missing edge. |
| `undeclared-cycle` | high | a cycle in the forward graph. Under `code` this is worded as a circular dependency — it makes build order, initialisation order and test isolation ambiguous, and none of the members can be understood or extracted alone. |
| `dangling-feedback` | high | an edge marked feedback whose target has no forward path back to its source. It closes no loop. |
| `unsatisfied-input` / `unconsumed-output` | high / medium | producer/consumer name correlation over `emits:`/`consumes:`. |

### Code profile

| finding | severity | what it means |
|---|---|---|
| `god-module` | high | fan-in ≥4 **and** fan-out ≥4 with a combined degree ≥9. Simultaneously hard to change (many dependents) and hard to keep stable (many dependencies) — the classic shape of a module that absorbed responsibilities belonging elsewhere. Split it along the two directions of coupling. |
| `hub-module` | medium | fan-out ≥8. Knows about most of the codebase, so almost any change elsewhere can break it and reading it means holding the whole system in your head. Usually one coordinator plus collaborators that could be injected rather than imported. |
| `oversized-module` | high/med | ≥400 lines **and** ≥4× the median module size (high at ≥8×). Size alone is not a defect, but a module this far off the distribution is almost always several modules that were never separated. |
| `fragile-core` | high | instability near 0 (many dependents, few dependencies) combined with high churn. Martin's "zone of pain": every change ripples through everything downstream. |
| `layer-violations` | high | edges explicitly marked `kind: violation`. A layering contract violated in practice is a preference, not a contract — enforce it in CI or redraw the layers to match reality. |
| `unreferenced-modules` | medium | three or more modules with zero inbound dependencies that are not marked as entry points. Dead-code candidates; confirm with knip / vulture / `go vet` before deleting. |

## Reading findings honestly

Findings are **claims about the model**, not about the system. A false positive
almost always means the model is incomplete, and that is itself the finding:

> `unsatisfied-input: nothing produces "shaped-spec"`

Either the producer genuinely does not exist, or you did not model it. Both are
worth ten minutes. Fix the model and rerun. **Do not delete the check.**

The two that most often surface something real:

- **`gate-cannot-reject`** — teams discover a gate that has quietly become a
  waypoint. Everyone believes it is quality control; nothing has failed it in a year.
- **`open-loop` / a missing `gap` edge from telemetry back to intake** — the most
  common structural defect in a software factory. Work flows out, signal comes back
  to a dashboard, and no path exists from that signal to how the next piece of work
  is shaped. The factory ships continuously and learns nothing.

## Adding a check

Add it in the gap-detection block of `analyze.py` via `add(kind, severity, title,
nodes, detail)`. Two requirements:

1. **State the rule it enforces**, not just the observation. "Every gate must have a
   reject path" beats "this node has one outgoing edge".
2. **Say what to do about it** in `detail`. A finding the reader cannot act on is
   noise, and noise trains people to ignore the panel.
