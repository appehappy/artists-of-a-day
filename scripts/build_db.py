"""Phase 1: parse the raw feed snapshots into SQLite.

Rebuilds data/aotd.sqlite from scratch on every run, from the latest full snapshot
plus any incremental snapshots taken after it, and writes
data/review/flagged_posts.csv listing posts whose parse needs a human look.

Usage: python3 scripts/build_db.py [--snapshot 2026-10-22]
"""
import argparse
import csv
import json
import sqlite3
import statistics
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aotd import enrich, parse  # noqa: E402
from aotd.config import DATA_DIR, DB_PATH, RAW_DIR  # noqa: E402
from aotd.feed import load_snapshot, merge_entries, snapshot_layers  # noqa: E402

SCHEMA = Path(__file__).resolve().parent.parent / "aotd" / "schema.sql"


def is_subject_label(label, subject):
    """'Gupta', 'Calugi Jonathan' and 'Nayan and Vaishali Art' all name the subject."""
    lt, st = parse._name_tokens(label), parse._name_tokens(subject or "")
    return bool(lt and st) and (lt <= st or st <= lt)


def flag_number_outliers(posts):
    """Flag post numbers that don't fit the sequence around them, and duplicates."""
    numbered = [p for p in sorted(posts, key=lambda p: p["published"]) if p["post_number"]]
    counts = Counter(p["post_number"] for p in numbered)
    for i, p in enumerate(numbered):
        neighbours = [q["post_number"] for q in numbered[max(0, i - 5):i] + numbered[i + 1:i + 6]]
        if neighbours and abs(p["post_number"] - statistics.median(neighbours)) > 20:
            p["flags"].append("post_number_out_of_sequence")
        if counts[p["post_number"]] > 1:
            p["flags"].append("post_number_duplicate")


