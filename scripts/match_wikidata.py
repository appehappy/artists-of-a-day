"""Phase 3: match archive artists (people) to Wikidata.

For each artist: find people on Wikidata with that exact name (batched SPARQL),
falling back to Wikidata's fuzzy search for names with no exact hit; fetch the
candidates' key facts with SPARQL, score them (aotd/wikidata.py), and record the decision in
curation/wikidata_matches.csv. Facts for every match go to
<ARCHIVE_ROOT>/derived/wikidata_artists.json for build_db.py to merge.

Review: rows with status needs_review can be edited by hand — set status to
'confirmed' (optionally changing qid) or 'wrong'. Those rows are never
overwritten. All responses are cached under <ARCHIVE_ROOT>/raw/wikidata/, so
re-runs only query artists that are new.

Fuzzy search is heavily rate-limited by Wikidata, so each run spends at most
--fuzzy-minutes on it; names not reached yet are searched on the next run.

Usage: python3 scripts/match_wikidata.py [--limit N] [--fuzzy-minutes 10]
"""
import argparse
import csv
import json
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aotd import wikidata as wd  # noqa: E402
from aotd.config import CURATION_DIR, DB_PATH, DERIVED_DIR, RAW_DIR, USER_AGENT  # noqa: E402

CACHE = RAW_DIR / "wikidata"
MATCHES = CURATION_DIR / "wikidata_matches.csv"
FACTS = DERIVED_DIR / "wikidata_artists.json"
API = "https://www.wikidata.org/w/api.php"
SPARQL = "https://query.wikidata.org/sparql"
SEARCH_PAUSE = 1.5  # seconds between fuzzy searches; Wikidata throttles these hard
MANUAL = {"confirmed", "wrong"}
FIELDS = ["slug", "name", "status", "qid", "wikidata_label", "description", "score", "reasons",
          "parsed_birth", "wikidata_birth"]

PERSON_QUERY = """
SELECT ?item ?p ?v ?vLabel WHERE {
  VALUES ?item { %s }
  { ?item wdt:P31 ?v . BIND("P31" AS ?p) } UNION
  { ?item wdt:P21 ?v . BIND("P21" AS ?p) } UNION
  { ?item wdt:P106 ?v . BIND("P106" AS ?p) } UNION
  { ?item wdt:P27 ?v . BIND("P27" AS ?p) } UNION
  { ?item wdt:P19 ?v . BIND("P19" AS ?p) } UNION
  { ?item wdt:P135 ?v . BIND("P135" AS ?p) } UNION
  { ?item wdt:P569 ?v . BIND("P569" AS ?p) } UNION
  { ?item wdt:P570 ?v . BIND("P570" AS ?p) } UNION
  { ?item rdfs:label ?v . FILTER(LANG(?v) IN ("en", "mul")) BIND("label" AS ?p) } UNION
  { ?item skos:altLabel ?v . FILTER(LANG(?v) IN ("en", "mul")) BIND("alias" AS ?p) } UNION
  { ?item schema:description ?v . FILTER(LANG(?v) = "en") BIND("desc" AS ?p) } UNION
  { ?v schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . BIND("enwiki" AS ?p) }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}"""

LABEL_QUERY = """
SELECT ?name ?item WHERE {
  VALUES ?name { %s }
  { ?item rdfs:label ?name } UNION { ?item skos:altLabel ?name }
  ?item wdt:P31 wd:Q5 .
}"""

REF_QUERY = """
SELECT ?item ?p ?v WHERE {
  VALUES ?item { %s }
  { ?item wdt:P30 ?v . BIND("P30" AS ?p) } UNION
  { ?item wdt:P1549 ?v . FILTER(LANG(?v) = "en") BIND("P1549" AS ?p) } UNION
  { ?item wdt:P625 ?v . BIND("P625" AS ?p) } UNION
  { ?item wdt:P17 ?v . BIND("P17" AS ?p) } UNION
  { ?item rdfs:label ?v . FILTER(LANG(?v) IN ("en", "mul")) BIND("label" AS ?p) }
}"""


