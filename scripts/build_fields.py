"""Experience v1: lay every artwork out on a grid for the zoomable field views.

Two layouts, each a W×H grid with at most one artwork per cell:
  colour        chromatic works sorted by main hue (columns) and lightness (rows),
                black-and-white works in their own band on the left
  constellation a 2D UMAP of the CLIP embeddings, snapped to the grid, so visually
                similar works sit together; clusters are named by CLIP

For each layout, writes site/public/fields/<name>/:
  layout.json     grid size, chunk size, which chunks exist, labels
  cells.bin       Int32 per cell: row index into artworks.json, or -1
  overview.webp   the whole field at 8px per cell
  chunks/x_y.webp 32×32-cell tiles at 32px per cell (map-style, loaded on zoom)

Run after export_site_data.py. Needs the .venv: .venv/bin/python scripts/build_fields.py
"""
import json
import math
import os
import shutil
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from numba import njit
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aotd.config import DERIVED_DIR, THUMBS_DIR  # noqa: E402

SITE_DATA = Path(__file__).resolve().parent.parent / "site" / "public" / "data"
OUT = Path(__file__).resolve().parent.parent / "site" / "public" / "fields"
TILE = 32       # px per cell in chunk images
OVERVIEW = 8    # px per cell in the overview image
CHUNK = 32      # cells per chunk side
TILE_CACHE = DERIVED_DIR / "fields" / "tiles32.npy"
TILE_KEYS = DERIVED_DIR / "fields" / "tiles32_keys.json"
Image.MAX_IMAGE_PIXELS = None  # the full-resolution field is built in memory

CLUSTER_PROMPTS = [
    "portrait paintings", "landscape paintings", "abstract paintings", "still life paintings",
    "religious paintings", "nude figures", "cityscapes", "seascapes", "interiors",
    "bronze sculptures", "figurative sculpture", "abstract sculpture", "public sculpture outdoors",
    "kinetic sculpture", "ceramic vases", "ceramic figures", "glass art", "jewelry",
    "furniture", "chairs", "lamps", "product design", "cars", "fashion", "hats", "shoes",
    "textile patterns", "quilts", "typographic posters", "movie posters", "travel posters",
    "music posters", "logos and brand identity", "packaging design", "book covers",
    "album covers", "stamps", "magazine layouts", "architecture", "buildings at night",
    "houses", "street murals", "graffiti", "black and white photography",
    "portrait photography", "fashion photography", "documentary photography",
    "landscape photography", "comic illustrations", "children's book illustrations",
    "cartoon characters", "editorial illustration", "botanical illustrations",
    "pencil drawings", "watercolors", "woodcut prints", "Japanese prints", "collages",
    "geometric abstraction", "pop art", "surrealist art", "op art", "installations in galleries",
    "neon light art", "digital art", "3D renderings", "masks", "toys", "dolls",
    "Aboriginal dot painting", "African art", "Indian art", "calligraphy", "maps",
    "flowers", "trees", "animals", "horses", "birds", "faces", "hands", "crowds of people",
    "dancers", "musicians", "children", "women in dresses", "men in suits", "self-portraits",
    "ships and boats", "mountains", "the desert", "winter scenes", "food",
]


def grid_size(n, slack, aspect=1.6):
    h = math.ceil(math.sqrt(n * slack / aspect))
    return math.ceil(n * slack / h), h


def load_tile(path):
    try:
        with Image.open(path) as im:
            im = im.convert("RGBA")
            bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
            im = Image.alpha_composite(bg, im).convert("RGB")
            side = min(im.size)
            left, top = (im.width - side) // 2, (im.height - side) // 2
            im = im.crop((left, top, left + side, top + side)).resize((TILE, TILE), Image.LANCZOS)
            return np.asarray(im, dtype=np.uint8)
    except Exception:
        return np.full((TILE, TILE, 3), 200, np.uint8)


def load_tiles(keys, paths):
    """32px square tiles for every artwork, cached between runs."""
    if TILE_CACHE.exists() and json.loads(TILE_KEYS.read_text()) == keys:
        return np.load(TILE_CACHE)
    print(f"making {len(paths)} 32px tiles", flush=True)
    with ProcessPoolExecutor(os.cpu_count()) as pool:
        tiles = np.stack(list(pool.map(load_tile, paths, chunksize=256)))
    TILE_CACHE.parent.mkdir(parents=True, exist_ok=True)
    np.save(TILE_CACHE, tiles)
    TILE_KEYS.write_text(json.dumps(keys))
    return tiles


