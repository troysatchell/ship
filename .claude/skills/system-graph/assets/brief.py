#!/usr/bin/env python3
"""
brief.py — analysed model -> markdown brief.

The handoff format: everything the diagram knows, as prose an LLM or a
colleague can read with zero project context. The artifact's "Copy brief"
button produces the same document client-side; this is the build-time twin.

    python3 brief.py model.yaml            # to stdout
    python3 build.py model.yaml --brief out.md
"""
from __future__ import annotations

import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from analyze import analyze, load_model      # noqa: E402


def _flat(s):
    return " ".join(str(s).split())


def brief(model):
    code = model.get("meta", {}).get("profile") == "code"
    nodes = {n["id"]: n for n in model["nodes"]}
    zones = {z["id"]: z for z in model.get("zones", [])}
    L = []
    meta = model.get("meta", {})
    L.append(f"# {meta.get('title', 'System graph')}")
    sub = " · ".join(x for x in (meta.get("subtitle"), meta.get("source"),
                                 f"profile: {meta.get('profile', 'process')}") if x)
    if sub:
        L.append(sub)
    a = model.get("_analysis", {})
    L += ["", f"{a.get('nodeCount', len(nodes))} "
          f"{'modules' if code else 'stages'} · {a.get('edgeCount', '?')} "
          f"connections · {len(model.get('loops', []))} "
          f"{'cycles' if code else 'loops'} · "
          f"{len(model.get('findings', []))} open questions", ""]

    L.append(f"## {'Modules' if code else 'Stages'}")
    by_zone = {}
    for n in model["nodes"]:
        by_zone.setdefault(n.get("zone", ""), []).append(n)
    for z, ns in by_zone.items():
        if z in zones:
            L += ["", f"### {zones[z].get('label', z)}"]
        for n in ns:
            m = n.get("metrics", {})
            bits = " · ".join(x for x in (
                n.get("subtitle"),
                (f"fan-in {m['fanIn']}, fan-out {m['fanOut']}"
                 + (f", instability {m['instability']}"
                    if m.get("instability") is not None else ""))
                if m.get("fanIn") is not None else None,
                f"{m['loc']} loc" if m.get("loc") else None,
                f"emits: {', '.join(n['emits'])}" if n.get("emits") else None,
                f"consumes: {', '.join(n['consumes'])}" if n.get("consumes") else None,
            ) if x)
            L.append(f"- **{n['label']}** [{n.get('kindLabel', n['kind'])}]"
                     + (f" — {bits}" if bits else ""))
            if n.get("detail"):
                L.append(f"  {_flat(n['detail'])}")
            if n.get("sources"):
                L.append("  source: " + ", ".join(
                    x["path"] + (f"·{x['symbol']}" if x.get("symbol") else "")
                    for x in n["sources"]))

    L += ["", "## Connections"]
    for e in model["edges"]:
        al = nodes.get(e["from"], {}).get("label", e["from"])
        bl = nodes.get(e["to"], {}).get("label", e["to"])
        tags = [x for x in (
            e.get("kind") if e.get("kind") != "flow" else None,
            e.get("label"),
            f"polarity {e['polarity']}" if e.get("polarity") else None,
            f"loop {e['loop']}" if e.get("loop") else None,
            "inferred" if e.get("confidence") == "heuristic" else None) if x]
        pre = "MISSING LINK (modelled absence): " if e.get("kind") == "gap" else ""
        L.append(f"- {pre}{al} → {bl}" + (f" ({', '.join(tags)})" if tags else ""))
        if e.get("kind") == "gap" and e.get("note"):
            L.append(f"  {_flat(e['note'])}")

    if model.get("loops"):
        L += ["", f"## {'Cycles' if code else 'Loops'}"]
        for l in model["loops"]:
            L.append(f"- **{l['id']}** ({l['type']}): "
                     + " → ".join(nodes.get(m, {}).get("label", m)
                                  for m in l["members"]))
            if l.get("note"):
                L.append(f"  {_flat(l['note'])}")

    if model.get("findings"):
        L += ["", "## Open questions (analyzer findings)"]
        for f in model["findings"]:
            L.append(f"- [{f['severity']}] **{f['title']}**")
            if f.get("detail"):
                L.append(f"  {_flat(f['detail'])}")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    print(brief(analyze(load_model(sys.argv[1]))), end="")
