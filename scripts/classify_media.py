"""Phase 3: classify every artwork image by medium (aotd/media.py) with CLIP.

Scores each artwork's stored CLIP embedding against prompt sets for the nine media
(plus "exclude": collages, grids, pages of text), then weighs the scores by the
artist's disciplines and by the post's other artworks. Writes <ARCHIVE_ROOT>/derived/artwork_media.jsonl:
  {"post_id", "url_hash", "medium", "p", "alt", "p_alt", "clip"}
where clip is CLIP's own top pick before the artist prior.

If curation/media_sample.csv exists (hand-labelled post_id,url_hash,medium), prints
accuracy against it. --sheets DIR draws a stratified sample as numbered contact
sheets for labelling, with a CSV of its keys.

Run embed_images.py and build_db.py first.
Needs the .venv: .venv/bin/python scripts/classify_media.py [--sheets DIR --per N]
"""
import argparse
import csv
import json
import random
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aotd import media  # noqa: E402
from aotd.config import CURATION_DIR, DB_PATH, DERIVED_DIR  # noqa: E402
from embed_images import EMB, KEYS, load_model  # noqa: E402
from export_site_data import disciplines_for  # noqa: E402

OUT = DERIVED_DIR / "artwork_media.jsonl"
SAMPLE = CURATION_DIR / "media_sample.csv"
CLASSES = media.KEYS + [media.EXCLUDE]


def text_matrix(model, tokenizer, device):
    vecs = []
    with torch.no_grad():
        for c in CLASSES:
            t = model.encode_text(tokenizer(media.PROMPTS[c]).to(device))
            t = t / t.norm(dim=-1, keepdim=True)
            m = t.mean(0)
            vecs.append(m / m.norm())
    return torch.stack(vecs)


def artworks(db):
    """[(post_id, url_hash, subject)] and {post_id: [disciplines]}."""
    rows = db.execute("SELECT i.post_id, i.url_hash, p.subject FROM images i "
                      "JOIN posts p ON p.id = i.post_id WHERE i.kind = 'artwork'").fetchall()
    disciplines = defaultdict(set)
    for post_id, kind, descriptor, roles in db.execute(
            "SELECT p.id, p.kind, p.descriptor, a.roles FROM posts p "
            "JOIN post_artists pa ON pa.post_id = p.id JOIN artists a ON a.id = pa.artist_id"):
        if kind != "theme":
            found = disciplines_for(json.loads(roles), descriptor)
            disciplines[post_id].update(d for d in found if d != "other")
    return rows, disciplines


def classify():
    keys = [tuple(k) for k in json.loads(KEYS.read_text())]
    index = {k: i for i, k in enumerate(keys)}
    emb = torch.from_numpy(np.load(EMB).astype(np.float32))
    db = sqlite3.connect(DB_PATH)
    rows, disciplines = artworks(db)
    db.close()

    model, _, tokenizer, device = load_model()
    text = text_matrix(model, tokenizer, device)
    rows = [r for r in rows if (r[0], r[1]) in index]
    sel = torch.tensor([index[(r[0], r[1])] for r in rows])
    probs = (media.TEMPERATURE * emb[sel].to(device) @ text.T).softmax(dim=-1).cpu().numpy()
    by_post = defaultdict(list)
    for i, r in enumerate(rows):
        by_post[r[0]].append(i)
    post_mean = {post: dict(zip(CLASSES, probs[ix].mean(0).tolist())) for post, ix in by_post.items()}

    out = []
    for (post_id, url_hash, subject), p in zip(rows, probs):
        scores = dict(zip(CLASSES, p.tolist()))
        ranked = media.decide(scores, media.prior(disciplines.get(post_id, ())), post_mean[post_id])
        out.append({"post_id": post_id, "url_hash": url_hash,
                    "medium": ranked[0][0], "p": round(ranked[0][1], 3),
                    "alt": ranked[1][0], "p_alt": round(ranked[1][1], 3),
                    "clip": max(scores, key=scores.get), "subject": subject})
    with open(OUT, "w") as f:
        for r in out:
            f.write(json.dumps({k: v for k, v in r.items() if k != "subject"}) + "\n")
    print(f"{len(out)} artworks classified -> {OUT}")
    counts = Counter(r["medium"] for r in out)
    for m in CLASSES:
        sure = sum(1 for r in out if r["medium"] == m and r["p"] >= 0.6)
        print(f"  {m:12} {counts[m]:6}  ({sure} with p >= 0.6)")
    print(f"  CLIP's own pick changed by the artist prior or the post: "
          f"{sum(r['clip'] != r['medium'] for r in out)}")
    return out


