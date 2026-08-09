#!/usr/bin/env python3
"""Render REPORT.md and gaps.md from matrix.baseline.json + inventory.md.

Formats governed by ~/.claude/skills/requirements-audit/references/report-format.md
"""
import json, os, re
import pathlib

# Repo root derived from this file's location (<repo>/audit/requirements/pipeline),
# so the pipeline reproduces from any clone rather than one machine.
REPO = str(pathlib.Path(__file__).resolve().parents[3])
# Which requirement document this run is for. Unset/W4 keeps the original W4
# paths byte-for-byte, so W4's committed baseline stays reproducible; DOC=W5
# switches to the W5 artifact set. One pipeline, two document sets — a forked
# copy would drift the moment either side was fixed.
DOC = os.environ.get("DOC", "W4").upper()
_SFX = "" if DOC == "W4" else f"-{DOC}"

D = os.path.join(REPO, "audit/requirements")
matrix = json.load(open(os.path.join(D, f"matrix.baseline{_SFX}.json")))

ORDER = ["VERIFIED", "IMPLEMENTED-UNVERIFIED", "PARTIAL", "MISSING", "N/A",
         "BLOCKED", "ASSUMED"]


def parse_inventory():
    entries, cur = {}, None
    for line in open(os.path.join(D, f"inventory{_SFX}.md")):
        m = re.match(rf"^## ({DOC}-R\d+)\s*$", line)
        if m:
            cur = m.group(1)
            entries[cur] = {}
            continue
        if not cur:
            continue
        m = re.match(r"^- \*\*(.+?):\*\*\s*(.*)$", line.rstrip("\n"))
        if m:
            entries[cur][m.group(1)] = m.group(2)
    return entries


inv = parse_inventory()


def short(rid):
    """A short label for the requirement — from Meaning in code, not the quote."""
    s = inv.get(rid, {}).get("Meaning in code", "") or ""
    s = s.strip()
    if len(s) > 78:
        s = s[:75].rstrip() + "..."
    return s or "(no label)"


def cite(e):
    """file:line — except for a PDF source document, where `line` is a page."""
    if e["file"].lower().endswith(".pdf"):
        return f"`{e['file']}` p.{e['line']}"
    return f"`{e['file']}:{e['line']}`"


def ev_cell(r):
    if not r["evidence"]:
        return "—"
    parts = [cite(e) for e in r["evidence"][:2]]
    if len(r["evidence"]) > 2:
        parts.append(f"+{len(r['evidence']) - 2} more")
    return "<br>".join(parts)


tally = {}
for r in matrix["requirements"]:
    tally[r["verdict"]] = tally.get(r["verdict"], 0) + 1

L = []
A = L.append
A("# Requirements Audit — Ship (GAUNTLET)")
A("")
A(f"**Commit:** {matrix['commit'][:12]}{' (dirty tree)' if matrix['dirty'] else ''} · "
  f"**Date:** {matrix['date']} · **Docs:** W4 `GFA_Week_4_ShipShape_Updated.pdf` "
  f"(14 pp.; requirements p.2–11, orientation appendix p.12–13) · "
  f"**Mode:** baseline")
A("")
A("## Summary")
A("")
for v in ORDER:
    if tally.get(v):
        A(f"- **{v}:** {tally[v]}")
A("")
n_partial = tally.get("PARTIAL", 0)
n_missing = tally.get("MISSING", 0)

# The Summary is DERIVED from the matrix, never hardcoded. An earlier version had
# W4's two findings written into the prose; when the pipeline was parameterized for
# W5 the paths followed but the sentences did not, and W5's report opened by
# describing W4's type-safety target. A report that states another document's
# findings is worse than no report, and nothing in the gate could catch it.
def _lead(r):
    """One clause a reader must ACT on.

    Prefers suggested_scope — what would close the gap — over the notes' first
    sentence. Notes routinely open by stating what already works ("Mapping itself
    is complete...", "fully satisfy this requirement..."), so a first-sentence
    extract turns a worst-first list into a list that reads as praise. That is
    not a formatting nitpick: the Summary is where a reader stops.
    """
    for field in ("suggested_scope", "notes"):
        v = (r.get(field) or "").strip()
        if not v:
            continue
        first = re.split(r"(?<=[.!?])\s", v)[0].strip()
        if len(first) < 40 and len(v) > len(first):      # too terse to stand alone
            first = v
        return first if len(first) <= 260 else first[:257].rstrip() + "..."
    return short(r["id"])

worst = [r for r in matrix["requirements"] if r["verdict"] == "MISSING"] + \
        [r for r in matrix["requirements"] if r["verdict"] == "PARTIAL"]

