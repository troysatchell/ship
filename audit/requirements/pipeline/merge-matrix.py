#!/usr/bin/env python3
"""Merge requirements-audit cluster trace outputs into matrix.baseline.json.

Reads cluster-*.json from the scratchpad, applies the controller's behavioral
verification results, and writes the matrix per report-format.md.
"""
import json, os, re, subprocess, sys, hashlib, glob
import pathlib

# Repo root derived from this file's location (<repo>/audit/requirements/pipeline),
# so the pipeline reproduces from any clone rather than one machine.
REPO = str(pathlib.Path(__file__).resolve().parents[3])
SCRATCH = os.path.dirname(os.path.abspath(__file__))
# Which requirement document this run is for. Unset/W4 keeps the original W4
# paths byte-for-byte, so W4's committed baseline stays reproducible; DOC=W5
# switches to the W5 artifact set. One pipeline, two document sets — a forked
# copy would drift the moment either side was fixed.
DOC = os.environ.get("DOC", "W4").upper()
_SFX = "" if DOC == "W4" else f"-{DOC}"

INV = os.path.join(REPO, f"audit/requirements/inventory{_SFX}.md")
OUT = os.path.join(REPO, f"audit/requirements/matrix.baseline{_SFX}.json")
VERIF = os.path.join(SCRATCH, f"verification-results{_SFX}.json")

VALID = {"VERIFIED", "IMPLEMENTED-UNVERIFIED", "PARTIAL", "MISSING", "N/A",
         "BLOCKED", "ASSUMED"}


def sh(cmd):
    return subprocess.run(cmd, shell=True, cwd=REPO, capture_output=True,
                          text=True).stdout.strip()


def dirty_paths():
    """Paths git reports as not matching HEAD, NUL-separated so paths with
    spaces survive and git's quoting never applies. Do not .strip() the raw
    output: porcelain status codes are leading-space-significant (' M path'),
    and stripping eats the first entry's first character."""
    out = subprocess.run("git status --porcelain -z", shell=True, cwd=REPO,
                         capture_output=True, text=True).stdout
    paths = []
    for rec in out.split("\0"):
        if len(rec) > 3:
            paths.append(rec[3:])
    return sorted(paths)


def active_ids():
    ids, retired = [], set()
    cur = None
    for line in open(INV):
        m = re.match(rf"^## ({DOC}-R\d+)\s*$", line)
        if m:
            cur = m.group(1)
            ids.append(cur)
        if cur and "Status:" in line and "retired" in line:
            retired.add(cur)
    return [i for i in ids if i not in retired], retired


