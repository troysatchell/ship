import json
m = json.load(open("audit/requirements/matrix.baseline.json"))
inv = open("audit/requirements/inventory.md").read()
gaps = open("audit/requirements/gaps.md").read()
active = [l.split()[1] for l in inv.splitlines() if l.startswith("## W4-R")]
retired = inv.count("Status: retired")
matrix_ids = {r["id"] for r in m["requirements"]}
missing_rows = [i for i in active if i not in matrix_ids]
assert not missing_rows or len(missing_rows) == retired, f"dropped rows: {missing_rows}"
for r in m["requirements"]:
    if r["verdict"] == "VERIFIED":
        assert r["verification"] and r["verification"]["result_excerpt"], f"{r['id']}: VERIFIED without evidence"
    if r["verdict"] == "MISSING":
        assert r["id"] in gaps, f"{r['id']}: MISSING but absent from gaps.md"
    if r["verdict"] == "ASSUMED":
        assert r.get("assumption"), f"{r['id']}: ASSUMED without stated assumption"
print(f"OK — {len(m['requirements'])} rows, verdicts sound")
