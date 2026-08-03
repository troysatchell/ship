#!/usr/bin/env python3
"""
analyze.py — turn a system model into an *analysed* model.

This is the step that makes the artifact say something the reader could not
already see. It computes, mechanically:

  * strongly connected components (Tarjan)  -> where the recursion actually is
  * loop classification (reinforcing / balancing, CLD convention)
  * fan-in / fan-out / instability (Martin's I = Ce/(Ca+Ce))
  * reachability from entry points
  * structural GAPS, using workflow-net soundness as the checklist:
        option to complete, proper completion, no dead transitions,
        no deadlock (consumer with no producer), no livelock (loop with no exit)

Everything it emits is a *claim with a reason*. Nothing is decorative.

Usage:
    python3 analyze.py model.yaml            # print findings report
    python3 analyze.py model.yaml --json     # emit the analysed model
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict

TERMINAL_KINDS = {"release"}
ENTRY_KINDS = {"intake"}

# Two vocabularies, one grammar. A codebase and a delivery pipeline are the same
# kind of object — things that receive, do work, check, hold state, hand off, and
# route — so they share the seven silhouettes. Only the words change, and the card
# keeps whichever word the author actually wrote.
KIND_ALIASES = {
    # code-architecture vocabulary
    "entrypoint": "intake", "entry": "intake", "handler": "intake",
    "cli": "intake", "webhook": "intake", "listener": "intake",
    "module": "transform", "service": "transform", "component": "transform",
    "package": "transform", "library": "transform", "worker": "transform",
    "guard": "gate", "policy": "gate", "validator": "gate", "middleware": "gate",
    "auth": "gate", "check": "gate",
    "datastore": "store", "database": "store", "db": "store", "cache": "store",
    "repository": "store", "queue": "store", "bucket": "store",
    "api": "release", "endpoint": "release", "publisher": "release",
    "artifact": "release", "sink": "release",
    "orchestrator": "control", "router": "control", "scheduler": "control",
    "dispatcher": "control", "container": "control",
    "vendor": "external", "thirdparty": "external", "dependency": "external",
    "upstream": "external",
}
CANONICAL_KINDS = {"intake", "transform", "gate", "store", "release",
                   "control", "external"}
ERROR_HINTS = ("error", "fail", "retry", "dlq", "dead-letter", "dead letter",
               "rollback", "revert", "fallback", "exception", "quarantine",
               "escalat", "alert", "incident")

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}


# --------------------------------------------------------------------- helpers

def load_model(path):
    text = open(path, "r", encoding="utf-8").read()
    if path.endswith((".yaml", ".yml")):
        import yaml
        return yaml.safe_load(text)
    return json.loads(text)


def _structural_edges(edges):
    """Edges that actually move work forward. `gap` edges are proposals, not fact."""
    return [e for e in edges if e.get("kind") != "gap"]


def tarjan_scc(node_ids, edges):
    """Iterative Tarjan. Returns list of components (lists of node ids)."""
    adj = defaultdict(list)
    for e in edges:
        if e["from"] in node_ids and e["to"] in node_ids:
            adj[e["from"]].append(e["to"])

    index = {}
    low = {}
    on_stack = {}
    stack = []
    result = []
    counter = [0]

    for root in node_ids:
        if root in index:
            continue
        work = [(root, iter(adj[root]))]
        index[root] = low[root] = counter[0]
        counter[0] += 1
        stack.append(root)
        on_stack[root] = True
        while work:
            v, it = work[-1]
            advanced = False
            for w in it:
                if w not in index:
                    index[w] = low[w] = counter[0]
                    counter[0] += 1
                    stack.append(w)
                    on_stack[w] = True
                    work.append((w, iter(adj[w])))
                    advanced = True
                    break
                elif on_stack.get(w):
                    low[v] = min(low[v], index[w])
            if advanced:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[v])
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop()
                    on_stack[w] = False
                    comp.append(w)
                    if w == v:
                        break
                result.append(comp)
    return result


def reachable(starts, edges, node_ids):
    adj = defaultdict(list)
    for e in edges:
        adj[e["from"]].append(e["to"])
    seen, frontier = set(starts), list(starts)
    while frontier:
        v = frontier.pop()
        for w in adj[v]:
            if w not in seen and w in node_ids:
                seen.add(w)
                frontier.append(w)
    return seen


def looks_like_error_handling(node):
    blob = " ".join(str(node.get(k, "")) for k in
                    ("label", "subtitle", "id", "detail")).lower()
    return any(h in blob for h in ERROR_HINTS)


# -------------------------------------------------------------------- analysis

def analyze(model):
    nodes = model.get("nodes", [])
    edges = model.get("edges", [])
    by_id = {n["id"]: n for n in nodes}
    ids = set(by_id)

    for e in edges:
        for side in ("from", "to"):
            if e.get(side) not in ids:
                raise SystemExit(
                    f"analyze: edge {e.get('id', '?')} references unknown node "
                    f"'{e.get(side)}'")

    # ---- resolve the kind vocabulary ----------------------------------------
    used_alias = False
    for n in nodes:
        raw = (n.get("kind") or "transform").strip().lower()
        n["kindLabel"] = n.get("kindLabel") or raw
        if raw in CANONICAL_KINDS:
            n["kind"] = raw
        elif raw in KIND_ALIASES:
            n["kind"] = KIND_ALIASES[raw]
            used_alias = True
        else:
            raise SystemExit(
                f"analyze: node '{n['id']}' has unknown kind '{raw}'. "
                f"Use one of {sorted(CANONICAL_KINDS)} or an alias "
                f"({', '.join(sorted(KIND_ALIASES)[:8])}, …)")
    # ---- normalize source anchors -------------------------------------------
    # A node's `sources` is what makes the graph a *surface to answer from*
    # rather than a summary to trust: every claim a card makes can be checked
    # by clicking through to the code it describes.
    for n in nodes:
        raw_src = n.get("sources") or []
        if isinstance(raw_src, (str, dict)):
            raw_src = [raw_src]
        norm = []
        for srcv in raw_src:
            if isinstance(srcv, str):
                norm.append({"path": srcv})
            elif isinstance(srcv, dict) and srcv.get("path"):
                keep = {k: srcv[k] for k in ("path", "symbol", "lines", "note")
                        if srcv.get(k) is not None}
                norm.append(keep)
        n["sources"] = norm

    meta = model.setdefault("meta", {})
    if not meta.get("profile"):
        meta["profile"] = "code" if used_alias else "process"
    profile = meta["profile"]

    struct = _structural_edges(edges)
    forward = [e for e in struct if e.get("kind") not in ("feedback", "recursion")]

    # ---- degree + instability ------------------------------------------------
    fan_in = defaultdict(int)
    fan_out = defaultdict(int)
    for e in struct:
        fan_out[e["from"]] += 1
        fan_in[e["to"]] += 1
    for n in nodes:
        ca, ce = fan_in[n["id"]], fan_out[n["id"]]
        m = n.setdefault("metrics", {})
        m.setdefault("fanIn", ca)
        m.setdefault("fanOut", ce)
        m["instability"] = round(ce / (ca + ce), 2) if (ca + ce) else None

    # ---- loops ---------------------------------------------------------------
    # A loop is a BACK EDGE plus the forward path it closes. Deriving loops this
    # way (rather than from raw SCCs) is what keeps them readable: in a real
    # factory almost every node ends up in one giant SCC, which tells you
    # nothing. The back edge is the author's own statement of "this returns", so
    # it is the right anchor.
    back = [e for e in struct
            if e.get("kind") in ("feedback", "recursion") or e.get("loop")]
    fwd = [e for e in struct if e not in back]
    fadj = defaultdict(list)
    for e in fwd:
        fadj[e["from"]].append(e)

    def shortest_path(src, dst):
        if src == dst:
            return [src]
        prev, q = {src: None}, [src]
        while q:
            nxt = []
            for v in q:
                for e in fadj[v]:
                    w = e["to"]
                    if w in prev:
                        continue
                    prev[w] = v
                    if w == dst:
                        path, cur = [], dst
                        while cur is not None:
                            path.append(cur)
                            cur = prev[cur]
                        return list(reversed(path))
                    nxt.append(w)
            q = nxt
        return None

    declared = {l["id"]: l for l in model.get("loops", [])}
    loops, open_backs, auto = [], [], {"B": 0, "R": 0, "L": 0}
    for e in back:
        path = shortest_path(e["to"], e["from"])
        if path is None:
            open_backs.append(e)
            continue
        members = path if path[0] != path[-1] or len(path) > 1 else [e["from"]]
        pedges = [e]
        for a, b in zip(members, members[1:]):
            pedges += [x for x in fadj[a] if x["to"] == b][:1]
        pols = [x.get("polarity") for x in pedges]
        if all(p is not None for p in pols):
            neg = sum(1 for p in pols if p in ("-", "o", "opposite"))
            ltype = "balancing" if neg % 2 else "reinforcing"
        elif e.get("polarity") in ("-", "o", "opposite"):
            ltype = "balancing"          # a corrective return path
        elif e.get("polarity") in ("+", "s", "same"):
            ltype = "reinforcing"        # an amplifying return path
        else:
            ltype = "unlabelled"
        pre = declared.get(e.get("loop"))
        if e.get("loop"):
            lid = e["loop"]
        else:
            pfx = {"balancing": "B", "reinforcing": "R"}.get(ltype, "L")
            auto[pfx] += 1
            lid = f"{pfx}{auto[pfx]}"
            e["loop"] = lid
        loops.append({
            "id": lid,
            "type": (pre or {}).get("type", ltype),
            "label": (pre or {}).get("label",
                      " → ".join(by_id[m]["label"] for m in members[:3])
                      + ("…" if len(members) > 3 else "")),
            "members": members,
            "edges": [x.get("id") for x in pedges],
            "note": (pre or {}).get("note"),
            "derived": pre is None,
        })
    loops.sort(key=lambda l: (l["type"] != "balancing", l["id"]))
    model["loops"] = loops
    loop_nodes = {m for l in loops for m in l["members"]}
    for n in nodes:
        if n["id"] in loop_nodes:
            n["scc"] = 1

    # Undeclared cycles in the FORWARD graph are a different animal: nobody
    # meant them, and they are usually an accidental circular dependency.
    self_looped = {e["from"] for e in fwd if e["from"] == e["to"]}
    stray_sccs = [c for c in tarjan_scc(list(ids), fwd)
                  if len(c) > 1 or c[0] in self_looped]

    # ---- reachability --------------------------------------------------------
    entries = [n["id"] for n in nodes
               if n.get("kind") in ENTRY_KINDS or fan_in[n["id"]] == 0]
    reach = reachable(entries, struct, ids)

    # ---- gap detection -------------------------------------------------------
    findings = list(model.get("findings", []))
    seen_keys = {(f.get("kind"), tuple(f.get("nodes", []))) for f in findings}

    def add(kind, severity, title, nodes_, detail):
        key = (kind, tuple(nodes_))
        if key in seen_keys:
            return
        seen_keys.add(key)
        findings.append({"id": f"auto-{len(findings) + 1}", "kind": kind,
                         "severity": severity, "title": title,
                         "nodes": list(nodes_), "detail": detail,
                         "derived": True})

    # A leaf utility module with no outbound dependency is perfectly healthy; a
    # pipeline stage that produces nothing is a bug. Same graph shape, opposite
    # verdicts — so the process-soundness checks only run on the process profile.
    process = profile != "code"

    # 1. dead transition / unreachable
    for n in nodes:
        if n["id"] not in reach and n.get("kind") != "external":
            add("unreachable", "medium",
                f"“{n['label']}” is not reachable from any entry point",
                [n["id"]],
                ("Nothing in the graph imports or calls this, directly or "
                 "transitively, from any entry point. Dead code candidate — "
                 "confirm with a reachability tool before deleting."
                 if profile == "code" else
                 "Workflow-net soundness requires every transition to be fireable "
                 "from the initial state. Nothing upstream leads here, so this "
                 "stage is either dead, triggered out-of-band, or the diagram is "
                 "missing an edge."))

    # 2. dead end / no option to complete            [process profile only]
    for n in nodes:
        if not process or n.get("kind") in ("external",) or n["id"] not in reach:
            continue
        if fan_out[n["id"]] == 0 and n.get("kind") not in TERMINAL_KINDS:
            add("dead-end", "high",
                f"“{n['label']}” produces nothing downstream",
                [n["id"]],
                "Option to complete is violated: work that arrives here can never "
                "reach a release stage. Either this stage is a hidden terminal "
                "(mark it kind: release) or its output edge is missing.")

    # 3. a gate that can only pass, never reject
    for n in nodes:
        if not process or n.get("kind") != "gate" or n["id"] not in reach:
            continue
        outs = [e for e in struct if e["from"] == n["id"]]
        if not outs:
            continue
        rejects = any(e.get("kind") in ("feedback", "recursion")
                      or looks_like_error_handling(by_id[e["to"]])
                      or looks_like_error_handling(e) for e in outs)
        if not rejects:
            add("gate-cannot-reject", "high",
                f"“{n['label']}” is a gate with no reject path",
                [n["id"]],
                "A gate that has no way to send work back is not a gate, it is a "
                "waypoint. Either it always passes (delete it, or stop counting "
                "it as quality control) or the reject path exists in practice and "
                "is missing from the model.")

    # 3b. a transform whose failure has nowhere to go
    silent = [n["id"] for n in nodes
              if process and n.get("kind") == "transform" and n["id"] in reach
              and [e for e in struct if e["from"] == n["id"]]
              and not any(e.get("kind") in ("feedback", "recursion")
                          or looks_like_error_handling(by_id[e["to"]])
                          or looks_like_error_handling(e)
                          for e in struct if e["from"] == n["id"])]
    if silent:
        add("no-failure-path", "medium",
            f"{len(silent)} stage(s) model only the happy path",
            silent,
            "Every outgoing edge from these stages is a success edge: "
            + ", ".join(by_id[i]["label"] for i in silent) +
            ". What happens when each of them fails? Unmodelled failure paths "
            "are where real factories silently drop work.")

    # 4. no quality gate between intake and release
    gate_ids = {n["id"] for n in nodes if n.get("kind") == "gate"}
    if process and gate_ids:
        no_gate = reachable(entries,
                            [e for e in forward if e["to"] not in gate_ids], ids)
        for n in nodes:
            if n.get("kind") == "release" and n["id"] in no_gate:
                add("ungated-path", "high",
                    f"There is a path to “{n['label']}” that passes no gate",
                    [n["id"]],
                    "Work can reach release without crossing any verification "
                    "stage. Trace the ungated path and decide whether it is "
                    "intentional (a hotfix lane) or an escape hatch nobody meant "
                    "to leave open.")

    # 5. livelock: a loop work can enter but not leave
    terminals = {n["id"] for n in nodes if n.get("kind") in TERMINAL_KINDS}
    for l in loops:
        if not process:
            break
        comp = set(l["members"])
        if comp & terminals:
            continue          # work can complete inside this loop; not a trap
        exits = [e for e in fwd if e["from"] in comp and e["to"] not in comp]
        if not exits:
            add("unbounded-loop", "high",
                f"Loop {l['id']} has no exit",
                l["members"],
                "No forward edge leaves this loop. Work that enters can never "
                "leave it — the structural signature of a livelock or a missing "
                "termination condition. Which stage decides to stop retrying?")
        elif terminals and not (reachable([e["to"] for e in exits], fwd, ids)
                                & terminals):
            add("loop-never-releases", "medium",
                f"Loop {l['id']} never reaches a release stage",
                l["members"],
                "The loop has exits, but none of them lead to a release stage. "
                "Work leaves the loop and then stalls.")

    # 5b. a declared return path that closes no cycle
    for e in open_backs:
        add("dangling-feedback", "high",
            f"“{by_id[e['from']]['label']} → {by_id[e['to']]['label']}” "
            "returns to a stage that never leads back",
            [e["from"], e["to"]],
            "This edge is drawn as feedback, but there is no forward path from "
            "its target back to its source, so it does not close a loop. Either "
            "the forward path is missing from the model, or this is not really "
            "feedback.")

    # 5c. cycles nobody declared
    for comp in stray_sccs:
        add("undeclared-cycle", "high",
            ("Circular dependency: " if profile == "code" else "Undeclared cycle: ")
            + " → ".join(by_id[c]["label"] for c in comp[:4]),
            comp,
            ("These modules import each other in a cycle. Nothing here is marked "
             "as intentional feedback, so this is a circular dependency: it makes "
             "build order, initialisation order, and test isolation all ambiguous, "
             "and it means none of these modules can be understood — or "
             "extracted — on its own."
             if profile == "code" else
             "These stages depend on each other in a cycle that is not marked as "
             "feedback. Intentional iteration is drawn as a feedback edge; an "
             "undeclared cycle is usually an accidental circular dependency, and "
             "it makes the build order, the failure order, and the reasoning "
             "order all ambiguous."))

    # 6. producer/consumer name correlation
    emits, consumes = defaultdict(list), defaultdict(list)
    for n in nodes:
        for name in n.get("emits", []) or []:
            emits[name].append(n["id"])
        for name in n.get("consumes", []) or []:
            consumes[name].append(n["id"])

    # Every matched producer/consumer pair IS a data edge. Synthesise it rather
    # than making the author write the same fact twice; the data lens is only
    # worth having if it is populated automatically.
    existing = {(e["from"], e["to"]) for e in edges}
    for name in sorted(set(emits) & set(consumes)):
        for src in emits[name]:
            for dst in consumes[name]:
                if src == dst:
                    continue
                edges.append({
                    "id": f"d-{name}-{src}-{dst}",
                    "from": src, "to": dst, "kind": "data", "label": name,
                    "views": ["data"], "derived": True,
                    "confidence": "resolved" if (src, dst) in existing
                                  else "heuristic",
                    "note": f"“{name}” is emitted by {by_id[src]['label']} and "
                            f"consumed by {by_id[dst]['label']}.",
                })
    for name, producers in emits.items():
        if name not in consumes:
            add("unconsumed-output", "medium",
                f"Nothing consumes “{name}”",
                producers,
                f"“{name}” is produced but never read. Either it is a genuine "
                "external deliverable, or a downstream stage was removed and the "
                "producer was left running.")
    for name, readers in consumes.items():
        if name not in emits:
            add("unsatisfied-input", "high",
                f"Nothing produces “{name}”",
                readers,
                f"“{name}” is consumed but never produced anywhere in the model. "
                "That is a deadlock signature: this stage waits on input that "
                "will not arrive (or the producer lives outside the modelled "
                "boundary and should be drawn as an external node).")

    # 7. open loop: releases with no feedback path back toward intake
    fb = [e for e in struct if e.get("kind") in ("feedback", "recursion")]
    if process and terminals and not fb:
        add("open-loop", "high",
            "The factory has no feedback path at all",
            sorted(terminals),
            "Every edge points forward. A factory with no feedback edge cannot "
            "learn: nothing observed at release re-enters intake. If feedback "
            "happens out-of-band (a human reading a dashboard), draw it — an "
            "informal loop is still a loop, and drawing it is how you find out "
            "it has no owner.")

    # 8. unlabelled loop polarity
    for l in loops:
        if l["type"] == "unlabelled":
            add("unlabelled-loop", "low",
                f"Loop {l['id']} has no polarity labels",
                l["members"],
                "Without per-edge polarity (+/-) the loop cannot be classified as "
                "reinforcing or balancing, so the reader cannot tell whether it "
                "converges or runs away. Add `polarity` to each edge in the loop.")

    # ---- 9. code-architecture checks ----------------------------------------
    # These read the same graph through a coupling lens rather than a process
    # lens. They only fire on the code profile, because "many things depend on
    # this and it depends on many things" is a smell in a module and a perfectly
    # ordinary fact about a pipeline stage.
    if profile == "code":
        locs = sorted(n["metrics"]["loc"] for n in nodes
                      if (n.get("metrics") or {}).get("loc"))
        median = locs[len(locs) // 2] if len(locs) >= 5 else None

        for n in nodes:
            m = n.get("metrics", {})
            ca, ce = m.get("fanIn", 0), m.get("fanOut", 0)
            if n.get("kind") == "external":
                continue

            if median and m.get("loc"):
                ratio = m["loc"] / max(median, 1)
                if m["loc"] >= 400 and ratio >= 4:
                    add("oversized-module", "high" if ratio >= 8 else "medium",
                        f"“{n['label']}” is {int(ratio)}× the median module size",
                        [n["id"]],
                        f"{m['loc']} lines against a median of {median}. Size on "
                        "its own is not a defect, but a module this far off the "
                        "distribution is almost always several modules that were "
                        "never separated — and it is the hardest place in the "
                        "codebase to change safely, review, or test in isolation.")

            if ce >= 8:
                add("hub-module", "medium",
                    f"“{n['label']}” reaches into {ce} other modules",
                    [n["id"]],
                    f"Fan-out of {ce}, instability {m.get('instability')}. This "
                    "module knows about most of the codebase, so almost any "
                    "change elsewhere can break it, and reading it requires "
                    "holding the whole system in your head. Look for a seam: "
                    "usually a hub like this is one coordinator plus several "
                    "collaborators that could be injected instead of imported.")

            if n.get("kind") == "control":
                continue
            if ca >= 4 and ce >= 4 and (ca + ce) >= 9:
                add("god-module", "high",
                    f"“{n['label']}” is coupled in both directions",
                    [n["id"]],
                    f"{ca} modules depend on it and it depends on {ce} others. It "
                    "is simultaneously hard to change (many dependents) and hard "
                    "to keep stable (many dependencies). This is the classic shape "
                    "of a module that has absorbed responsibilities that belong "
                    "elsewhere — split it along the two directions of coupling.")
            elif ca >= 6 and ce <= 1 and (m.get("churn") or 0) >= 20:
                add("fragile-core", "high",
                    f"“{n['label']}” is depended on heavily and changes often",
                    [n["id"]],
                    f"Instability {m.get('instability')} — {ca} modules depend on "
                    f"it — yet it has {m['churn']} commits. Martin's \"zone of "
                    "pain\": every change here ripples through everything "
                    "downstream. Either stabilise it behind an interface, or "
                    "accept that its change rate is the change rate of the whole "
                    "system.")

        viol = [e for e in struct if e.get("kind") == "violation"]
        if viol:
            add("layer-violations", "high",
                f"{len(viol)} dependency edge(s) break a stated layer rule",
                sorted({e["from"] for e in viol} | {e["to"] for e in viol}),
                "; ".join(f"{by_id[e['from']]['label']} → {by_id[e['to']]['label']}"
                          for e in viol[:6]) +
                ". A layering contract that is violated in practice is not a "
                "contract, it is a preference. Either enforce it in CI "
                "(import-linter, dependency-cruiser, ArchUnit) or redraw the "
                "layers to match what the code actually does.")

        leaves = [n["id"] for n in nodes
                  if n.get("kind") not in ("external", "release")
                  and n["id"] in reach
                  and (n.get("metrics", {}).get("fanIn") or 0) == 0
                  and n.get("kind") != "intake"]
        if len(leaves) >= 3:
            add("unreferenced-modules", "medium",
                f"{len(leaves)} module(s) have no inbound dependency",
                leaves,
                "Nothing imports " + ", ".join(by_id[i]["label"] for i in leaves[:8])
                + ". Each is either an entry point that should be marked as one, "
                "or dead code. Confirm with a reachability tool (knip, vulture, "
                "`go vet`) before deleting.")

    findings.sort(key=lambda f: (SEVERITY_ORDER.get(f.get("severity"), 3),
                                 f.get("kind", "")))
    model["findings"] = findings
    model["_analysis"] = {
        "nodeCount": len(nodes), "edgeCount": len(edges),
        "loopCount": len(loops), "findingCount": len(findings),
        "unreachable": sorted(ids - reach),
    }
    return model


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    m = analyze(load_model(sys.argv[1]))
    if "--json" in sys.argv:
        print(json.dumps(m, indent=2))
    else:
        a = m["_analysis"]
        print(f"{a['nodeCount']} nodes · {a['edgeCount']} edges · "
              f"{a['loopCount']} loops · {a['findingCount']} findings\n")
        for l in m["loops"]:
            print(f"  [{l['type']:11s}] {l['id']}: {l['label']}")
        print()
        for f in m["findings"]:
            print(f"  ({f['severity']:6s}) {f['kind']:20s} {f['title']}")