_nv = tally.get('VERIFIED', 0)
A(f"All {len(matrix['requirements'])} active {DOC} requirements are represented below. "
  f"{_nv} carr{'ies' if _nv == 1 else 'y'} green behavioural evidence, "
  f"{tally.get('IMPLEMENTED-UNVERIFIED', 0)} are traced to file:line without a behavioural "
  f"check, and {n_missing + n_partial} fall short — {n_missing} `MISSING`, {n_partial} `PARTIAL`.")
A("")
if worst:
    A("**The findings a reader must act on, worst first:**")
    A("")
    for r in worst[:6]:
        A(f"- **{r['id']}** (`{r['verdict']}`) — {_lead(r)}")
    if len(worst) > 6:
        A(f"- …and {len(worst) - 6} further `PARTIAL` row(s); all of them, with the smallest "
          f"change that would close each, are in the Gaps section below and in `gaps{_SFX}.md`.")
else:
    A("Nothing traced `MISSING` or `PARTIAL`.")
A("")
if matrix.get("ticket_mapping", {}).get("status") == "BLOCKED":
    tm = matrix["ticket_mapping"]
    A(f"> **Ticket mapping BLOCKED.** {tm['reason']} **To unblock:** {tm['unblock']}")
    A("")

n_ruled = len([r for r in matrix["requirements"] if r.get("interpretation")])
# ---- Coverage and limitations (what this sweep did NOT check) ----
A("## Coverage and limitations")
A("")
A("What this sweep did and did not check. Read this before treating any row below "
  "as proof.")
A("")
A("- **The e2e suite never ran.** `pnpm test:e2e` was not executed this sweep (600+ "
  "Playwright tests requiring the `/e2e-test-runner` protocol and Docker). W4-R21, "
  "W4-R36 and W4-R37 lean on suites that were traced but not executed: their evidence "
  "is the specs' existence and prior recorded runs, not a live result. No claim is "
  "made about the e2e suite in either direction.")
_tm = matrix.get("ticket_mapping", {})
if _tm.get("status") == "OK":
    _unticketed = len([r for r in matrix["requirements"] if not r["tickets"]])
    A(f"- **Ticket mapping ran against live Linear data.** Scope: {_tm['scope']} "
      f"{_unticketed} of {len(matrix['requirements'])} requirements have no ticket "
      f"covering them and {len(matrix['orphan_tickets'])} in-scope tickets map to no "
      "requirement; both lists are below. A requirement without a ticket is not "
      "necessarily unfinished — much of this brief is process work that was done "
      "without being ticketed.")
else:
    A("- **Ticket mapping is blocked.** The Linear connector is unauthorized, so every "
      "row's ticket cell reads `BLOCKED`. That means \"not confirmed ticketed\" — never "
      "\"confirmed unticketed\" — and orphan tickets could not be detected at all.")
A("- **This sweep wrote to the developer's database, which a read-only audit should "
  "not have done.** W4-R13's `VERIFIED` excerpt came from "
  "`pnpm db:seed && npx tsx audit/seed-augment.ts` run against the working database "
  "`ship_standup` rather than a throwaway one. `pnpm test` (W4-R10, W4-R35) then ran "
  "with that same `DATABASE_URL` exported, and `api/src/test/setup.ts:93-98` "
  "`TRUNCATE`s 15 tables — including `documents`, `users` and `workspaces` — in every "
  "api test file's `beforeAll`. So the audit reseeded the database and then destroyed "
  "it. It was re-seeded afterwards and is back at 500 documents / 255 issues / 20 "
  "users / 35 sprints, but the state behind W4-R13's excerpt no longer exists in that "
  "exact form; the excerpt is a true record of what was observed, not something "
  "re-runnable today.")
A(f"- **{tally.get('IMPLEMENTED-UNVERIFIED', 0)} of "
  f"{len(matrix['requirements'])} rows are `IMPLEMENTED-UNVERIFIED`** — statically "
  "traced to file:line with no behavioral check run against them. "
  f"{tally.get('VERIFIED', 0)} rows are `VERIFIED` on captured command output. "
  + (f"{tally.get('ASSUMED', 0)} row(s) remain `ASSUMED`, traced under a stated "
     "assumption pending a ruling. " if tally.get('ASSUMED') else
     f"{n_ruled} row{'' if n_ruled == 1 else 's'} "
     f"{'rests' if n_ruled == 1 else 'rest'} on a recorded interpretation "
     "ruling rather than on the requirement text alone; none is left un-ruled. ")
  + "Every command that did run this sweep is listed under "
    "\"Verification performed\" at the end of this report.")