def hls(hex_):
    import colorsys
    r, g, b = (int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return colorsys.rgb_to_hls(r, g, b)


def colour_layout(keys, colours):
    """Chromatic works fill columns in hue order, light to dark down each column;
    black-and-white works fill a band on the left, light to dark."""
    chroma, neutral = [], []
    for i, k in enumerate(keys):
        c = colours.get(k)
        best, chromatic_weight = None, 0.0
        for hex_, w in (c["palette"] if c else []):
            h, l, s = hls(hex_)
            if s >= 0.2 and 0.1 < l < 0.92:
                chromatic_weight += w
                if best is None or w > best[1]:
                    best = (h, w)
        lightness = c["lightness"] if c else 0.5
        if best and chromatic_weight >= 0.15:
            chroma.append(((best[0] + 0.03) % 1.0, lightness, i))  # start the spectrum at red
        else:
            neutral.append((lightness, i))
    n = len(keys)
    W, H = grid_size(n, 1.0)
    wn = max(1, round(W * len(neutral) / n))
    pos = np.zeros((n, 2), np.int32)

    def fill(items, x0, width, sort_column):
        per_col = math.ceil(len(items) / width)
        for c in range(width):
            col = sort_column(items[c * per_col:(c + 1) * per_col])
            for r, item in enumerate(col):
                pos[item[-1]] = (x0 + c, r)
        return per_col

    neutral.sort(key=lambda t: -t[0])
    rows_n = fill(neutral, 0, wn, lambda col: sorted(col, key=lambda t: -t[0]))
    chroma.sort(key=lambda t: t[0])
    rows_c = fill(chroma, wn, W - wn, lambda col: sorted(col, key=lambda t: -t[1]))
    H = max(rows_n, rows_c)

    labels = [{"text": "Black & white", "x": wn / 2, "y": -1}]
    names = [("Red", 0.0), ("Orange", 0.07), ("Yellow", 0.14), ("Green", 0.3), ("Teal", 0.47),
             ("Blue", 0.6), ("Purple", 0.74), ("Pink", 0.86)]
    hues = np.array([t[0] for t in chroma])
    per_col = math.ceil(len(chroma) / (W - wn))
    for text, h in names:
        idx = int(np.searchsorted(hues, h))
        if idx < len(chroma):
            labels.append({"text": text, "x": wn + idx // per_col + 0.5, "y": -1})
    return W, H, pos, labels, "top"


@njit(cache=True)
def snap(targets, W, H, offsets):
    """Place each point in the nearest free cell (by precomputed spiral offsets)."""
    occupied = np.zeros((H, W), np.bool_)
    out = np.full_like(targets, -1)
    for i in range(targets.shape[0]):
        tx, ty = targets[i, 0], targets[i, 1]
        for j in range(offsets.shape[0]):
            x, y = tx + offsets[j, 0], ty + offsets[j, 1]
            if 0 <= x < W and 0 <= y < H and not occupied[y, x]:
                occupied[y, x] = True
                out[i, 0], out[i, 1] = x, y
                break
    return out


def constellation_layout(keys, emb_index, emb):
    import umap
    from sklearn.cluster import KMeans

    vecs = np.stack([emb[emb_index[k]] for k in keys]).astype(np.float32)
    print("UMAP over", len(vecs), "embeddings", flush=True)
    start = time.time()
    xy = umap.UMAP(n_neighbors=30, min_dist=0.15, metric="cosine", random_state=7,
                   low_memory=True).fit_transform(vecs)
    print(f"  {time.time() - start:.0f}s", flush=True)

    n = len(keys)
    W, H = grid_size(n, 1.7)
    lo, hi = np.percentile(xy, 0.5, axis=0), np.percentile(xy, 99.5, axis=0)
    span = hi - lo
    scale = min((W - 4) / span[0], (H - 4) / span[1])
    targets = np.clip(((xy - lo) * scale + 2), 0, [W - 1, H - 1]).astype(np.int32)
    r = 140
    off = np.array([(dx, dy) for dx in range(-r, r + 1) for dy in range(-r, r + 1)], np.int32)
    off = off[np.argsort((off ** 2).sum(1), kind="stable")]
    order = np.random.default_rng(7).permutation(n)
    pos = np.empty((n, 2), np.int32)
    pos[order] = snap(targets[order], W, H, off)
    stranded = np.where(pos[:, 0] < 0)[0]
    if len(stranded):  # nothing free within the search radius: use any free cell
        taken = set(map(tuple, pos[pos[:, 0] >= 0]))
        free = ((x, y) for y in range(H) for x in range(W) if (x, y) not in taken)
        for i in stranded:
            pos[i] = next(free)
        print(f"  {len(stranded)} points placed in leftover cells", flush=True)

    # Name clusters: k-means on the layout, then the CLIP prompt closest to each
    # cluster's mean embedding (each prompt used once).
    k = 40
    km = KMeans(n_clusters=k, n_init=4, random_state=7).fit(pos.astype(np.float32))
    import torch
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from embed_images import load_model
    model, _, tokenizer, device = load_model()
    with torch.no_grad():
        t = model.encode_text(tokenizer([f"a collection of {p}" for p in CLUSTER_PROMPTS]).to(device))
        t = (t / t.norm(dim=-1, keepdim=True)).float().cpu().numpy()
    means = np.stack([vecs[km.labels_ == c].mean(0) for c in range(k)])
    means /= np.linalg.norm(means, axis=1, keepdims=True)
    sims = means @ t.T
    labels, used = [], set()
    for c in np.argsort(-sims.max(1)):
        for p in np.argsort(-sims[c]):
            if p not in used:
                used.add(p)
                members = pos[km.labels_ == c]
                labels.append({"text": CLUSTER_PROMPTS[p].capitalize(),
                               "x": float(np.median(members[:, 0])) + 0.5,
                               "y": float(np.median(members[:, 1])) + 0.5,
                               "size": int((km.labels_ == c).sum())})
                break
    return W, H, pos, labels, "cloud"


def render(name, W, H, pos, tiles, labels, label_style):
    out = OUT / name
    shutil.rmtree(out, ignore_errors=True)
    (out / "chunks").mkdir(parents=True)
    cells = np.full(W * H, -1, np.int32)
    cells[pos[:, 1] * W + pos[:, 0]] = np.arange(len(pos), dtype=np.int32)
    (out / "cells.bin").write_bytes(cells.tobytes())

    rgba = np.zeros((H * TILE, W * TILE, 4), np.uint8)  # whole field at 32px per cell
    for i, (x, y) in enumerate(pos):
        rgba[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE, :3] = tiles[i]
        rgba[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE, 3] = 255
    chunks = []
    for cy in range(math.ceil(H / CHUNK)):
        for cx in range(math.ceil(W / CHUNK)):
            block = rgba[cy * CHUNK * TILE:(cy + 1) * CHUNK * TILE, cx * CHUNK * TILE:(cx + 1) * CHUNK * TILE]
            if block[..., 3].any():
                Image.fromarray(block, "RGBA").save(out / "chunks" / f"{cx}_{cy}.webp", "WEBP",
                                                    quality=78, method=4)
                chunks.append(f"{cx}_{cy}")
    small = Image.fromarray(rgba, "RGBA").resize((W * OVERVIEW, H * OVERVIEW), Image.BOX)
    small.save(out / "overview.webp", "WEBP", quality=82, method=4)
    (out / "layout.json").write_text(json.dumps({
        "name": name, "width": W, "height": H, "count": int(len(pos)), "tile": TILE,
        "overview": OVERVIEW, "chunk": CHUNK, "chunks": chunks, "labelStyle": label_style,
        "labels": labels,
    }))
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file()) / 1e6
    print(f"{name}: {W}×{H} grid, {len(chunks)} chunks, {size:.0f} MB -> {out}", flush=True)


def main():
    site = json.loads((SITE_DATA / "site.json").read_text())
    rows = json.loads((SITE_DATA / "artworks.json").read_text())["rows"]
    posts = site["posts"]
    keys = [[posts[r[0]]["id"], r[1].split("_", 1)[1].split(".")[0]] for r in rows]
    paths = [THUMBS_DIR / posts[r[0]]["dir"] / (Path(r[1]).stem + ".webp") for r in rows]
    tiles = load_tiles(keys, paths)

    colours = {}
    with open(DERIVED_DIR / "colors.jsonl") as f:
        for r in map(json.loads, f):
            if "error" not in r:
                colours[(r["post_id"], r["url_hash"])] = r
    tkeys = [tuple(k) for k in keys]
    W, H, pos, labels, style = colour_layout(tkeys, colours)
    render("colour", W, H, pos, tiles, labels, style)

    clip_keys = json.loads((DERIVED_DIR / "clip" / "keys.json").read_text())
    emb = np.load(DERIVED_DIR / "clip" / "embeddings.npy")
    emb_index = {tuple(k): i for i, k in enumerate(clip_keys)}
    W, H, pos, labels, style = constellation_layout(tkeys, emb_index, emb)
    render("constellation", W, H, pos, tiles, labels, style)


if __name__ == "__main__":
    main()