def http_json(url, data=None, retries=5):
    req = urllib.request.Request(url, data=data, headers={
        "User-Agent": USER_AGENT, "Accept": "application/sparql-results+json, application/json"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read())
        except Exception as e:
            retry_after = getattr(e, "headers", None) and e.headers.get("Retry-After")
            wait = int(retry_after) + 1 if retry_after and retry_after.isdigit() else 5 * 2 ** attempt
            print(f"  ! {type(e).__name__}: {e} — retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"giving up on {url[:120]}")


class JsonlCache:
    """Append-only {key: value} cache in one JSONL file."""

    def __init__(self, path):
        self.path, self.data = path, {}
        if path.exists():
            for line in path.read_text().splitlines():
                k, v = json.loads(line)
                self.data[k] = v

    def __contains__(self, k):
        return k in self.data

    def __getitem__(self, k):
        return self.data[k]

    def put_many(self, items):
        with open(self.path, "a") as f:
            for k, v in items:
                self.data[k] = v
                f.write(json.dumps([k, v], ensure_ascii=False) + "\n")


def search(query):
    params = {"action": "wbsearchentities", "search": query, "language": "en", "uselang": "en",
              "type": "item", "limit": 7, "format": "json"}
    res = http_json(f"{API}?{urllib.parse.urlencode(params)}")
    return [r["id"] for r in res.get("search", [])]


def exact_name_matches(names):
    """{name: [QIDs of people whose English/multilingual label or alias is exactly it]}"""
    literal = lambda n: json.dumps(n, ensure_ascii=False)  # noqa: E731 — SPARQL string syntax
    values = " ".join(f"{literal(n)}@en {literal(n)}@mul" for n in names)
    found = {n: [] for n in names}
    for r in sparql_query(LABEL_QUERY % values):
        q = qid(r["item"]["value"])
        if q not in found[r["name"]["value"]]:
            found[r["name"]["value"]].append(q)
    return found


def sparql_query(query):
    res = http_json(SPARQL, data=urllib.parse.urlencode({"query": query, "format": "json"}).encode())
    return res["results"]["bindings"]


def sparql_rows(template, qids):
    query = template % " ".join(f"wd:{q}" for q in qids)
    res = http_json(SPARQL, data=urllib.parse.urlencode({"query": query, "format": "json"}).encode())
    return res["results"]["bindings"]


def qid(uri):
    return uri.rsplit("/", 1)[-1]


def parse_people(rows, qids):
    people = {q: {"id": q, "names": [], "occupations": [], "countries": [], "movements": []}
              for q in qids}
    for r in rows:
        p, v = r["p"]["value"], r["v"]["value"]
        rec = people[qid(r["item"]["value"])]
        vlabel = r.get("vLabel", {}).get("value")
        if p == "P31" and qid(v) == wd.HUMAN:
            rec["human"] = True
        elif p == "P21":
            rec["gender"] = vlabel
        elif p == "P106" and vlabel and vlabel not in rec["occupations"]:
            rec["occupations"].append(vlabel)
        elif p == "P27" and qid(v) not in rec["countries"]:
            rec["countries"].append(qid(v))
        elif p == "P19":
            rec.setdefault("birthplace", qid(v))
        elif p == "P135" and vlabel and vlabel not in rec["movements"]:
            rec["movements"].append(vlabel)
        elif p in ("P569", "P570") and v[:1].isdigit():
            rec.setdefault("birth" if p == "P569" else "death", int(v[:4]))
        elif p in ("label", "alias"):
            if p == "label" and r["v"].get("xml:lang") == "en":
                rec["label"] = v
            if v not in rec["names"]:
                rec["names"].append(v)
        elif p == "desc":
            rec["description"] = v
        elif p == "enwiki":
            rec["enwiki"] = urllib.parse.unquote(v.rsplit("/", 1)[-1]).replace("_", " ")
    for rec in people.values():
        rec.setdefault("label", rec["names"][0] if rec["names"] else None)
    return people


def parse_refs(rows, qids):
    refs = {q: {"id": q, "continents": [], "demonyms": []} for q in qids}
    for r in rows:
        p, v = r["p"]["value"], r["v"]["value"]
        rec = refs[qid(r["item"]["value"])]
        if p == "P30":
            rec["continents"].append(qid(v))
        elif p == "P1549":
            rec["demonyms"].append(v)
        elif p == "P625" and v.startswith("Point(") and "coord" not in rec:
            lon, lat = v[6:-1].split()
            rec["coord"] = [round(float(lat), 4), round(float(lon), 4)]
        elif p == "P17":
            rec.setdefault("country", qid(v))
        elif p == "label" and ("label" not in rec or r["v"].get("xml:lang") == "en"):
            rec["label"] = v
    return refs


def fetch_records(template, parser, cache, qids, batch, what):
    todo = sorted(set(q for q in qids if q not in cache))
    for i in range(0, len(todo), batch):
        chunk = todo[i:i + batch]
        cache.put_many(parser(sparql_rows(template, chunk), chunk).items())
        print(f"  {what}: {min(i + batch, len(todo))}/{len(todo)}", flush=True)
        time.sleep(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--limit", type=int, help="only the first N artists (for testing)")
    ap.add_argument("--fuzzy-minutes", type=float, default=10,
                    help="time budget for rate-limited fuzzy searches this run")
    args = ap.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    CURATION_DIR.mkdir(parents=True, exist_ok=True)

    db = sqlite3.connect(DB_PATH)
    artists = [dict(zip(("slug", "name", "birth", "nationality"), r)) for r in db.execute(
        "SELECT slug, name, birth_year, nationality FROM artists WHERE type = 'person' ORDER BY slug")]
    db.close()
    if args.limit:
        artists = artists[:args.limit]

    previous = {}
    if MATCHES.exists():
        with open(MATCHES, newline="") as f:
            previous = {r["slug"]: r for r in csv.DictReader(f)}

    # 1. Find candidates: exact names in batches, then fuzzy search for the rest
    searches = JsonlCache(CACHE / "search.jsonl")
    exact = JsonlCache(CACHE / "exact.jsonl")
    names = sorted({q for a in artists for q in wd.search_names(a["name"])})
    todo = [n for n in names if n not in exact]
    print(f"exact-name lookup for {len(todo)} names")
    for i in range(0, len(todo), 60):
        exact.put_many(exact_name_matches(todo[i:i + 60]).items())
        print(f"  exact: {min(i + 60, len(todo))}/{len(todo)}", flush=True)
        time.sleep(1)
    fuzzy = [n for n in names if not exact[n] and n not in searches]
    print(f"fuzzy search for {len(fuzzy)} names without an exact match", flush=True)
    deadline = time.time() + args.fuzzy_minutes * 60
    for n, q in enumerate(fuzzy, 1):
        if time.time() > deadline:
            print(f"  fuzzy search budget used; {len(fuzzy) - n + 1} names left for next run")
            break
        searches.put_many([(q, search(q))])
        if n % 50 == 0:
            print(f"  search: {n}/{len(fuzzy)}", flush=True)
        time.sleep(SEARCH_PAUSE)

    def candidates(q):
        return exact[q] + [c for c in searches.data.get(q, []) if c not in exact[q]]

    # 2. Candidate facts, then the countries/places they reference (two hops for places)
    people = JsonlCache(CACHE / "people.jsonl")
    refs = JsonlCache(CACHE / "refs.jsonl")
    cand_ids = {c for a in artists for q in wd.search_names(a["name"]) for c in candidates(q)}
    cand_ids |= {r["qid"] for r in previous.values() if r["status"] == "confirmed" and r["qid"]}
    print(f"fetching {len(cand_ids)} candidates")
    fetch_records(PERSON_QUERY, parse_people, people, cand_ids, 80, "people")
    ref_ids = {x for q in cand_ids for x in people[q]["countries"] + [people[q].get("birthplace")] if x}
    fetch_records(REF_QUERY, parse_refs, refs, ref_ids, 150, "places")
    fetch_records(REF_QUERY, parse_refs, refs,
                  {refs[r]["country"] for r in ref_ids if refs[r].get("country")}, 150, "countries")

    # 3. Score and decide
    rows, facts = [], {}
    for a in artists:
        prev = previous.get(a["slug"])
        cands = []
        seen = set()
        for q in wd.search_names(a["name"]):
            for rank, c in enumerate(candidates(q)):
                if c in seen:
                    continue
                seen.add(c)
                d = wd.describe(people[c], refs.data)
                s, reasons = wd.score(a, d, rank)
                cands.append((s, reasons, d))
        cands.sort(key=lambda x: -x[0])
        if prev and prev["status"] in MANUAL:
            row = prev
            if prev["status"] == "confirmed" and prev["qid"] in people:
                facts[a["slug"]] = wd.describe(people[prev["qid"]], refs.data)
        else:
            best = cands[0] if cands else None
            status = wd.decide(best, cands[1] if len(cands) > 1 else None, a)
            d = best[2] if best else {}
            row = {
                "slug": a["slug"], "name": a["name"], "status": status,
                "qid": d.get("qid", "") if status != "no_match" else "",
                "wikidata_label": d.get("label", "") if status != "no_match" else "",
                "description": d.get("description", "") if status != "no_match" else "",
                "score": best[0] if best else "", "reasons": "; ".join(best[1]) if best else "",
                "parsed_birth": a["birth"] or "", "wikidata_birth": d.get("birth") or "",
            }
            if status == "auto":
                facts[a["slug"]] = d
        rows.append(row)

    # Two artists matched to one person are probably the same artist under two spellings.
    by_qid = {}
    for r in rows:
        if r["qid"] and r["status"] in ("auto", "confirmed"):
            by_qid.setdefault(r["qid"], []).append(r["slug"])
    dupes = {q: s for q, s in by_qid.items() if len(s) > 1}

    keep = [r for slug, r in previous.items() if slug not in {a["slug"] for a in artists}]
    with open(MATCHES, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(sorted(rows + keep, key=lambda r: r["slug"]))
    old_facts = json.loads(FACTS.read_text()) if FACTS.exists() and args.limit else {}
    FACTS.write_text(json.dumps({**old_facts, **facts}, ensure_ascii=False, indent=1))

    counts = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    print(f"{len(rows)} artists: {counts}")
    print(f"likely duplicate artists (same QID): {len(dupes)}  {list(dupes.values())[:10]}")
    print(f"-> {MATCHES}\n-> {FACTS}")


if __name__ == "__main__":
    main()