if matrix.get("dirty_paths"):
    cited_files = {e["file"] for r in matrix["requirements"] for e in r["evidence"]}
    dp = matrix["dirty_paths"]
    cited_dirty = [p for p in dp if p in cited_files]
    line = ("- **The swept tree was dirty** — "
            f"{len(dp)} path(s) did not match commit `{matrix['commit'][:12]}`. ")
    if cited_dirty:
        one = len(cited_dirty) == 1
        line += ("Of those, the "
                 + ("only one this report cites is " if one
                    else "ones this report cites are ")
                 + ", ".join(f"`{p}`" for p in cited_dirty)
                 + (" — citations into it are" if one else " — citations into them are")
                 + " reproducible only against the working tree, not against the "
                   "recorded commit. ")
    else:
        line += "None of them is cited as evidence by any row. "
    line += ("The rest are this sweep's own in-flight output and unrelated working "
             "files; the full list is `dirty_paths` in `matrix.baseline.json`. Where "
             "volatility made a citation unusable (W4-R35, `memory-bank/"
             "activeContext.md`) it was dropped and the claim moved into that row's "
             "notes with the reason.")
    A(line)
A("")

A("## Matrix")
A("")
A("| ID | Requirement (short) | Ticket(s) | Evidence | Verdict |")
A("|---|---|---|---|---|")
for r in matrix["requirements"]:
    tickets = ", ".join(r["tickets"]) or "—"
    A(f"| {r['id']} | {short(r['id'])} | {tickets} | {ev_cell(r)} | `{r['verdict']}` |")
A("")

gaps_rows = [r for r in matrix["requirements"] if r["verdict"] in ("MISSING", "PARTIAL")]
A("## Gaps")
A("")
if not gaps_rows:
    A("None.")
else:
    for r in gaps_rows:
        A(f"### {r['id']} — `{r['verdict']}`")
        A(f"- **Requirement:** {short(r['id'])}")
        if r["evidence"]:
            A("- **Partial evidence:** " + ", ".join(cite(e) for e in r["evidence"][:3]))
        A(f"- **Missing:** {r['notes'] or '(not specified)'}")
        A("")

A("## Orphan tickets")
A("")
if _tm.get("status") != "OK":
    A("Not determinable this sweep — ticket mapping is BLOCKED (see Summary). "
      "Re-run after authorizing the Linear connector to populate this section.")
elif not matrix["orphan_tickets"]:
    A("None — every in-scope ticket maps to at least one requirement.")
else:
    A(f"{len(matrix['orphan_tickets'])} in-scope ticket"
      f"{'' if len(matrix['orphan_tickets']) == 1 else 's'} map to no W4 "
      "requirement. That is expected rather than alarming: "
      "the sprint did work this brief never asked for, and review follow-ups "
      "rarely trace to a requirement of their own. Listed so nothing is invisible.")
    A("")
    A("| Ticket | Status | Title |")
    A("|---|---|---|")
    for o in matrix["orphan_tickets"]:
        ttl = o["title"].replace("|", "\\|")
        A(f"| {o['ticket']} | {o.get('status') or '—'} | {ttl} |")
A("")

blocked = [r for r in matrix["requirements"] if r["verdict"] == "BLOCKED"]
assumed = [r for r in matrix["requirements"] if r["verdict"] == "ASSUMED"]
A("## Blocked / assumed")
A("")
if blocked:
    for r in blocked:
        A(f"- **{r['id']}** `BLOCKED` — {r['notes']}")
else:
    A("_No individually blocked requirements_ (the ticket dimension is blocked "
      "globally — see Summary).")
A("")
if assumed:
    for r in assumed:
        A(f"- **{r['id']}** `ASSUMED` — traced under: {r['assumption']}")
    A("")
if matrix.get("needs_ruling"):
    A("### Open ambiguity rulings needed")
    A("")
    A("Each of these is a yes/no question whose answer changes a verdict. They "
      "were traced under a stated assumption rather than guessed silently; a "
      "ruling recorded in `interpretations.md` will make future sweeps decide "
      "them automatically.")
    A("")
    for q in matrix["needs_ruling"]:
        A(f"- **{q['id']}** — {q['question']}")
        A(f"  - Traced under: {q.get('traced_under', '(unstated)')}")
    A("")

