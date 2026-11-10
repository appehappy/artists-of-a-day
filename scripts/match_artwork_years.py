"""Date artworks from Wikidata: works whose creator is a matched artist, by title.

For every artist matched to Wikidata, fetches the works it lists them as creator of
(P170) with an inception date (P571), and matches those works' labels and aliases, in
any language, to the archive's artwork titles. Generic titles ("Untitled", "Study 3")
are never matched.

Writes:
  curation/artwork_years.csv         source=wikidata rows for undated artworks: 'auto'
                                     when every matching work agrees on the year,
                                     'needs_review' when they don't. Rows set to
                                     'confirmed' or 'wrong' by hand are kept.
  data/review/artwork_year_conflicts.csv
                                     works the caption already dates where Wikidata
                                     disagrees by more than two years: a parse error,
                                     a wrong match, or a different version of the work.

Responses are cached in <ARCHIVE_ROOT>/raw/wikidata/artwork_dates.jsonl; --refresh
re-queries every artist.

Usage: python3 scripts/match_artwork_years.py [--refresh] [--batch 20]
"""
import argparse
import csv
import re
import sqlite3
import sys
import urllib.parse
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aotd import dates  # noqa: E402
from aotd.config import DATA_DIR, DB_PATH, RAW_DIR  # noqa: E402
from match_wikidata import SPARQL, JsonlCache, http_json  # noqa: E402

CACHE = RAW_DIR / "wikidata" / "artwork_dates.jsonl"
CONFLICTS = DATA_DIR / "review" / "artwork_year_conflicts.csv"

WORKS_QUERY = """
SELECT ?creator ?work ?label ?date ?precision ?earliest ?latest ?sourcing WHERE {
  VALUES ?creator { %s }
  ?work wdt:P170 ?creator ; p:P571 ?statement .
  ?statement psv:P571 [ wikibase:timeValue ?date ; wikibase:timePrecision ?precision ] .
  OPTIONAL { ?statement pq:P1319 ?earliest }
  OPTIONAL { ?statement pq:P1326 ?latest }
  OPTIONAL { ?statement pq:P1480 ?sourcing }
  { ?work rdfs:label ?label } UNION { ?work skos:altLabel ?label }
}"""


def year_of(date):
    m = re.match(r"(-?)0*(\d+)-", date or "")
    return int(m.group(2)) * (-1 if m.group(1) else 1) if m else None


def work_years(date, precision, earliest=None, latest=None, sourcing=None):
    """An inception statement -> (start, end, circa), or None when it only bounds the date.

    Qualifiers matter: 1935 with "latest date 1935" (P1326) means "by 1935", often the
    artist's death; earliest and latest dates (P1319, P1326) together give a range; any
    sourcing circumstance (P1480: circa, presumably, ...) makes it approximate."""
    lo, hi = year_of(earliest), year_of(latest)
    if lo is not None and hi is not None:
        return (lo, hi if hi > lo else None, bool(sourcing)) if hi - lo <= 50 else None
    if lo is not None or hi is not None or precision < 8:
        return None
    year = year_of(date)
    if precision == 8:   # decade
        return year // 10 * 10, year // 10 * 10 + 9, bool(sourcing)
    return year, None, bool(sourcing)


def fetch(qids, cache, batch):
    todo = [q for q in qids if q not in cache]
    for i in range(0, len(todo), batch):
        chunk = todo[i:i + batch]
        print(f"  works for artists {i + 1}–{i + len(chunk)} of {len(todo)}", file=sys.stderr)
        res = http_json(SPARQL, data=urllib.parse.urlencode(
            {"query": WORKS_QUERY % " ".join("wd:" + q for q in chunk), "format": "json"}).encode())
        found = defaultdict(set)
        for b in res["results"]["bindings"]:
            years = work_years(b["date"]["value"], int(b["precision"]["value"]),
                               *(b.get(k, {}).get("value") for k in ("earliest", "latest", "sourcing")))
            if years:
                found[b["creator"]["value"].rsplit("/", 1)[1]].add(
                    (b["work"]["value"].rsplit("/", 1)[1], b["label"]["value"], *years))
        cache.put_many([(q, sorted(found.get(q, []), key=lambda w: (w[0], w[1], w[2], w[3] or 0)))
                        for q in chunk])


