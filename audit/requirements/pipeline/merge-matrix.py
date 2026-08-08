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
INV = os.path.join(REPO, "audit/requirements/inventory.md")
OUT = os.path.join(REPO, "audit/requirements/matrix.baseline.json")
VERIF = os.path.join(SCRATCH, "verification-results.json")

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
        m = re.match(r"^## (W4-R\d+)\s*$", line)
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
    for path in sorted(glob.glob(os.path.join(SCRATCH, "cluster-*.json"))):
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

    # Ticket mapping is blocked this run; per report-format.md a blocked ticket
    # dimension is written into every row's cell as ["BLOCKED"], so the matrix is
    # self-describing rather than indistinguishable from "checked, none found".
    ticket_status = "BLOCKED"
    blocked_cell = ["BLOCKED"] if ticket_status == "BLOCKED" else []

    reqs = []
    for rid in ids:
        e = entries.get(rid)
        if e is None:
            reqs.append({
                "id": rid, "verdict": "BLOCKED", "tickets": list(blocked_cell),
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
            "tickets": list(blocked_cell),
            "evidence": e.get("evidence") or [],
            "verification": verification,
            "interpretation": e.get("interpretation"),
            "assumption": assumption,
            "suggested_scope": e.get("suggested_scope"),
            "notes": notes,
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
        "ticket_mapping": {
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
        },
        "requirements": reqs,
        "orphan_tickets": [],
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
