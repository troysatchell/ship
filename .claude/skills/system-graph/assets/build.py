#!/usr/bin/env python3
"""
build.py — factory model -> self-contained interactive artifact.

    python3 build.py model.yaml -o artifact.html [--d2 model.d2] [--open]

Pipeline
    1. load + validate the model
    2. analyze.py: SCCs, loop classification, metrics, structural gap findings
    3. per-view ELK layered layout (build time, via layout.mjs + elkjs)
    4. feedback-lane routing (feedback edges are routed OUTSIDE the layer stack,
       never through it — see references/design-system.md, LAW 6)
    5. emit one HTML file: baked geometry + design tokens + ~12kB vanilla JS.
       No CDN, no runtime graph library, no build step to view it.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from analyze import analyze, load_model          # noqa: E402
from palette import build as build_tokens, validate as validate_tokens  # noqa: E402

ELKJS_VERSION = "elkjs@0.9.3"

# ------------------------------------------------------------------ geometry
CARD_W = 216
CARD_H = 60
CARD_H_SUB = 76
ZONE_PAD = 26
ZONE_HEAD = 34

# A 20:1 sliver and a 1:20 column are both unreadable on a screen. Rather than
# guess, we lay the graph out several ways at build time and keep the one whose
# aspect ratio is closest to a comfortable viewport. Measurement, not hope.
TARGET_RATIO = 1.55
LAYOUT_CANDIDATES = [
    ("linear", {}),
    ("wrap-multi", {"elk.layered.wrapping.strategy": "MULTI_EDGE",
                    "elk.layered.wrapping.additionalEdgeSpacing": "40",
                    "elk.layered.wrapping.correctionFactor": "1.1"}),
    ("wrap-single", {"elk.layered.wrapping.strategy": "SINGLE_EDGE",
                     "elk.layered.wrapping.additionalEdgeSpacing": "36"}),
    ("column", {"elk.direction": "DOWN"}),
    ("column-tight", {"elk.direction": "DOWN",
                      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
                      "elk.layered.mergeEdges": "true",
                      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
                      "elk.spacing.nodeNode": "32"}),
    ("linear-merged", {"elk.layered.mergeEdges": "true",
                       "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX"}),
]

# Purchase et al.: edge crossings are the strongest measured predictor of how
# well a human can read a graph — well ahead of symmetry or grid alignment. So
# the layout search scores crossings FIRST and shape second, rather than picking
# a pretty rectangle full of spaghetti.
CROSSING_WEIGHT = 1.0
LENGTH_WEIGHT = 0.5    # long detour routes are what makes a graph *feel* like
                       # spaghetti even when the crossing count is tolerable
SHAPE_WEIGHT = 0.45
ZONE_DROP_MARGIN = 0.30   # only discard grouping for a decisive (>30%) win

DEFAULT_EDGE_VIEWS = {
    "flow":      ["structure", "flow"],
    "control":   ["structure", "flow"],
    "feedback":  ["flow"],
    "recursion": ["flow", "structure"],
    "data":      ["data"],
    "violation": ["structure", "flow"],
    "gap":       ["flow"],
}
DEFAULT_VIEWS = [
    {"id": "flow",      "label": "Flow",      "direction": "RIGHT",
     "blurb": "How work moves, and where it comes back around."},
    {"id": "structure", "label": "Structure", "direction": "RIGHT",
     "blurb": "What the parts are, what contains what, what depends on what."},
    {"id": "data",      "label": "Data",      "direction": "RIGHT",
     "blurb": "What each stage consumes and emits, and where state settles."},
]

ELK_BASE = {
    "elk.algorithm": "layered",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.layered.layering.strategy": "NETWORK_SIMPLEX",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.nodePlacement.bk.edgeStraightening": "IMPROVE_STRAIGHTNESS",
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    "elk.layered.crossingMinimization.semiInteractive": "true",
    "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
    "elk.layered.mergeEdges": "false",
    "elk.spacing.nodeNode": "40",
    "elk.spacing.edgeNode": "36",
    "elk.spacing.edgeEdge": "16",
    "elk.layered.spacing.nodeNodeBetweenLayers": "96",
    "elk.layered.spacing.edgeNodeBetweenLayers": "32",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "16",
    "elk.padding": "[top=40,left=32,bottom=40,right=32]",
    "elk.separateConnectedComponents": "true",
    "elk.spacing.componentComponent": "56",
    "elk.aspectRatio": "1.55",
}


# ------------------------------------------------------------------- helpers

def die(msg):
    print(f"build: {msg}", file=sys.stderr)
    sys.exit(1)


def card_height(node):
    return CARD_H_SUB if node.get("subtitle") else CARD_H


def edge_views(edge):
    if edge.get("views"):
        return edge["views"]
    return DEFAULT_EDGE_VIEWS.get(edge.get("kind", "flow"), ["flow"])


def ensure_elkjs():
    """Return the NODE_PATH that has elkjs, installing it on demand."""
    cache = os.path.join(os.path.expanduser("~"), ".cache", "system-graph")
    mod = os.path.join(cache, "node_modules")
    if os.path.isdir(os.path.join(mod, "elkjs")):
        return mod
    if shutil.which("npm") is None:
        die("node/npm are required for layout. Install Node 18+ and retry.")
    os.makedirs(cache, exist_ok=True)
    print(f"build: installing {ELKJS_VERSION} into {cache} (one time)…",
          file=sys.stderr)
    r = subprocess.run(["npm", "install", "--no-save", "--silent",
                        "--prefix", cache, ELKJS_VERSION],
                       capture_output=True, text=True)
    if r.returncode != 0:
        die("npm install elkjs failed:\n" + r.stderr[-2000:])
    return mod


def run_layout(graphs):
    node_path = ensure_elkjs()
    env = dict(os.environ)
    env["NODE_PATH"] = node_path + os.pathsep + env.get("NODE_PATH", "")
    script = os.path.join(HERE, "layout.mjs")
    # elkjs is an ESM import; resolve it from the cache dir by running there.
    with tempfile.TemporaryDirectory() as td:
        local = os.path.join(td, "layout.mjs")
        shutil.copy(script, local)
        os.symlink(node_path, os.path.join(td, "node_modules"))
        r = subprocess.run(["node", local], input=json.dumps(graphs),
                           capture_output=True, text=True, env=env, cwd=td)
    if r.returncode != 0:
        die("layout failed:\n" + r.stderr[-3000:])
    return json.loads(r.stdout)


# ------------------------------------------------------------- graph building

def build_view_graph(model, view, use_zones=True):
    """Assemble the ELK input for one view. Feedback/recursion/gap edges are
    deliberately EXCLUDED so the layered pass sees a clean DAG; they are routed
    afterwards into dedicated lanes outside the node band."""
    vid = view["id"]
    nodes = {n["id"]: n for n in model["nodes"]}
    edges = [e for e in model["edges"] if vid in edge_views(e)]

    routed = [e for e in edges
              if e.get("kind") not in ("feedback", "recursion", "gap")
              and e["from"] != e["to"]]
    laned = [e for e in edges if e not in routed]

    present = set()
    for e in edges:
        present.add(e["from"])
        present.add(e["to"])
    for n in model["nodes"]:
        if n.get("views") and vid in n["views"]:
            present.add(n["id"])
    if not present:
        present = set(nodes)

    zones = {z["id"]: z for z in model.get("zones", [])} if use_zones else {}
    used_zones = {nodes[i].get("zone") for i in present} & set(zones)

    children = []
    zone_children = {z: [] for z in used_zones}
    for nid in sorted(present):
        n = nodes[nid]
        item = {"id": nid, "width": CARD_W, "height": card_height(n)}
        z = n.get("zone")
        if z in zone_children:
            zone_children[z].append(item)
        else:
            children.append(item)
    for z in sorted(used_zones):
        children.append({
            "id": f"__zone__{z}",
            "children": zone_children[z],
            "layoutOptions": {
                "elk.padding":
                    f"[top={ZONE_PAD + ZONE_HEAD},left={ZONE_PAD},"
                    f"bottom={ZONE_PAD},right={ZONE_PAD}]",
                "elk.spacing.nodeNode": "36",
                "elk.layered.spacing.nodeNodeBetweenLayers": "88",
            },
        })

    graph = {
        "id": "root",
        "layoutOptions": dict(ELK_BASE, **{
            "elk.direction": view.get("direction", "RIGHT"),
            **view.get("layoutOptions", {}),
        }),
        "children": children,
        "edges": [{"id": e.get("id") or f"{e['from']}->{e['to']}",
                   "sources": [e["from"]], "targets": [e["to"]]}
                  for e in routed
                  if e["from"] in present and e["to"] in present],
    }
    return graph, present, routed, laned


def _segments(paths):
    segs = []
    for pts in paths:
        for a, b in zip(pts, pts[1:]):
            if a != b:
                segs.append((a, b))
    return segs


def count_crossings(paths, cap=40000):
    """Pairwise segment intersections across all routed edges.

    Not a perfect crossing count — collinear overlaps and shared endpoints are
    excluded, and an edge that grazes another at a bend can be double-counted —
    but it is a faithful *relative* measure, which is all the layout search needs.
    """
    segs = _segments(paths)
    if len(segs) * len(segs) > cap * 4:
        segs = segs[:int(cap ** 0.5) * 2]

    def orient(p, q, r):
        v = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1])
        return 0 if abs(v) < 1e-9 else (1 if v > 0 else 2)

    n = 0
    for i in range(len(segs)):
        p1, q1 = segs[i]
        for j in range(i + 1, len(segs)):
            p2, q2 = segs[j]
            if p1 in (p2, q2) or q1 in (p2, q2):
                continue          # shared endpoint: a join, not a crossing
            o1, o2 = orient(p1, q1, p2), orient(p1, q1, q2)
            o3, o4 = orient(p2, q2, p1), orient(p2, q2, q1)
            if o1 != o2 and o3 != o4 and 0 not in (o1, o2, o3, o4):
                n += 1
    return n


def absolutise(laid):
    """Flatten ELK's nested coordinates to one absolute space.

    Two separate conventions have to be reconciled here:
      * a node's x/y is relative to its PARENT;
      * an edge's points are relative to the LEAST COMMON ANCESTOR of its
        endpoints — which, under hierarchyHandling=INCLUDE_CHILDREN, is *not*
        the node the edge is listed under. Getting this wrong silently draws
        intra-container edges hundreds of pixels away from the boxes they
        connect, which looks like "the layout engine is broken" and is not.
    """
    out_nodes, out_zones, origin, parent = {}, {}, {"root": (0, 0)}, {}

    def walk(node, ox, oy):
        for c in node.get("children", []) or []:
            x, y = ox + c.get("x", 0), oy + c.get("y", 0)
            rec = {"x": x, "y": y, "w": c.get("width", 0), "h": c.get("height", 0)}
            parent[c["id"]] = node["id"]
            origin[c["id"]] = (x, y)
            (out_zones if c["id"].startswith("__zone__") else out_nodes)[
                c["id"][8:] if c["id"].startswith("__zone__") else c["id"]] = rec
            walk(c, x, y)
    walk(laid, 0, 0)

    def chain(nid):
        out = []
        while nid in parent:
            nid = parent[nid]
            out.append(nid)
        return out

    def lca_origin(a, b):
        ca, cb = chain(a), set(chain(b))
        for anc in ca:
            if anc in cb:
                return origin.get(anc, (0, 0))
        return (0, 0)

    acc = {}

    def edges_of(node):
        for e in node.get("edges", []) or []:
            src = (e.get("sources") or [None])[0]
            tgt = (e.get("targets") or [None])[0]
            ox, oy = lca_origin(src, tgt) if src and tgt else (0, 0)
            pts = []
            for s in e.get("sections", []) or []:
                p = [(s["startPoint"]["x"], s["startPoint"]["y"])]
                p += [(b["x"], b["y"]) for b in s.get("bendPoints", []) or []]
                p.append((s["endPoint"]["x"], s["endPoint"]["y"]))
                pts += [(x + ox, y + oy) for x, y in p]
            acc[e["id"]] = pts
        for c in node.get("children", []) or []:
            edges_of(c)
    edges_of(laid)
    return out_nodes, out_zones, acc


def _border_point(r, tx, ty):
    """Where the ray from r's centre toward (tx,ty) leaves r's box."""
    cx, cy = r["x"] + r["w"] / 2, r["y"] + r["h"] / 2
    dx, dy = tx - cx, ty - cy
    if dx == 0 and dy == 0:
        return cx, cy
    sx = (r["w"] / 2 + 6) / abs(dx) if dx else float("inf")
    sy = (r["h"] / 2 + 6) / abs(dy) if dy else float("inf")
    s = min(sx, sy)
    return cx + dx * s, cy + dy * s


def _bezier_samples(p0, c1, c2, p3, n=28):
    out = []
    for i in range(n + 1):
        t = i / n
        mt = 1 - t
        out.append((mt**3 * p0[0] + 3 * mt**2 * t * c1[0]
                    + 3 * mt * t**2 * c2[0] + t**3 * p3[0],
                    mt**3 * p0[1] + 3 * mt**2 * t * c1[1]
                    + 3 * mt * t**2 * c2[1] + t**3 * p3[1]))
    return out


def _poly_samples(pts, step=26.0):
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        d = ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5
        for i in range(1, int(d // step) + 1):
            t = i * step / d
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    out.append(pts[-1])
    return out


def _overlap_cost(samples, pos, skip, pad=10):
    """How many sampled points sit inside somebody's card. The thing the user
    actually complains about is 'the yellow line runs over my boxes' — so that
    is the thing we count."""
    hits = 0
    for x, y in samples:
        for nid, r in pos.items():
            if nid in skip:
                continue
            if (r["x"] - pad <= x <= r["x"] + r["w"] + pad
                    and r["y"] - pad <= y <= r["y"] + r["h"] + pad):
                hits += 1
                break
    return hits


def route_returns(laned, pos, bounds):
    """Route feedback / recursion / gap edges without running over the graph.

    LAW 6 says a return path must leave the layer stack. HOW it leaves is now
    decided per edge, by measurement, from these candidates:

      * four local arcs   — two bow depths × two sides
      * two channel routes — orthogonal, around the TOP or BOTTOM perimeter of
        the whole graph, in stacked lanes so channels never overlap each other

    Each candidate is sampled and scored by how many points land on top of a
    node card (weighted heavily) plus its length (weighted lightly). Short
    returns between neighbours keep their tight local arc; a long return across
    a wrapped layout gets walked around the outside instead of slicing through
    every row — which is exactly the failure mode dense real-world factories
    exposed. Same rule as the layout search: measure, don't hope.
    """
    routes = {}
    lanes = {"top": [], "bottom": []}     # occupied x-intervals per channel lane
    CH_GAP, CH_BASE = 30, 46

    def lane_for(side, lo, hi):
        for i, iv in enumerate(lanes[side]):
            if all(hi + 44 < s or lo - 44 > t for s, t in iv):
                iv.append((lo, hi))
                return i
        lanes[side].append([(lo, hi)])
        return len(lanes[side]) - 1

    ordered = sorted(
        laned, key=lambda e: abs(pos.get(e["to"], {}).get("x", 0)
                                 - pos.get(e["from"], {}).get("x", 0)))
    for e in ordered:
        a, b = pos.get(e["from"]), pos.get(e["to"])
        if not a or not b:
            continue
        eid = e.get("id") or f"{e['from']}->{e['to']}"
        skip = {e["from"], e["to"]}
        if e["from"] == e["to"]:                        # direct recursion
            cx, cy = a["x"] + a["w"] / 2, a["y"]
            routes[eid] = {"kind": "self",
                           "points": [(cx - 30, cy), (cx - 30, cy - 38),
                                      (cx + 30, cy - 38), (cx + 30, cy)],
                           "label": (cx, cy - 44)}
            continue

        acx, acy = a["x"] + a["w"] / 2, a["y"] + a["h"] / 2
        bcx, bcy = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
        p0 = _border_point(a, bcx, bcy)
        p3 = _border_point(b, acx, acy)
        vx, vy = p3[0] - p0[0], p3[1] - p0[1]
        dist = (vx * vx + vy * vy) ** 0.5 or 1
        nxv, nyv = -vy / dist, vx / dist

        cands = []
        for depth in (0.26, 0.5):
            bow = min(190.0, max(48.0, dist * depth))
            for sign in (1, -1):
                c1 = (p0[0] + vx * .28 + nxv * bow * sign,
                      p0[1] + vy * .28 + nyv * bow * sign)
                c2 = (p0[0] + vx * .72 + nxv * bow * sign,
                      p0[1] + vy * .72 + nyv * bow * sign)
                s = _bezier_samples(p0, c1, c2, p3)
                cands.append({
                    "kind": "arc", "points": [p0, c1, c2, p3],
                    "label": s[len(s) // 2],
                    "cost": _overlap_cost(s, pos, skip) * 120 + dist * 0.06,
                })

        sx, tx = acx, bcx
        for side in ("top", "bottom"):
            if side == "top":
                ey0, ey1 = a["y"], b["y"]
                ch = bounds["minY"] - CH_BASE - len(lanes["top"]) * CH_GAP
            else:
                ey0, ey1 = a["y"] + a["h"], b["y"] + b["h"]
                ch = bounds["maxY"] + CH_BASE + len(lanes["bottom"]) * CH_GAP
            pts = [(sx, ey0), (sx, ch), (tx, ch), (tx, ey1)]
            s = _poly_samples(pts)
            # channel itself is outside the graph; only the two risers can hit
            cands.append({
                "kind": "channel", "side": side, "points": pts,
                "label": ((sx + tx) / 2, ch),
                "cost": _overlap_cost(s, pos, skip) * 120
                        + (abs(ey0 - ch) + abs(tx - sx) + abs(ey1 - ch)) * 0.06
                        + 40,   # mild constant: prefer a clean local arc
            })

        win = min(cands, key=lambda c: c["cost"])
        if win["kind"] == "channel":
            side = win["side"]
            lo, hi = min(sx, tx), max(sx, tx)
            li = lane_for(side, lo, hi)
            ch = (bounds["minY"] - CH_BASE - li * CH_GAP if side == "top"
                  else bounds["maxY"] + CH_BASE + li * CH_GAP)
            ey0 = a["y"] if side == "top" else a["y"] + a["h"]
            ey1 = b["y"] if side == "top" else b["y"] + b["h"]
            win["points"] = [(sx, ey0), (sx, ch), (tx, ch), (tx, ey1)]
            win["label"] = ((sx + tx) / 2, ch)
        routes[eid] = {k: win[k] for k in ("kind", "points", "label")}

    ext = {"top": (len(lanes["top"]) * CH_GAP + CH_BASE + 20)
                  if lanes["top"] else 0,
           "bottom": (len(lanes["bottom"]) * CH_GAP + CH_BASE + 20)
                     if lanes["bottom"] else 0}
    return routes, ext


# ------------------------------------------------------------------ the scene

def pick_layouts(model, views):
    """Lay each view out several ways, keep the best-shaped result."""
    trials, meta = {}, {}
    has_zones = bool(model.get("zones"))
    for v in views:
        g, present, routed, laned = build_view_graph(model, v)
        if not g["children"]:
            continue
        # A lens with nothing to show is not a lens. Drop it rather than
        # rendering a field of disconnected boxes.
        if not g["edges"] and not laned and not any(
                n.get("views") and v["id"] in n["views"] for n in model["nodes"]):
            continue
        meta[v["id"]] = (v, present, routed, laned)
        cands = ([("fixed", {})] if v.get("layoutOptions")
                 else LAYOUT_CANDIDATES if len(present) > 6
                 else [("linear", {}), ("column", {"elk.direction": "DOWN"})])
        variants = [("zoned", g)]
        if has_zones and not v.get("layoutOptions"):
            # Enclosure only helps when the grouping matches the structure.
            # Directory-based zones over a dependency graph often fight the
            # layering and force long detour routes — so try it both ways and
            # let the measurement decide.
            variants.append(("flat", build_view_graph(model, v, use_zones=False)[0]))
        for vk, base in variants:
            for name, extra in cands:
                gg = json.loads(json.dumps(base))
                gg["layoutOptions"].update(extra)
                trials[f"{v['id']}::{vk}::{name}"] = gg
    if not trials:
        die("no view contains any node — check `views` on nodes/edges")

    laid = run_layout(trials)
    scored = {}
    for key, out in laid.items():
        vid, vk, name = key.split("::")
        w = max(out.get("width") or 1, 1)
        h = max(out.get("height") or 1, 1)
        _n, _z, epaths = absolutise(out)
        edge_n = max(len(epaths), 1)
        crossings = count_crossings(list(epaths.values()))
        total_len = sum(
            sum(((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5
                for a, b in zip(pts, pts[1:]))
            for pts in epaths.values())
        shape = abs(math.log((w / h) / TARGET_RATIO))
        if name == "linear":
            shape *= 0.75      # wrapping costs the reader a serpentine scan;
                               # only pay it when it buys a real shape improvement
        scored.setdefault(vid, []).append(
            {"name": name, "zones": vk == "zoned", "out": out,
             "x": crossings / edge_n, "len": total_len / edge_n, "shape": shape,
             "crossings": crossings})

    best, chosen, flattened = {}, {}, {}
    for vid, cands in scored.items():
        worst_x = max(c["x"] for c in cands) or 1
        worst_l = max(c["len"] for c in cands) or 1
        for c in cands:
            c["score"] = (CROSSING_WEIGHT * (c["x"] / worst_x)
                          + LENGTH_WEIGHT * (c["len"] / worst_l)
                          + SHAPE_WEIGHT * c["shape"])
        zoned = [c for c in cands if c["zones"]]
        win = min(cands, key=lambda c: c["score"])
        # Zones are worth keeping unless dropping them is a decisive win.
        if not win["zones"] and zoned:
            bz = min(zoned, key=lambda c: c["score"])
            if bz["score"] <= win["score"] / (1 - ZONE_DROP_MARGIN):
                win = bz
        best[vid] = win["out"]
        flattened[vid] = not win["zones"]
        chosen[vid] = (f"{win['name']}{'' if win['zones'] else ', zones flattened'}"
                       f" — {win['crossings']} crossings, "
                       f"{win['len']:.0f}px mean edge")
    return best, meta, chosen, flattened


def build_scene(model):
    views = model.get("views") or DEFAULT_VIEWS
    laid_all, meta, chosen, flattened = pick_layouts(model, views)
    for vid, name in chosen.items():
        print(f"build: view '{vid}' laid out as {name}", file=sys.stderr)
    if any(flattened.values()) and model.get("zones"):
        print("build: NOTE — zones were flattened in "
              f"{', '.join(v for v, f in flattened.items() if f)}: the grouping "
              "did not match the dependency structure and was forcing long "
              "detour routes. Consider zones that follow layers rather than "
              "directories.", file=sys.stderr)

    scene_views = {}
    for vid, laid in laid_all.items():
        v, present, routed, laned = meta[vid]
        pos, zones, epaths = absolutise(laid)
        xs = [p["x"] for p in pos.values()] + [z["x"] for z in zones.values()]
        ys = [p["y"] for p in pos.values()] + [z["y"] for z in zones.values()]
        x2 = [p["x"] + p["w"] for p in pos.values()] + \
             [z["x"] + z["w"] for z in zones.values()]
        y2 = [p["y"] + p["h"] for p in pos.values()] + \
             [z["y"] + z["h"] for z in zones.values()]
        bounds = {"minX": min(xs), "minY": min(ys),
                  "maxX": max(x2), "maxY": max(y2)}
        lanes, ext = route_returns(laned, pos, bounds)

        edge_out = []
        for e in routed:
            eid = e.get("id") or f"{e['from']}->{e['to']}"
            pts = epaths.get(eid)
            if not pts:
                continue
            edge_out.append({**{k: e[k] for k in e if k != "views"},
                             "id": eid, "route": "layer",
                             "points": [[round(x, 1), round(y, 1)] for x, y in pts]})
        for e in laned:
            eid = e.get("id") or f"{e['from']}->{e['to']}"
            r = lanes.get(eid)
            if not r:
                continue
            edge_out.append({**{k: e[k] for k in e if k != "views"},
                             "id": eid, "route": r["kind"],
                             "labelAt": [round(r["label"][0], 1),
                                         round(r["label"][1], 1)],
                             "points": [[round(x, 1), round(y, 1)]
                                        for x, y in r["points"]]})

        scene_views[vid] = {
            "id": vid, "label": v.get("label", vid.title()),
            "blurb": v.get("blurb", ""),
            "direction": v.get("direction", "RIGHT"),
            "bounds": {"minX": bounds["minX"] - 32,
                       "minY": bounds["minY"] - ext["top"] - 32,
                       "maxX": bounds["maxX"] + 32,
                       "maxY": bounds["maxY"] + ext["bottom"] + 32},
            "nodes": [{"id": nid, **{k: round(vv, 1) for k, vv in pos[nid].items()}}
                      for nid in sorted(pos)],
            "zones": {z: {k: round(vv, 1) for k, vv in r.items()}
                      for z, r in zones.items()},
            "edges": edge_out,
        }

    tokens = build_tokens()
    fails = validate_tokens(tokens, verbose=False)
    if fails:
        die("palette failed WCAG validation:\n  " + "\n  ".join(fails))

    return {
        "meta": model.get("meta", {}),
        "tokens": tokens,
        "nodes": {n["id"]: n for n in model["nodes"]},
        "zones": {z["id"]: z for z in model.get("zones", [])},
        "loops": model.get("loops", []),
        "findings": model.get("findings", []),
        "views": scene_views,
        "viewOrder": [v["id"] for v in views if v["id"] in scene_views],
        "analysis": model.get("_analysis", {}),
    }


# -------------------------------------------------------------------- emit

def emit_html(scene, template_path):
    tpl = open(template_path, "r", encoding="utf-8").read()
    payload = json.dumps(scene, separators=(",", ":"))
    payload = payload.replace("</", "<\\/")
    title = scene["meta"].get("title", "Factory Graph")
    return (tpl.replace("__SCENE__", payload)
               .replace("__TITLE__", title))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model")
    ap.add_argument("-o", "--out", default=None)
    ap.add_argument("--d2", default=None, help="also write a D2 source file")
    ap.add_argument("--brief", default=None,
                    help="also write a markdown brief (the LLM/colleague handoff)")
    ap.add_argument("--report", action="store_true",
                    help="print the findings report to stdout")
    args = ap.parse_args()

    model = analyze(load_model(args.model))
    scene = build_scene(model)

    out = args.out or os.path.splitext(args.model)[0] + ".html"
    html = emit_html(scene, os.path.join(HERE, "artifact.template.html"))
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    size = os.path.getsize(out) / 1024
    a = model.get("_analysis", {})
    print(f"build: wrote {out} ({size:.0f} kB) — "
          f"{a.get('nodeCount')} nodes, {a.get('edgeCount')} edges, "
          f"{a.get('loopCount')} loops, {a.get('findingCount')} findings")

    if args.d2:
        from to_d2 import to_d2
        with open(args.d2, "w", encoding="utf-8") as f:
            f.write(to_d2(model))
        print(f"build: wrote {args.d2}")

    if args.brief:
        from brief import brief
        with open(args.brief, "w", encoding="utf-8") as f:
            f.write(brief(model))
        print(f"build: wrote {args.brief}")

    if args.report:
        print()
        for fnd in model.get("findings", []):
            print(f"  ({fnd['severity']:6s}) {fnd['kind']:20s} {fnd['title']}")


if __name__ == "__main__":
    main()
