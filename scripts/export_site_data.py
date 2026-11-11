"""Export data/aotd.sqlite + the image manifest into JSON for the site.

Writes site/public/data/site.json (posts, artists, disciplines, regions, colours, media),
site/public/data/artworks.json (compact rows for the Wall) and
site/public/data/similar/<post index>.json (similar works, loaded on demand).
An image's URL is /img/<post dir>/<file> and its thumbnail /thumbs/<post dir>/<stem>.webp;
site/media/img and site/media/thumbs are symlinks into the Dropbox images folder.

The author's prose is never exported — only factual metadata and captions.

Usage: python3 scripts/export_site_data.py
"""
import json
import re
import shutil
import sqlite3
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aotd import media  # noqa: E402
from aotd.colors import BUCKETS  # noqa: E402
from aotd.config import DB_PATH  # noqa: E402
from aotd.manifest import load_downloads  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "site" / "public" / "data"
# How far to trust an undated work's estimated year (images.year_basis): 1 close (the dated
# works beside it in its post, within a few years), 2 rough (look-alikes or the artist's
# lifetime, a generation either way).
EST_KIND = {"siblings": 1, "artist": 1, "likeness": 2, "life": 2}
SAME_IMAGE = 0.95   # CLIP cosine above which two images are one work (as in aotd/dates.py)

# Ordered discipline groups, matched against an artist's roles + descriptor.
DISCIPLINES = [
    ("painting", "Painting", r"paint|watercolo|pastel|portraitist|muralist|fresco"),
    ("sculpture", "Sculpture", r"sculpt|carver|land art|metal ?work"),
    ("photography", "Photography", r"photo"),
    ("graphic", "Graphic design", r"graphic|poster|typograph|type designer|letter|logo|brand|art director|calligraph|advertis|packag"),
    ("illustration", "Illustration", r"illustrat|cartoon|comic|animat|caricatur|children|draft|drawing"),
    ("architecture", "Architecture", r"architect|interior|urban|landscape design"),
    ("design", "Product & fashion", r"industrial|product|fashion|furniture|car design|automotive|transportation|textile|jewel|object|design firm|design studio|(?<!graphic )(?<!type )\bdesigner"),
    ("ceramics", "Ceramics & glass", r"cerami|potter|porcelain|glass"),
    ("print", "Printmaking", r"print|etch|engrav|lithograph|woodcut|linocut|serigraph"),
    ("media", "Installation & media", r"install|digital|video|new media|mixed media|performance|conceptual|multimedia|light art|kinetic|sound|film"),
    ("street", "Street art", r"street|graffiti|mural"),
]


def disciplines_for(roles, descriptor):
    text = " ".join(roles) + " " + (descriptor or "")
    found = [key for key, _, pat in DISCIPLINES if re.search(pat, text, re.I)]
    return found or ["other"]


