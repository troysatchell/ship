#!/usr/bin/env python3
"""
from_depcruise.py — dependency-cruiser JSON -> a system-graph model to edit.

    npx depcruise src --no-config --output-type json > deps.json
    python3 from_depcruise.py deps.json --root src > model.yaml
    # then EDIT model.yaml — see below — and:
    python3 build.py model.yaml -o architecture.html

**This produces a draft, not an answer.** The dependency graph is ground truth;
the *kinds* are guesses from filename patterns, and it prints every guess to
stderr so you can correct them. A module the tool calls `module` may really be
your auth gate or your public API, and that distinction is most of what makes
the diagram worth looking at.

What is derived mechanically (trust it):
  * nodes, edges, and circular-dependency membership
  * zones from directory structure
  * fan-in / fan-out / instability (computed later by analyze.py)
  * lines of code

What is guessed (check it):
  * every node's `kind`
  * which modules are entry points vs. public surface
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict

# Filename patterns -> code-vocabulary kind. Deliberately conservative: anything
# that does not clearly match something else is a plain `module`.
PATTERNS = [
    (r"(^|/)(index|main|app|server|cli|bin)\.[jt]sx?$", "entrypoint"),
    (r"(valid|guard|auth|permission|policy|assert|check|sanitiz|middleware)", "guard"),
    (r"(cache|store|db|database|repositor|registry|session|state|options|config|settings)", "datastore"),
    (r"(router|route|dispatch|orchestr|schedul|factory|container|create|registry)", "orchestrator"),
    (r"(api|client|endpoint|controller|handler|resolver)", "api"),
    (r"(util|helper|lib|common|shared)/", "module"),
]


def guess_kind(path):
    p = path.lower()
    for rx, kind in PATTERNS:
        if re.search(rx, p):
            return kind
    return "module"


def ident(path, root):
    rel = path[len(root):].lstrip("/") if path.startswith(root) else path
    return re.sub(r"[^a-z0-9]+", "_", os.path.splitext(rel)[0].lower()).strip("_")


def label(path):
    """`core/index.ts` is not called "index" by anyone who works on it."""
    base = os.path.splitext(os.path.basename(path))[0]
    if base in ("index", "main", "mod", "__init__"):
        parent = os.path.basename(os.path.dirname(path))
        return parent or base
    return base


def zone_of(path, root, depth):
    rel = path[len(root):].lstrip("/") if path.startswith(root) else path
    parts = rel.split("/")[:-1]
    return "/".join(parts[:depth]) if parts else "root"


def loc(path):
    try:
        with open(path, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("deps_json")
    ap.add_argument("--root", default="src", help="source root prefix to strip")
    ap.add_argument("--zone-depth", type=int, default=1)
    ap.add_argument("--title", default=None)
    ap.add_argument("--source", default="", help="repo @ commit, for the header")
    ap.add_argument("--repo-url", default="",
                    help="e.g. https://github.com/org/repo — makes every node's "
                         "source ref a clickable link in the artifact")
    ap.add_argument("--branch", default="main")
    args = ap.parse_args()

    data = json.load(open(args.deps_json))
    root = args.root.rstrip("/")

    mods = [m for m in data["modules"]
            if m["source"].startswith(root + "/") and not m.get("coreModule")]
    keep = {m["source"] for m in mods}

    zones, nodes, edges = {}, [], []
    inbound = defaultdict(int)
    for m in mods:
        for d in m.get("dependencies", []):
            if d["resolved"] in keep:
                inbound[d["resolved"]] += 1

    for m in mods:
        src = m["source"]
        z = zone_of(src, root, args.zone_depth) or "root"
        zones.setdefault(z, {"id": re.sub(r"[^a-z0-9]+", "_", z), "label": z})
        kind = guess_kind(src)
        # nothing imports it and it looks like a barrel -> it is the surface,
        # not an entry point. Nothing imports it and it is not -> entry point.
        if inbound[src] == 0 and kind == "entrypoint" and src.count("/") == 1:
            kind = "api"
        nodes.append({
            "id": ident(src, root), "label": label(src), "kind": kind,
            "zone": zones[z]["id"], "subtitle": src,
            "sources": [src],
            "metrics": {"loc": loc(src)},
        })

    seen = set()
    for m in mods:
        a = ident(m["source"], root)
        for d in m.get("dependencies", []):
            if d["resolved"] not in keep:
                continue
            b = ident(d["resolved"], root)
            if a == b or (a, b) in seen:
                continue
            seen.add((a, b))
            edges.append({"id": f"{a}__{b}", "from": a, "to": b, "kind": "flow"})

    # ---- emit YAML by hand: no dependency, and the comments matter ---------
    out = []
    out.append("# Draft model generated by from_depcruise.py.")
    out.append("# The graph is ground truth. The `kind:` values are GUESSES — fix them.")
    out.append("")
    out.append("meta:")
    out.append(f"  title: {json.dumps(args.title or root)}")
    out.append('  subtitle: "Module dependency graph"')
    out.append(f"  source: {json.dumps(args.source)}")
    if args.repo_url:
        out.append(f"  repoUrl: {json.dumps(args.repo_url)}")
        out.append(f"  branch: {json.dumps(args.branch)}")
    out.append("  profile: code")
    out.append("")
    out.append("zones:")
    for z in zones.values():
        out.append(f"  - {{id: {z['id']}, label: {json.dumps(z['label'])}}}")
    out.append("")
    out.append("nodes:")
    for n in nodes:
        out.append(f"  - id: {n['id']}")
        out.append(f"    label: {json.dumps(n['label'])}")
        out.append(f"    kind: {n['kind']}")
        out.append(f"    zone: {n['zone']}")
        out.append(f"    subtitle: {json.dumps(n['subtitle'])}")
        out.append(f"    sources: [{json.dumps(n['sources'][0])}]")
        if n["metrics"]["loc"]:
            out.append(f"    metrics: {{loc: {n['metrics']['loc']}}}")
    out.append("")
    out.append("edges:")
    for e in edges:
        out.append(f"  - {{id: {e['id']}, from: {e['from']}, to: {e['to']}, kind: flow}}")
    print("\n".join(out))

    by_kind = defaultdict(list)
    for n in nodes:
        by_kind[n["kind"]].append(n["label"])
    print(f"\nfrom_depcruise: {len(nodes)} modules, {len(edges)} edges, "
          f"{len(zones)} zones", file=sys.stderr)
    print("from_depcruise: GUESSED kinds — check every one:", file=sys.stderr)
    for k in sorted(by_kind):
        print(f"  {k:13s} {', '.join(sorted(by_kind[k]))}", file=sys.stderr)
    if len(nodes) > 30:
        print(f"\nfrom_depcruise: {len(nodes)} nodes exceeds the ~30 readable "
              "ceiling. Raise --zone-depth, or run on a subdirectory and link "
              "the diagrams.", file=sys.stderr)


if __name__ == "__main__":
    main()
