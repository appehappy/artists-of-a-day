"""Merge Phase 3 enrichment and manual curation into a freshly built database.

Inputs (all optional, so a build works before enrichment has run):
  curation/overrides.json        manual fixes, applied last
  derived/image_kinds.jsonl      CLIP re-classifications (artwork -> portrait)
  derived/colors.jsonl           palettes per image
  derived/similar.jsonl          nearest artworks per image
  derived/wikidata_artists.json  facts for matched artists, keyed by slug
  curation/artwork_years.csv     artwork dates from Wikidata and research (aotd/dates.py)
"""
import json
from collections import Counter

from aotd import dates
from aotd.config import CURATION_DIR, DERIVED_DIR
from aotd.wikidata import fold

OVERRIDES = CURATION_DIR / "overrides.json"


def load_overrides():
    """{post_kind: {post_id: kind}, post_subject: {post_id: name},
    image_kind: {"post_id/url_hash": kind}, artist_merge: {slug: canonical slug},
    image_year: {"post_id/url_hash": "c.1965"}}"""
    o = json.loads(OVERRIDES.read_text()) if OVERRIDES.exists() else {}
    return {k: {kk: vv for kk, vv in o.get(k, {}).items() if not kk.startswith("_")}
            for k in ("post_kind", "post_subject", "image_kind", "artist_merge", "image_year")}


def jsonl(path):
    if not path.exists():
        return []
    with open(path) as f:
        return [r for r in map(json.loads, f) if "error" not in r]


def merge(db, overrides):
    """Apply enrichment to the open database. Returns counts for reporting."""
    stats = Counter()

    for r in jsonl(DERIVED_DIR / "image_kinds.jsonl"):
        cur = db.execute("UPDATE images SET kind = ?, kind_source = 'clip' "
                         "WHERE post_id = ? AND url_hash = ? AND kind = 'artwork'",
                         (r["kind"], r["post_id"], r["url_hash"]))
        stats["clip kind changes"] += cur.rowcount
    for key, kind in overrides["image_kind"].items():
        post_id, url_hash = key.split("/")
        cur = db.execute("UPDATE images SET kind = ?, kind_source = 'manual' "
                         "WHERE post_id = ? AND url_hash = ?", (kind, post_id, url_hash))
        stats["manual kind changes"] += cur.rowcount

    rows = [(r["post_id"], r["url_hash"], json.dumps(r["palette"]), json.dumps(r["buckets"]),
             r["hue"], r["lightness"]) for r in jsonl(DERIVED_DIR / "colors.jsonl")]
    db.executemany("INSERT OR REPLACE INTO image_colors VALUES (?, ?, ?, ?, ?, ?)", rows)
    stats["images with colours"] = len(rows)

    rows = [(r["post_id"], r["url_hash"], json.dumps(r["similar"]))
            for r in jsonl(DERIVED_DIR / "similar.jsonl")]
    db.executemany("INSERT OR REPLACE INTO image_similar VALUES (?, ?, ?)", rows)
    stats["images with similar works"] = len(rows)

    facts_path = DERIVED_DIR / "wikidata_artists.json"
    facts = json.loads(facts_path.read_text()) if facts_path.exists() else {}
    ids = dict(db.execute("SELECT slug, id FROM artists"))
    demonym_region = Counter()
    for slug, f in facts.items():
        slug = overrides["artist_merge"].get(slug, slug)
        if slug not in ids:
            continue
        db.execute("INSERT OR REPLACE INTO artist_wikidata VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (
            ids[slug], f["qid"], f["label"], f["description"], f["birth"], f["death"], f["gender"],
            json.dumps(f["countries"]), json.dumps(f["birthplace"]) if f["birthplace"] else None,
            json.dumps(f["movements"]), json.dumps(f["occupations"]), f["enwiki"]))
        # Wikidata's dates replace parsed ones only when it has a birth year: some
        # entries know just a death year, and mixing sources gives nonsense ranges.
        if f["birth"]:
            db.execute("UPDATE artists SET birth_year = ?, death_year = ?, dates_source = 'wikidata' "
                       "WHERE id = ?", (f["birth"], f["death"], ids[slug]))
        db.execute("UPDATE artists SET wikidata_qid = ?, region = ? WHERE id = ?",
                   (f["qid"], f["region"], ids[slug]))
        stats["artists matched to Wikidata"] += 1
        for d in f["demonyms"]:
            if f["region"] and fold(d):
                demonym_region[(" ".join(fold(d)), f["region"])] += 1
    db.execute("UPDATE artists SET dates_source = 'parsed' "
               "WHERE dates_source IS NULL AND birth_year IS NOT NULL")

    # Unmatched artists: infer region from the nationality as written ("Polish-born
    # French" -> the last demonym that Wikidata matches taught us a region for).
    best = {}
    for (demonym, region), n in demonym_region.items():
        if n > best.get(demonym, (None, 0))[1]:
            best[demonym] = (region, n)
    for aid, nat in db.execute("SELECT id, nationality FROM artists "
                               "WHERE region IS NULL AND nationality IS NOT NULL").fetchall():
        region = region_from_nationality(nat, {d: r for d, (r, _) in best.items()})
        if region:
            db.execute("UPDATE artists SET region = ? WHERE id = ?", (region, aid))
            stats["regions from nationality"] += 1

    stats.update(dates.apply(db, overrides))
    return stats


def region_from_nationality(nationality, demonym_region):
    """The region of the last demonym in the text: 'Polish-born French' -> French's."""
    text = f" {' '.join(fold(nationality))} "
    best_end, region = -1, None
    for demonym, r in demonym_region.items():
        i = text.rfind(f" {demonym} ")
        if i >= 0 and i + len(demonym) > best_end:
            best_end, region = i + len(demonym), r
    return region