def main():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    files = load_downloads()

    post_rows = db.execute(
        "SELECT p.*, pa.artist_id FROM posts p LEFT JOIN post_artists pa ON pa.post_id = p.id "
        "ORDER BY p.published").fetchall()
    artist_rows = {r["id"]: r for r in db.execute("SELECT * FROM artists")}
    images_by_post = {}
    for r in db.execute("SELECT * FROM images ORDER BY post_id, position"):
        images_by_post.setdefault(r["post_id"], []).append(r)
    # Colours per artwork as one int: bits 0–11 = colour buckets covering >= 12% of the
    # image (in BUCKETS order); bits 12+ = 1 + index of its main chromatic hue (0: none).
    bucket_index = {name: i for i, name in enumerate(BUCKETS)}
    colours = {}
    for r in db.execute("SELECT post_id, url_hash, buckets, hue FROM image_colors"):
        mask = sum(1 << bucket_index[n] for n in json.loads(r["buckets"]))
        hue = bucket_index[r["hue"]] + 1 if r["hue"] else 0
        colours[(r["post_id"], r["url_hash"])] = mask | hue << 12
    wikidata = {r["artist_id"]: r for r in db.execute("SELECT * FROM artist_wikidata")}

    medium_index = {k: i for i, k in enumerate(media.KEYS)}  # "exclude" -> None

    def filename(image_row):
        f = files.get((image_row["post_id"], image_row["url_hash"]))
        return f and Path(f["path"]).name

    posts, post_index, artworks, exported = [], {}, [], {}
    row_keys = []   # (post_id, url_hash) of each artworks row
    artist_posts, artist_years = {}, {}
    for p in post_rows:
        imgs = images_by_post.get(p["id"], [])
        intro = next((i for i in imgs if i["kind"] == "intro"), None) or \
            next((i for i in imgs if i["kind"] == "artwork"), None)
        artist = artist_rows.get(p["artist_id"])
        idx = len(posts)
        post_index[p["id"]] = idx
        posts.append({
            "id": p["id"], "date": p["feature_date"] or p["published"][:10],
            "number": p["post_number"], "url": p["url"], "kind": p["kind"],
            "subject": p["subject"], "descriptor": p["descriptor"],
            "artist": artist["slug"] if artist else None,
            # image folder under originals/, as laid out by download_images.py
            "dir": f"{p['published'][:4]}/{p['published'][:10]}_{p['id']}",
            "intro": filename(intro) if intro else None,
        })
        if artist:
            artist_posts.setdefault(artist["id"], []).append(idx)
        for i in imgs:
            f = files.get((i["post_id"], i["url_hash"]))
            if i["kind"] != "artwork" or not f:
                continue
            if artist and i["year_start"]:
                artist_years.setdefault(artist["id"], []).append(i["year_start"])
            exported[(i["post_id"], i["url_hash"])] = (idx, Path(f["path"]).name)
            row_keys.append((i["post_id"], i["url_hash"]))
            artworks.append([idx, Path(f["path"]).name, f["width"], f["height"],
                             i["year_start"], (i["title"] or "")[:140] or None,
                             colours.get((i["post_id"], i["url_hash"]), 0),
                             medium_index.get(i["medium"]), i["year_est"],
                             i["year_end"] if i["year_start"] is not None else None,
                             EST_KIND.get(i["year_basis"], 0) if i["year_start"] is None else 0, 0])

    # A work posted more than once is counted once: every copy after the first is marked.
    row_of = {key: n for n, key in enumerate(row_keys)}
    group = list(range(len(artworks)))

    def find(n):
        while group[n] != n:
            group[n] = group[group[n]]
            n = group[n]
        return n

    for r in db.execute("SELECT post_id, url_hash, similar FROM image_similar"):
        me = row_of.get((r["post_id"], r["url_hash"]))
        if me is None:
            continue
        for pid, h, cosine in json.loads(r["similar"]):
            other = row_of.get((pid, h))
            if other is not None and cosine >= SAME_IMAGE:
                a_, b_ = find(me), find(other)
                group[max(a_, b_)] = min(a_, b_)     # rows run oldest post first
    copies = 0
    for n, row in enumerate(artworks):
        if find(n) != n:
            row[-1] = 1
            copies += 1
    print(f"later copies of reposted works: {copies}")

    artists = []
    for aid, a in artist_rows.items():
        roles = json.loads(a["roles"])
        pidx = artist_posts.get(aid, [])
        descriptor = " ".join(posts[i]["descriptor"] or "" for i in pidx)
        years = artist_years.get(aid, [])
        living = bool(a["birth_year"] and a["birth_year"] >= 1925 and not a["death_year"])
        w = wikidata.get(aid)
        artists.append({
            "slug": a["slug"], "name": a["name"], "type": a["type"],
            "birth": a["birth_year"], "death": a["death_year"],
            "nationality": a["nationality"], "roles": roles,
            "disciplines": disciplines_for(roles, descriptor),
            "living": living, "posts": pidx, "region": a["region"],
            "wikidata": {"qid": w["qid"], "enwiki": w["enwiki"],
                         "movements": json.loads(w["movements"])} if w else None,
            "era": a["birth_year"] + 35 if a["birth_year"] else
                   (int(statistics.median(years)) if years else None),
        })

    # Neighbours: share the most disciplines, then closest in era.
    for a in artists:
        da = set(a["disciplines"])
        scored = []
        for b in artists:
            if b is a:
                continue
            shared = len(da & set(b["disciplines"]))
            if not shared:
                continue
            gap = abs(a["era"] - b["era"]) if a["era"] and b["era"] else 60
            scored.append((-shared, gap, b["slug"]))
        a["neighbours"] = [s for _, _, s in sorted(scored)[:8]]
    for a in artists:
        a.pop("era")

    counts = {}
    for a in artists:
        for d in a["disciplines"]:
            counts[d] = counts.get(d, 0) + 1
    disciplines = [{"key": k, "label": label, "artists": counts.get(k, 0)}
                   for k, label, _ in DISCIPLINES] + \
                  [{"key": "other", "label": "Other", "artists": counts.get("other", 0)}]

    region_counts = {}
    for a in artists:
        if a["region"]:
            region_counts[a["region"]] = region_counts.get(a["region"], 0) + 1
    regions = [{"key": r, "artists": n} for r, n in sorted(region_counts.items(), key=lambda x: -x[1])]

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "site.json").write_text(json.dumps(
        {"posts": posts, "artists": artists, "disciplines": disciplines, "regions": regions,
         "colours": [{"key": k, "hex": v} for k, v in BUCKETS.items()],
         "media": [{"key": k, "label": label} for k, label in media.MEDIA]},
        ensure_ascii=False, separators=(",", ":")))
    (OUT / "artworks.json").write_text(json.dumps(
        {"columns": ["post", "file", "w", "h", "year", "title", "colours", "medium", "year_est",
                     "year_end", "est_kind", "copy"],
         "rows": artworks},
        ensure_ascii=False, separators=(",", ":")))

    # Similar works, one small file per post: {file: [[post index, file], ...]}
    similar_dir = OUT / "similar"
    shutil.rmtree(similar_dir, ignore_errors=True)
    similar_dir.mkdir()
    by_post = {}
    for r in db.execute("SELECT post_id, url_hash, similar FROM image_similar"):
        me = exported.get((r["post_id"], r["url_hash"]))
        if not me:
            continue
        nbrs = [list(exported[(pid, h)]) for pid, h, _ in json.loads(r["similar"])
                if (pid, h) in exported]
        by_post.setdefault(me[0], {})[me[1]] = nbrs
    for idx, files_ in by_post.items():
        (similar_dir / f"{idx}.json").write_text(json.dumps(files_, separators=(",", ":")))

    print(f"posts {len(posts)}  artists {len(artists)}  artworks {len(artworks)}")
    print("disciplines:", {d["key"]: d["artists"] for d in disciplines})
    print("regions:", {r["key"]: r["artists"] for r in regions})
    print(f"artworks with colours: {sum(1 for a in artworks if a[6])}  "
          f"posts with similar works: {len(by_post)}")
    for name in ("site.json", "artworks.json"):
        print(f"{name}: {(OUT / name).stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
