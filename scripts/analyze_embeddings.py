"""Phase 3: use CLIP embeddings to fix image kinds and find similar artworks.

1. Image kinds: an "artwork" right after the intro (positions 1–2) that CLIP is
   confident is a *photograph* of a person is almost always the artist's portrait,
   not their work. Those go to <ARCHIVE_ROOT>/derived/image_kinds.jsonl. Left
   alone: later positions, painted/drawn portraits, theme posts (no one artist)
   and photographers, whose own pictures of people are their art.
2. Similar works: the 12 nearest artworks by other posts, by cosine similarity,
   to <ARCHIVE_ROOT>/derived/similar.jsonl.

Also writes site/public/review/kinds.html, a contact sheet of a random sample of
re-classified images for checking by eye. Run embed_images.py and build_db.py first.
Needs the .venv: .venv/bin/python scripts/analyze_embeddings.py
"""
import html
import json
import random
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aotd.config import DB_PATH, DERIVED_DIR  # noqa: E402
from embed_images import EMB, KEYS, load_model  # noqa: E402
from export_site_data import disciplines_for  # noqa: E402

KINDS_OUT = DERIVED_DIR / "image_kinds.jsonl"
SIMILAR_OUT = DERIVED_DIR / "similar.jsonl"
REVIEW = Path(__file__).resolve().parent.parent / "site" / "public" / "review" / "kinds.html"
PORTRAIT_POSITIONS = (1, 2)
PORTRAIT_THRESHOLD = 0.85
PHOTO_THRESHOLD = 0.8
NEIGHBOURS = 12

PROMPTS = {
    "person": ["a photo of a person", "a portrait photograph of an artist",
               "a photo of an artist in their studio", "a black and white photo of a man",
               "a photo of a smiling woman", "a headshot of a person"],
    "artwork": ["a painting", "a sculpture", "a poster design", "an illustration", "a drawing",
                "a ceramic vase", "a building", "an art print", "a logo design",
                "an abstract artwork", "a photograph of a landscape", "a typography design",
                "a painted portrait of a person", "a self-portrait painting", "a caricature",
                "a photograph of an animal"],
    "collage": ["a collage of several artworks", "a grid of many small images"],
}


# Medium: is it a photograph at all, or a painting/drawing of someone?
MEDIUM = {
    "photo": ["a photograph", "a photo taken with a camera", "a black and white photograph"],
    "made": ["a painting", "an oil painting", "a drawing", "a sketch", "an illustration",
             "a caricature", "a print", "a poster", "a digital illustration"],
}


def text_embeddings(model, tokenizer, device, prompts=PROMPTS):
    classes, vecs = [], []
    with torch.no_grad():
        for name, prompts in prompts.items():
            t = model.encode_text(tokenizer(prompts).to(device))
            t = t / t.norm(dim=-1, keepdim=True)
            m = t.mean(0)
            vecs.append(m / m.norm())
            classes.append(name)
    return classes, torch.stack(vecs)


def main():
    keys = [tuple(k) for k in json.loads(KEYS.read_text())]
    emb = torch.from_numpy(np.load(EMB).astype(np.float32))
    index = {k: i for i, k in enumerate(keys)}

    db = sqlite3.connect(DB_PATH)
    rows = db.execute(
        "SELECT i.post_id, i.url_hash, i.position, i.kind, i.kind_source, i.src_url, p.subject "
        "FROM images i JOIN posts p ON p.id = i.post_id").fetchall()
    # Posts eligible for portrait detection: one artist, who isn't a photographer.
    eligible = set()
    for post_id, kind, descriptor, roles in db.execute(
            "SELECT p.id, p.kind, p.descriptor, a.roles FROM posts p "
            "JOIN post_artists pa ON pa.post_id = p.id JOIN artists a ON a.id = pa.artist_id"):
        if kind != "theme" and "photography" not in disciplines_for(json.loads(roles), descriptor):
            eligible.add(post_id)
    db.close()

    model, _, tokenizer, device = load_model()
    classes, text = text_embeddings(model, tokenizer, device)
    m_classes, m_text = text_embeddings(model, tokenizer, device, MEDIUM)
    emb = emb.to(device)
    probs = (100 * emb @ text.T).softmax(dim=-1)[:, classes.index("person")].cpu().numpy()
    photo = (100 * emb @ m_text.T).softmax(dim=-1)[:, m_classes.index("photo")].cpu().numpy()

    # 1. Image kinds
    changed = []
    artworks = []
    for post_id, h, pos, kind, source, src, subject in rows:
        i = index.get((post_id, h))
        if i is None:
            continue
        heuristic_kind = "artwork" if source == "clip" else kind
        if heuristic_kind != "artwork":
            continue
        if (pos in PORTRAIT_POSITIONS and post_id in eligible
                and probs[i] >= PORTRAIT_THRESHOLD and photo[i] >= PHOTO_THRESHOLD):
            changed.append({"post_id": post_id, "url_hash": h, "kind": "portrait",
                            "p_person": round(float(probs[i]), 3), "subject": subject, "src": src})
        else:
            artworks.append(i)
    with open(KINDS_OUT, "w") as f:
        for c in changed:
            f.write(json.dumps({k: c[k] for k in ("post_id", "url_hash", "kind", "p_person")}) + "\n")
    print(f"{len(changed)} artworks re-classified as portraits -> {KINDS_OUT}")
    write_review(random.Random(0).sample(changed, min(60, len(changed))))

    # 2. Similar artworks from other posts
    art = torch.tensor(artworks, device=device)
    art_emb = emb[art]
    art_post = [keys[i][0] for i in artworks]
    start = time.time()
    with open(SIMILAR_OUT, "w") as f:
        for s in range(0, len(artworks), 2048):
            sims = art_emb[s:s + 2048] @ art_emb.T
            top = sims.topk(NEIGHBOURS * 4, dim=1)
            vals, idxs = top.values.cpu().numpy(), top.indices.cpu().numpy()
            for r in range(idxs.shape[0]):
                me = s + r
                nbrs = [(int(j), float(v)) for j, v in zip(idxs[r], vals[r])
                        if art_post[j] != art_post[me]][:NEIGHBOURS]
                f.write(json.dumps({"post_id": keys[artworks[me]][0], "url_hash": keys[artworks[me]][1],
                                    "similar": [[*keys[artworks[j]], round(v, 3)] for j, v in nbrs]}) + "\n")
    print(f"similar works for {len(artworks)} artworks in {time.time() - start:.0f}s -> {SIMILAR_OUT}")


def write_review(sample):
    REVIEW.parent.mkdir(parents=True, exist_ok=True)
    cards = "".join(
        f'<figure><img src="{html.escape(c["src"])}" loading="lazy">'
        f'<figcaption>{html.escape(c["subject"] or "")} · p={c["p_person"]}</figcaption></figure>'
        for c in sample)
    REVIEW.write_text(
        "<!doctype html><meta charset=utf-8><title>CLIP portrait review</title>"
        "<style>body{font:13px system-ui;margin:16px;background:#f4f1ea}"
        "main{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}"
        "img{width:100%;height:180px;object-fit:cover;border-radius:4px}figure{margin:0}</style>"
        f"<h1>{len(sample)} random images re-classified as artist portraits</h1><main>{cards}</main>")
    print(f"review sheet -> {REVIEW} (served at /review/kinds.html)")


if __name__ == "__main__":
    main()