def main():
    ids, retired = active_ids()

    entries = {}
    needs_ruling = []
    for path in sorted(glob.glob(os.path.join(SCRATCH, f"cluster{_SFX}-*.json"))):
        data = json.load(open(path))
        for r in data.get("requirements", []):
            rid = r["id"]
            if rid in entries:
                print(f"WARN: {rid} traced twice ({path})", file=sys.stderr)
            entries[rid] = r
        for q in data.get("needs_ruling", []):
            q["cluster"] = data.get("cluster", os.path.basename(path))
            needs_ruling.append(q)

    # Controller-owned behavioral verification results override cluster verdicts.
    # Shape: {"requirements": {<id>: {...}}, "commands": [...]}. The older flat
    # {<id>: {...}} shape is still accepted.
    vfile = json.load(open(VERIF)) if os.path.exists(VERIF) else {}
    verifications = vfile.get("requirements", vfile)
    commands_run = vfile.get("commands", [])

    # Ticket mapping. Present only if the Phase 2 map files exist beside this
    # script; otherwise the dimension is BLOCKED and per report-format.md every
    # row's cell reads ["BLOCKED"], so the matrix is self-describing rather than
    # indistinguishable from "checked, none found".
    ticket_map = {}
    for name in ([f"tickets-map{_SFX}-1.json", f"tickets-map{_SFX}-2.json"]
             if DOC == "W4" else [f"tickets-map{_SFX}.json"]):
        p = os.path.join(SCRATCH, name)
        if os.path.exists(p):
            for rid, m in json.load(open(p)).get("mappings", {}).items():
                ticket_map.setdefault(rid, {"tickets": [], "note": None})
                ticket_map[rid]["tickets"] = sorted(
                    set(ticket_map[rid]["tickets"]) | set(m.get("tickets") or []),
                    key=lambda t: int(t.split("-")[1]))
                ticket_map[rid]["note"] = m.get("note") or ticket_map[rid]["note"]

    ticket_status = "OK" if ticket_map else "BLOCKED"
    blocked_cell = ["BLOCKED"] if ticket_status == "BLOCKED" else []

    def cells(rid):
        if ticket_status == "BLOCKED":
            return list(blocked_cell)
        return list(ticket_map.get(rid, {}).get("tickets") or [])

    reqs = []
    for rid in ids:
        e = entries.get(rid)
        if e is None:
            reqs.append({
                "id": rid, "verdict": "BLOCKED", "tickets": cells(rid),
                "evidence": [], "verification": None, "interpretation": None,
                "assumption": None, "suggested_scope": None,
                "notes": "No trace agent returned this requirement; re-run its cluster.",
            })
            continue

        verdict = e.get("verdict")
        notes = e.get("notes")
        verification = None

        v = verifications.get(rid)
        if v:
            if v.get("verdict"):
                verdict = v["verdict"]
            if v.get("verification"):
                verification = v["verification"]
            if v.get("notes"):
                notes = (notes + " " if notes else "") + v["notes"]
            # A verification result that CHANGES a verdict must be able to supply
            # the fields the new verdict requires. Without this, an override that
            # turns a row PARTIAL/MISSING inherits the cluster's null
            # suggested_scope and the acceptance gate fails the run — which is
            # the gate working, but the fix belongs here rather than in the data.
            if v.get("suggested_scope"):
                e = dict(e)
                e["suggested_scope"] = v["suggested_scope"]

        if verdict not in VALID:
            print(f"WARN: {rid} invalid verdict {verdict!r}", file=sys.stderr)

        # Schema rules from report-format.md
        if verdict != "VERIFIED":
            verification = None
        assumption = e.get("assumption") if verdict == "ASSUMED" else None
        if verdict == "ASSUMED" and not assumption:
            assumption = "Traced under an unstated assumption; ruling pending."

        reqs.append({
            "id": rid,
            "verdict": verdict,
            "tickets": cells(rid),
            "evidence": e.get("evidence") or [],
            "verification": verification,
            "interpretation": e.get("interpretation"),
            "assumption": assumption,
            "suggested_scope": e.get("suggested_scope"),
            "notes": notes,
        })

    # Orphan tickets: in scope, but mapped to no requirement.
    orphans = []
    tpath = os.path.join(SCRATCH, f"tickets-ship{_SFX}.json")
    if ticket_status == "OK" and os.path.exists(tpath):
        claimed = {tid for m in ticket_map.values() for tid in m["tickets"]}
        for tk in json.load(open(tpath)):
            if tk["id"] not in claimed:
                orphans.append({
                    "ticket": tk["id"],
                    "title": tk["title"],
                    "status": tk.get("status"),
                    "note": "maps to no inventory requirement",
                })

    cfg = os.path.join(REPO, "audit/requirements.config.yaml")
    dpaths = dirty_paths()
    matrix = {
        "mode": "baseline",
        "commit": sh("git rev-parse HEAD"),
        "dirty": bool(dpaths),
        # Which paths were dirty, so a future reader can judge how reproducible
        # this sweep's citations are against the recorded commit.
        "dirty_paths": dpaths,
        "date": sh("date -u +%Y-%m-%dT%H:%M:%SZ"),
        "config_hash": hashlib.sha256(open(cfg, "rb").read()).hexdigest(),
        "ticket_mapping": ({
            "status": "OK",
            "provider": "linear",
            "team": "TRO",
            "project": "ShipShape Audit Remediation",
            "scope": ("The 123 issues in Linear project \"ShipShape Audit "
                      "Remediation\" (TRO-164..249, TRO-276..311, TRO-354). "
                      "Scoped by project, not by number range: the TRO team is a "
                      "personal catch-all spanning six projects, and the Ship "
                      "numbers are interleaved with them — TRO-250..275 belong to "
                      "Clavira Pilot Readiness and TRO-312..365 mostly to "
                      "FleetGraph (Week 5, same repo, different assignment). "
                      "Sweeping the whole team would report ~200 false orphans "
                      "from work this brief never covered."),
        } if ticket_status == "OK" else {
            "status": ticket_status,
            "provider": "linear",
            "team": "TRO",
            "reason": ("Linear MCP server is unauthorized: only "
                       "mcp__linear__authenticate / complete_authentication are "
                       "exposed, and authenticate returned an OAuth URL requiring "
                       "browser action. No ticket query tools available."),
            "unblock": ("Authorize the Linear connector in claude.ai connector "
                        "settings or via /mcp, then re-run the sweep. Requirement "
                        "-> code tracing is unaffected."),
        }),
        "requirements": reqs,
        "orphan_tickets": orphans,
        "needs_ruling": needs_ruling,
        "commands_run": commands_run,
        "baselineRef": None,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(matrix, f, indent=2)
        f.write("\n")

    tally = {}
    for r in reqs:
        tally[r["verdict"]] = tally.get(r["verdict"], 0) + 1
    print(f"wrote {OUT}")
    print(f"{len(reqs)} requirements ({len(retired)} retired excluded)")
    for k in sorted(tally, key=lambda x: -tally[x]):
        print(f"  {k}: {tally[k]}")
    if needs_ruling:
        print(f"needs_ruling: {len(needs_ruling)}")
    missing = [i for i in ids if i not in entries]
    if missing:
        print(f"UNTRACED: {missing}", file=sys.stderr)


if __name__ == "__main__":
    main()