def title_keys(title):
    """'L'Incompris (Misunderstood)' -> {'l incompris misunderstood', 'l incompris', 'misunderstood'}"""
    keys = {dates.title_key(title)}
    keys.add(dates.title_key(re.sub(r"\([^)]*\)", " ", title)))
    keys.update(dates.title_key(p) for p in re.findall(r"\(([^)]*)\)", title))
    return {k for k in keys if k and not dates.is_generic(k)}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--refresh", action="store_true", help="re-query cached artists")
    ap.add_argument("--batch", type=int, default=20, help="artists per SPARQL query")
    args = ap.parse_args()

    db = sqlite3.connect(DB_PATH)
    images = db.execute("""
        SELECT i.post_id, i.url_hash, i.title, i.year_start, i.year_end, i.circa, i.year_source,
               a.slug, a.wikidata_qid, p.url
        FROM images i JOIN post_artists pa ON pa.post_id = i.post_id
        JOIN artists a ON a.id = pa.artist_id JOIN posts p ON p.id = i.post_id
        WHERE i.kind = 'artwork' AND i.title IS NOT NULL AND a.wikidata_qid IS NOT NULL""").fetchall()
    qids = sorted({r[8] for r in images})
    if args.refresh and CACHE.exists():
        CACHE.unlink()
    cache = JsonlCache(CACHE)
    fetch(qids, cache, args.batch)

    index = {}   # qid -> {title key: {(work, start, end, circa)}}
    for q in qids:
        by_key = defaultdict(set)
        for work, label, start, end, circa in cache[q]:
            key = dates.title_key(label)
            if key and not dates.is_generic(key):
                by_key[key].add((work, start, end, circa))
        index[q] = by_key

    stats, rows, conflicts = Counter(), [], []
    for post_id, url_hash, title, year, year_end, circa, source, slug, qid, url in images:
        works = set().union(*(index[qid].get(k, set()) for k in title_keys(title)))
        if not works:
            continue
        starts = sorted({w[1] for w in works})
        if source in dates.STATED:   # dated by the archive itself: check it
            lo, hi = dates.span(year, year_end, circa, 9999)
            stats["dated works matched"] += 1
            if any(lo - 1 <= s <= hi + 1 for s in starts):
                stats["dated works matched: agree within a year"] += 1
            elif all(not lo - 2 <= s <= hi + 2 for s in starts):
                conflicts.append([slug, title, year, source, " ".join(map(str, starts)),
                                  " ".join(sorted({w[0] for w in works})), url])
            continue
        agree = starts[-1] - starts[0] <= 1
        work = min(works, key=lambda w: w[1])
        rows.append({
            "post_id": post_id, "url_hash": url_hash, "artist": slug, "title": title,
            "status": "auto" if agree else "needs_review",
            "year": dates.format_year(*work[1:]) if agree else "",
            "evidence": " ".join(sorted({w[0] for w in works})),
            "note": "" if agree else "Wikidata works disagree: " + ", ".join(map(str, starts)),
        })
        stats["undated works matched: " + ("auto" if agree else "needs_review")] += 1

    n = dates.update_rows("wikidata", rows)
    CONFLICTS.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFLICTS, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["artist", "title", "parsed_year", "parsed_from", "wikidata_years", "works", "post"])
        w.writerows(sorted(conflicts))
    print(f"artists queried: {len(qids)}, with dated works: {sum(bool(cache[q]) for q in qids)}")
    for k, v in sorted(stats.items()):
        print(f"{k}: {v}")
    print(f"conflicts with parsed dates: {len(conflicts)} -> {CONFLICTS}")
    print(f"wikidata rows in {dates.ARTWORK_YEARS.name}: {n}")


if __name__ == "__main__":
    main()
