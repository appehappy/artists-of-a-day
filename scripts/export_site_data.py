"""Export data/aotd.sqlite + the image manifest into JSON for the site.

Writes site/public/data/site.json (posts, artists, disciplines) and
site/public/data/artworks.json (compact rows for the Wall). An image's URL is
/img/<post dir>/<file>; site/public/img is a symlink to images/originals.

The author's prose is never exported — only factual metadata and captions.

Usage: python3 scripts/export_site_data.py
"""
import json
import re
import sqlite3
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aotd.config import DB_PATH  # noqa: E402
from aotd.manifest import load_downloads  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "site" / "public" / "data"

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

    def filename(image_row):
        f = files.get((image_row["post_id"], image_row["url_hash"]))
        return f and Path(f["path"]).name

    posts, post_index, artworks = [], {}, []
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
            artworks.append([idx, Path(f["path"]).name, f["width"], f["height"],
                             i["year_start"], (i["title"] or "")[:140] or None])

    artists = []
    for aid, a in artist_rows.items():
        roles = json.loads(a["roles"])
        pidx = artist_posts.get(aid, [])
        descriptor = " ".join(posts[i]["descriptor"] or "" for i in pidx)
        years = artist_years.get(aid, [])
        living = bool(a["birth_year"] and a["birth_year"] >= 1925 and not a["death_year"])
        artists.append({
            "slug": a["slug"], "name": a["name"], "type": a["type"],
            "birth": a["birth_year"], "death": a["death_year"],
            "nationality": a["nationality"], "roles": roles,
            "disciplines": disciplines_for(roles, descriptor),
            "living": living, "posts": pidx,
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

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "site.json").write_text(json.dumps(
        {"posts": posts, "artists": artists, "disciplines": disciplines},
        ensure_ascii=False, separators=(",", ":")))
    (OUT / "artworks.json").write_text(json.dumps(
        {"columns": ["post", "file", "w", "h", "year", "title"], "rows": artworks},
        ensure_ascii=False, separators=(",", ":")))
    print(f"posts {len(posts)}  artists {len(artists)}  artworks {len(artworks)}")
    print("disciplines:", {d["key"]: d["artists"] for d in disciplines})
    for name in ("site.json", "artworks.json"):
        print(f"{name}: {(OUT / name).stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