ruled = [r for r in matrix["requirements"] if r.get("interpretation")]
if ruled:
    A("### Interpretation rulings applied")
    A("")
    A("These rows' verdicts depend on a recorded ruling, not on the requirement's "
      "text alone. Each ruling is permanent and lives in "
      "[`interpretations.md`](interpretations.md); future sweeps apply it silently "
      "rather than re-asking. A row is listed here so a reader can see that its "
      "verdict rested on a judgement call and check what that call was.")
    A("")
    for r in ruled:
        # Split on ". " not "." — a bare period also matches inside
        # "interpretations.md" and truncates the sentence mid-word.
        note = (r.get("notes") or "").split(". ")[0].strip().rstrip(".")
        A(f"- **{r['id']}** — ruling `{r['interpretation']}`, verdict "
          f"`{r['verdict']}`. {note}.")
    A("")

A("## PM handoff")
A("")
A("Config `pm_skill: ship-pm` resolved to `.claude/skills/ship-pm/SKILL.md` and the handoff ran "
  "actively: the gaps above were passed through that skill's scope gate. The resulting "
  "disposition per gap — what ships now, what is deferred with which condition, and what is an "
  "owner action rather than engineering work — is in "
  "[`pm-triage.md`](pm-triage.md). This audit opened no tickets and modified no application "
  "source; the triage is a judgement, not a work order.")
A("")
A("## Verification performed")
A("")
A("Every command run against this repo during the sweep, and its real result — "
  "including the ones whose results are asserted as fact in the rows above without "
  "producing a `VERIFIED` verdict, and the one suite that was deliberately not run. "
  "Anything not in this table was not executed.")
A("")
if matrix.get("commands_run"):
    A("| Command | Result | Bears on |")
    A("|---|---|---|")
    for c in matrix["commands_run"]:
        cmd = c["command"].replace("|", "\\|")
        res = c["result"].replace("|", "\\|")
        if c.get("note"):
            res += "<br>_" + c["note"].replace("|", "\\|") + "_"
        A(f"| `{cmd}` | {res} | {', '.join(c.get('bears_on', [])) or '—'} |")
    A("")
n_verified = sum(1 for r in matrix["requirements"] if r.get("verification"))
A(f"Captured output for the {n_verified} row(s) a command carried all the way to "
  "`VERIFIED`:")
A("")
for r in matrix["requirements"]:
    if r.get("verification"):
        A(f"- **{r['id']}** — `{r['verification']['command']}`")
        A("")
        A("  ```")
        for line in r["verification"]["result_excerpt"].split("\n"):
            A(f"  {line}")
        A("  ```")
        A("")

open(os.path.join(D, f"REPORT{_SFX}.md"), "w").write("\n".join(L) + "\n")

# ---- gaps.md (the PM handoff file) ----
G = []
B = G.append
B(f"# Requirements gaps — Ship ({matrix['date']}, commit {matrix['commit'][:12]})")
B("")
if _tm.get("status") == "OK":
    B("Ticket coverage below is live Linear data. Each gap lists the tickets that "
      "map to it, or says none does — a gap with no ticket is the one most likely "
      "to be forgotten.")
else:
    B("Ticket coverage is unknown for every row below: the Linear connector is "
      "unauthorized this sweep, so \"unticketed\" here means \"not confirmed "
      "ticketed\", not \"confirmed missing a ticket\".")
B("")
B("## Unticketed requirements")
B("")
if not gaps_rows:
    B("None.")
for r in gaps_rows:
    e = inv.get(r["id"], {})
    B(f"### {r['id']} — {r['verdict']}")
    B(f"- **Quote:** {e.get('Quote', '(see inventory)')}")
    B(f"- **Source:** {e.get('Source', '')}")
    B(f"- **Meaning in code:** {e.get('Meaning in code', '')}")
    if _tm.get("status") == "OK":
        B("- **Tickets:** " + (", ".join(r["tickets"]) if r["tickets"]
                               else "none map to this requirement"))
    B(f"- **What is missing:** {r['notes'] or '(not specified)'}")
    B(f"- **Suggested scope:** {r.get('suggested_scope') or '(not specified)'}")
    if r["evidence"]:
        B("- **Existing partial evidence:** " + ", ".join(cite(x) for x in r["evidence"][:4]))
    B("")
B("## Orphan tickets")
B("")
if _tm.get("status") != "OK":
    B("Not determinable — ticket mapping BLOCKED (Linear connector unauthorized).")
elif not matrix["orphan_tickets"]:
    B("None.")
else:
    for o in matrix["orphan_tickets"]:
        B(f"- {o['ticket']} \"{o['title']}\" ({o.get('status') or '—'}) — "
          "maps to no W4 requirement.")
B("")
open(os.path.join(D, f"gaps{_SFX}.md"), "w").write("\n".join(G) + "\n")

print("wrote REPORT.md and gaps.md")
print(f"gap rows: {len(gaps_rows)}  blocked: {len(blocked)}  assumed: {len(assumed)}")