def build(full, increments, db_path):
    entries = merge_entries([load_snapshot(d) for d in [full] + increments])
    overrides = enrich.load_overrides()
    posts, images, artists, post_artists, tags = [], [], {}, [], []

    for e in entries:
        post_id = e["id"]["$t"].rsplit("post-", 1)[-1]
        title = e["title"]["$t"]
        html = e["content"]["$t"]
        labels = [c["term"] for c in e.get("category", [])]
        url = next(l["href"] for l in e["link"] if l["rel"] == "alternate")

        t = parse.parse_title(title, e["published"]["$t"])
        flags = list(t["flags"])
        kind = parse.classify_post(t["subject"], t["descriptor"], t["plural"])
        if post_id in overrides["post_kind"]:
            kind = overrides["post_kind"][post_id]
            flags.append("manual_kind")
        t["subject"] = overrides["post_subject"].get(post_id, t["subject"])
        text = parse.body_text(html)

        birth = death = life_raw = None
        if kind == "artist":
            birth, death, life_raw = parse.parse_life_dates(text, t["subject"])
            if life_raw and birth is None:
                flags.append("implausible_life_dates")

        post_images = parse.extract_images(html)
        if not post_images:
            flags.append("no_images")
        for img in post_images:
            filename = parse.image_filename(img["src_url"])
            caption, caption_source = img["caption"], "caption" if img["caption"] else None
            if not caption:
                caption = parse.filename_caption(filename)
                caption_source = "filename" if caption else None
            img_kind = parse.classify_image(img["position"], filename, img["caption"], t["subject"])
            title_, y0, y1, circa = (parse.parse_caption(caption) if img_kind == "artwork"
                                     else (None, None, None, False))
            original = parse.original_image_url(img["src_url"])
            images.append((post_id, img["position"], parse.image_key(img["src_url"], original),
                           img["src_url"], img["link_url"], original, filename,
                           img["width"], img["height"], caption, caption_source,
                           title_, y0, y1, int(circa), img_kind, "heuristic"))

        if kind in ("artist", "group"):
            slug = parse.slugify(t["subject"])
            slug = overrides["artist_merge"].get(slug, slug)
            nationality, roles = parse.parse_descriptor(t["descriptor"])
            a = artists.setdefault(slug, {
                "slug": slug, "name": t["subject"], "type": "person" if kind == "artist" else "group",
                "birth_year": None, "death_year": None, "nationality": None, "roles": []})
            a["birth_year"] = a["birth_year"] or birth
            a["death_year"] = a["death_year"] or death
            a["nationality"] = a["nationality"] or nationality
            a["roles"] += [r for r in roles if r not in a["roles"]]
            post_artists.append((post_id, slug))

        tags += [(post_id, l) for l in dict.fromkeys(labels)
                 if not is_subject_label(l, t["subject"])]

        posts.append({
            "id": post_id, "post_number": t["post_number"], "published": e["published"]["$t"],
            "updated": e.get("updated", {}).get("$t"), "feature_date": t["feature_date"],
            "url": url, "title": title, "subject": t["subject"], "descriptor": t["descriptor"],
            "title_note": t["title_note"], "kind": kind, "labels": json.dumps(labels, ensure_ascii=False),
            "life_dates_raw": life_raw, "content_html": html, "content_text": text, "flags": flags,
        })

    flag_number_outliers(posts)

    if db_path.exists():
        db_path.unlink()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA.read_text())
    db.executemany(
        "INSERT INTO posts VALUES (:id, :post_number, :published, :updated, :feature_date, :url, "
        ":title, :subject, :descriptor, :title_note, :kind, :labels, :life_dates_raw, "
        ":content_html, :content_text, :flags)",
        [{**p, "flags": json.dumps(p["flags"])} for p in posts])
    artist_ids = {}
    for a in artists.values():
        cur = db.execute(
            "INSERT INTO artists (slug, name, type, birth_year, death_year, nationality, roles) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (a["slug"], a["name"], a["type"], a["birth_year"], a["death_year"], a["nationality"],
             json.dumps(a["roles"], ensure_ascii=False)))
        artist_ids[a["slug"]] = cur.lastrowid
    db.executemany("INSERT OR IGNORE INTO post_artists VALUES (?, ?)",
                   [(pid, artist_ids[slug]) for pid, slug in post_artists])
    db.executemany("INSERT OR IGNORE INTO post_tags VALUES (?, ?)", tags)
    db.executemany(
        "INSERT INTO images (post_id, position, url_hash, src_url, link_url, original_url, filename, "
        "width, height, caption_raw, caption_source, title, year_start, year_end, circa, kind, "
        "kind_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", images)
    enrich_stats = enrich.merge(db, overrides)
    db.executemany("INSERT INTO build_info VALUES (?, ?)", [
        ("snapshot", full.name),
        ("increments", json.dumps([d.name for d in increments])),
        ("built_at", datetime.now(timezone.utc).isoformat()),
    ])
    db.commit()
    db.close()

    review_dir = DATA_DIR / "review"
    review_dir.mkdir(parents=True, exist_ok=True)
    with open(review_dir / "flagged_posts.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["published", "post_number", "kind", "flags", "title", "url"])
        for p in sorted(posts, key=lambda p: p["published"]):
            if p["flags"]:
                w.writerow([p["published"][:10], p["post_number"], p["kind"],
                            " ".join(p["flags"]), p["title"], p["url"]])
    return posts, artists, images, enrich_stats


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--snapshot", help="snapshot folder name (default: latest)")
    args = ap.parse_args()
    full, increments = snapshot_layers(RAW_DIR / "feed", args.snapshot)

    posts, artists, images, enrich_stats = build(full, increments, DB_PATH)

    print(f"Snapshot {full.name} + {len(increments)} incremental -> {DB_PATH}")
    print(f"posts: {len(posts)}  {dict(Counter(p['kind'] for p in posts))}")
    print(f"artists: {len(artists)}  {dict(Counter(a['type'] for a in artists.values()))}")
    print(f"images: {len(images)}  {dict(Counter(i[15] for i in images))}")
    flag_counts = Counter(f for p in posts for f in p["flags"])
    print(f"flags: {dict(flag_counts.most_common())}")
    print(f"enrichment: {dict(enrich_stats)}")
    print(f"review list: {DATA_DIR / 'review' / 'flagged_posts.csv'}")


if __name__ == "__main__":
    main()