def evaluate(out):
    if not SAMPLE.exists():
        return
    by_key = {(r["post_id"], r["url_hash"]): r for r in out}
    with open(SAMPLE) as f:
        truth = [r for r in csv.DictReader(f) if r["medium"]]
    hits, clip_hits, n = 0, 0, 0
    confusion = Counter()
    per_class = defaultdict(lambda: [0, 0])
    for t in truth:
        r = by_key.get((t["post_id"], t["url_hash"]))
        if not r:
            continue
        n += 1
        hits += r["medium"] == t["medium"]
        clip_hits += r["clip"] == t["medium"]
        per_class[t["medium"]][0] += r["medium"] == t["medium"]
        per_class[t["medium"]][1] += 1
        if r["medium"] != t["medium"]:
            confusion[(t["medium"], r["medium"])] += 1
    print(f"\naccuracy on {n} labelled: {hits / n:.1%} (CLIP alone {clip_hits / n:.1%})")
    for m in CLASSES:
        h, total = per_class[m]
        if total:
            print(f"  {m:12} {h}/{total}")
    print("  most confused (truth -> predicted):",
          ", ".join(f"{a}->{b} {c}" for (a, b), c in confusion.most_common(8)))


def sheets(out, directory, per):
    """Up to `per` artworks per predicted medium, shuffled, on numbered contact sheets."""
    from PIL import Image, ImageDraw, ImageFont
    from aotd.manifest import load_downloads, thumb_path

    files = load_downloads()
    rng = random.Random(7)
    by_medium = defaultdict(list)
    for r in out:
        if (r["post_id"], r["url_hash"]) in files:
            by_medium[r["medium"]].append(r)
    sample = [r for m in CLASSES for r in rng.sample(by_medium[m], min(per, len(by_medium[m])))]
    rng.shuffle(sample)

    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    cols, rows_, tile, cap = 5, 4, 280, 34
    font = ImageFont.load_default(size=15)
    with open(directory / "sample.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["n", "post_id", "url_hash", "subject", "predicted"])
        for s in range(0, len(sample), cols * rows_):
            sheet = Image.new("RGB", (cols * tile, rows_ * (tile + cap)), "white")
            draw = ImageDraw.Draw(sheet)
            for j, r in enumerate(sample[s:s + cols * rows_]):
                n = s + j + 1
                w.writerow([n, r["post_id"], r["url_hash"], r["subject"], r["medium"]])
                x, y = (j % cols) * tile, (j // cols) * (tile + cap)
                with Image.open(thumb_path(files[(r["post_id"], r["url_hash"])]["path"])) as im:
                    im = im.convert("RGB")
                    im.thumbnail((tile - 8, tile - 8))
                    sheet.paste(im, (x + (tile - im.width) // 2, y + (tile - im.height) // 2))
                draw.text((x + 6, y + tile + 4), f"{n}  {(r['subject'] or '')[:28]}", fill="black", font=font)
            sheet.save(directory / f"sheet_{s // (cols * rows_) + 1:02}.jpg", quality=80)
    print(f"{len(sample)} sampled artworks on sheets -> {directory}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--sheets", help="write a labelling sample as contact sheets to this directory")
    ap.add_argument("--per", type=int, default=30, help="sampled artworks per predicted medium")
    args = ap.parse_args()
    out = classify()
    evaluate(out)
    if args.sheets:
        sheets(out, args.sheets, args.per)


if __name__ == "__main__":
    main()
