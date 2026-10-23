"""Experience v1: lay every artwork out on a grid for the zoomable field views.

Three layouts, each a W×H grid with at most one artwork per cell:
  colour         a colour wheel: angle = hue, distance from the centre = how vivid
                 (OKLCH, centre-weighted so backgrounds count less); greys at the core
  colour-vivid   the same wheel for only the most colourful quarter of the works
  constellation  an archipelago: works clustered by their CLIP embeddings, each
                 cluster a compact island arranged by a UMAP, islands spread out by
                 visual relatedness with water between them; islands and the
                 regions within them are named by CLIP

For each layout, writes site/public/fields/<name>/:
  layout.json     grid size, chunk size, which chunks exist, labels (with zoom level)
  cells.bin       Int32 per cell: row index into artworks.json, or -1
  overview.webp   the whole field at 8px per cell
  chunks/x_y.webp 32×32-cell tiles at 32px per cell (map-style, loaded on zoom)

Run after export_site_data.py. Needs the .venv: .venv/bin/python scripts/build_fields.py
"""
import hashlib
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
CACHE = DERIVED_DIR / "fields"
TILE = 32       # px per cell in chunk images
OVERVIEW = 8    # px per cell in the overview image
CHUNK = 32      # cells per chunk side
Image.MAX_IMAGE_PIXELS = None  # the full-resolution field is built in memory

ISLANDS = 48            # clusters in the constellation
ISLAND_GAP = 5          # cells of water between islands
VIVID_SHARE = 0.25      # the most colourful quarter goes in the vivid wheel
NEUTRAL_CHROMA = 0.02   # OKLCH chroma below which a work counts as grey (~30% of works)
HUE_NAMES = [("Red", 25), ("Orange", 55), ("Yellow", 100), ("Green", 145), ("Teal", 195),
             ("Blue", 255), ("Purple", 300), ("Pink", 345)]

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
    "skyscrapers", "bridges", "churches", "gardens", "rivers", "beaches", "forests", "night skies",
    "industrial machines", "trains", "aircraft", "bicycles", "weapons", "soldiers", "war scenes",
    "mythological scenes", "angels", "skulls", "insects", "fish", "cats", "dogs", "horses racing",
    "circus performers", "sports", "cafés and bars", "street scenes", "markets", "farm life",
    "workers", "couples", "mothers and children", "old people", "eyes", "lips", "hair",
    "hats and headwear", "tattoos", "wire sculpture", "wood carving", "stone carving",
    "paper cutouts", "embroidery", "mosaics", "stained glass", "ceramic tiles", "vessels and bowls",
    "letterforms", "infographics", "patterns and repeats", "grids", "circles", "stripes",
    "monochrome red", "monochrome blue", "pastel colours", "gold", "silhouettes", "shadows",
]


def grid_size(n, slack, aspect=1.6):
    h = math.ceil(math.sqrt(n * slack / aspect))
    return math.ceil(n * slack / h), h


# ── tiles ───────────────────────────────────────────────────────────────────────

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


def keys_digest(keys):
    return hashlib.sha1(json.dumps(keys).encode()).hexdigest()


def cached(name, keys, compute):
    """np.save cache keyed by the artwork list, so re-runs skip slow steps."""
    path, tag = CACHE / f"{name}.npy", CACHE / f"{name}.key"
    digest = keys_digest(keys)
    if path.exists() and tag.exists() and tag.read_text() == digest:
        return np.load(path)
    value = compute()
    CACHE.mkdir(parents=True, exist_ok=True)
    np.save(path, value)
    tag.write_text(digest)
    return value


def load_tiles(keys, paths):
    old_keys = CACHE / "tiles32_keys.json"  # earlier cache format: adopt it if it matches
    if old_keys.exists() and json.loads(old_keys.read_text()) == keys:
        (CACHE / "tiles32.key").write_text(keys_digest(keys))
        old_keys.unlink()

    def compute():
        print(f"making {len(paths)} 32px tiles", flush=True)
        with ProcessPoolExecutor(os.cpu_count()) as pool:
            return np.stack(list(pool.map(load_tile, paths, chunksize=256)))
    return cached("tiles32", keys, compute)


# ── colour wheel ────────────────────────────────────────────────────────────────

def oklch_summary(tiles):
    """Per tile: centre-weighted lightness and chroma, and chroma-weighted hue (degrees)."""
    yy, xx = np.mgrid[0:TILE, 0:TILE]
    c = (TILE - 1) / 2
    centre = np.exp(-(((xx - c) ** 2 + (yy - c) ** 2) / (2 * (TILE * 0.32) ** 2))).ravel()
    out = np.zeros((len(tiles), 3), np.float32)
    for s in range(0, len(tiles), 4096):
        rgb = tiles[s:s + 4096].reshape(-1, TILE * TILE, 3).astype(np.float32) / 255
        lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
        r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
        l_ = np.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        m_ = np.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        s_ = np.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
        A = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
        B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
        C = np.hypot(A, B)
        w = centre * C  # vivid pixels near the middle decide the hue
        hue = np.degrees(np.arctan2((w * B / np.maximum(C, 1e-6)).sum(1),
                                    (w * A / np.maximum(C, 1e-6)).sum(1))) % 360
        out[s:s + 4096, 0] = (centre * L).sum(1) / centre.sum()
        out[s:s + 4096, 1] = (centre * C).sum(1) / centre.sum()
        out[s:s + 4096, 2] = hue
    return out


def wheel_layout(rows, colour):
    """A polar-area 'flower'. Greys form a solid core, lightest at the centre, laid
    out on a sunflower spiral. Around it, each hue is a petal at its true angle (red
    at the top, clockwise), as long as that hue is common, filled from muted works at
    the base to vivid ones at the tip."""
    light, chroma, hue = colour[rows, 0], colour[rows, 1], colour[rows, 2]
    n = len(rows)
    area = 1.0  # cells per work: packed solid, so petals have no holes
    neutral = chroma < NEUTRAL_CHROMA
    radius = np.zeros(n)
    theta = np.zeros(n)

    core = np.where(neutral)[0]
    core = core[np.argsort(-light[core])]  # lightest first, at the centre
    k = np.arange(len(core))
    radius[core] = np.sqrt((k + 0.5) * area / math.pi)
    theta[core] = k * math.pi * (3 - math.sqrt(5))  # golden angle
    r_core = math.sqrt(len(core) * area / math.pi)

    bins = 72
    width = 2 * math.pi / bins
    rim = np.where(~neutral)[0]
    b = (hue[rim] / 360 * bins).astype(int) % bins
    counts = np.bincount(b, minlength=bins).astype(float)
    # Smooth petal lengths across neighbouring hues so the outline isn't jagged.
    kernel = np.array([1, 2, 3, 2, 1], float) / 9
    smooth = np.convolve(np.concatenate([counts[-2:], counts, counts[:2]]), kernel, "valid")
    for bi in range(bins):
        members = rim[b == bi]
        if not len(members):
            continue
        members = members[np.argsort(chroma[members])]  # muted at the base, vivid at the tip
        f = (np.arange(len(members)) + 0.5) / len(members)
        radius[members] = np.sqrt(r_core ** 2 + 2 * area * smooth[bi] * f / width)
        theta[members] = np.radians(hue[members] - 25)

    pad = 40
    size = int(2 * radius.max() + 2 * pad)
    targets = np.stack([size / 2 + radius * np.sin(theta), size / 2 - radius * np.cos(theta)], 1)
    pos = snap_in_order(np.rint(targets).astype(np.int32), size, size, np.argsort(radius), radius=80)
    pos, W, H, offset = crop(pos, margin=6)

    cx, cy = size / 2 - offset[0], size / 2 - offset[1]
    labels = []
    for text, h in HUE_NAMES:
        t = math.radians(h - 25)
        reach = max(r_core + 6, furthest(pos, cx, cy, t) + 4)
        labels.append({"text": text, "x": cx + reach * math.sin(t), "y": cy - reach * math.cos(t),
                       "size": 4000, "level": 0})
    if len(core):
        labels.append({"text": "Greys, black & white", "x": cx, "y": cy, "size": 1500, "level": 1})
    return W, H, pos, labels


def furthest(pos, cx, cy, theta, width=0.06):
    ang = np.arctan2(pos[:, 0] - cx, -(pos[:, 1] - cy))
    diff = np.abs((ang - theta + np.pi) % (2 * np.pi) - np.pi)
    sel = pos[diff < width]
    return float(np.hypot(sel[:, 0] - cx, sel[:, 1] - cy).max()) if len(sel) else 0.0


# ── placement helpers ───────────────────────────────────────────────────────────

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


def spiral(radius):
    off = np.array([(dx, dy) for dx in range(-radius, radius + 1) for dy in range(-radius, radius + 1)],
                   np.int32)
    return off[np.argsort((off ** 2).sum(1), kind="stable")]


def snap_in_order(targets, W, H, order, radius=140):
    pos = np.empty_like(targets)
    pos[order] = snap(targets[order], W, H, spiral(radius))
    stranded = np.where(pos[:, 0] < 0)[0]
    if len(stranded):  # nothing free within the search radius: use any free cell
        taken = set(map(tuple, pos[pos[:, 0] >= 0]))
        free = ((x, y) for y in range(H) for x in range(W) if (x, y) not in taken)
        for i in stranded:
            pos[i] = next(free)
        print(f"  {len(stranded)} points placed in leftover cells", flush=True)
    return pos


def crop(pos, margin):
    """Shift positions so the occupied area starts at `margin`.
    Returns (pos, W, H, offset subtracted)."""
    lo = pos.min(0) - margin
    pos = pos - lo
    W, H = (pos.max(0) + margin + 1).tolist()
    return pos.astype(np.int32), int(W), int(H), lo


# ── constellation ───────────────────────────────────────────────────────────────

def clip_text(prompts):
    import torch
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from embed_images import load_model
    model, _, tokenizer, device = load_model()
    with torch.no_grad():
        t = model.encode_text(tokenizer([f"a collection of {p}" for p in prompts]).to(device))
        return (t / t.norm(dim=-1, keepdim=True)).float().cpu().numpy()


def name_groups(vecs, groups, text, exclude=()):
    """Greedy unique names: each group gets the closest prompt not already used.
    Returns (names, prompt indices)."""
    means = np.stack([vecs[g].mean(0) for g in groups])
    means /= np.linalg.norm(means, axis=1, keepdims=True)
    sims = means @ text.T
    names, idxs, used = [None] * len(groups), [None] * len(groups), set(exclude)
    for gi in np.argsort(-sims.max(1)):
        for p in np.argsort(-sims[gi]):
            if p not in used:
                used.add(p)
                names[gi] = CLUSTER_PROMPTS[p][0].upper() + CLUSTER_PROMPTS[p][1:]
                idxs[gi] = int(p)
                break
    return names, idxs


def relax(centres, radii, gap, iters=1500):
    """Pack the islands: a gentle pull towards the middle (gravity) and back towards
    where UMAP put each one, with overlapping circles pushed apart to `gap` cells."""
    home = centres.copy()
    p = centres.copy()
    for i in range(iters):
        p += (home - p) * 0.004 + (p.mean(0) - p) * 0.02
        for _ in range(4):  # resolve overlaps after each pull
            d = p[:, None, :] - p[None, :, :]
            dist = np.linalg.norm(d, axis=2) + np.eye(len(p))
            need = radii[:, None] + radii[None, :] + gap
            overlap = np.clip(need - dist, 0, None)
            np.fill_diagonal(overlap, 0)
            p += (d / dist[..., None] * overlap[..., None] / 2).sum(1)
    return p


def constellation_layout(keys, vecs):
    import umap
    from sklearn.cluster import KMeans, MiniBatchKMeans

    n = len(keys)
    xy = cached("umap2d", keys, lambda: umap.UMAP(
        n_neighbors=30, min_dist=0.15, metric="cosine", random_state=7, low_memory=True
    ).fit_transform(vecs).astype(np.float32))

    print("clustering embeddings into islands", flush=True)
    labels_ = MiniBatchKMeans(n_clusters=ISLANDS, batch_size=8192, n_init=5,
                              random_state=7).fit_predict(vecs)
    groups = [np.where(labels_ == c)[0] for c in range(ISLANDS)]
    groups = [g for g in groups if len(g)]
    radii = np.array([math.sqrt(len(g) * 1.08 / math.pi) for g in groups])

    # Island centres start where UMAP puts each cluster, scaled so islands of this
    # size would just about touch, then get pushed apart.
    centres = np.stack([np.median(xy[g], 0) for g in groups])
    centres -= centres.mean(0)
    nn = np.sort(np.linalg.norm(centres[:, None] - centres[None], axis=2), 1)[:, 1].mean()
    centres *= (radii.mean() * 2 + ISLAND_GAP) / max(nn, 1e-6)
    centres = relax(centres, radii, ISLAND_GAP)

    # Inside an island, keep the UMAP arrangement but squeeze it into a disc.
    targets = np.zeros((n, 2), np.float64)
    local_r = np.zeros(n)
    for g, c, r in zip(groups, centres, radii):
        local = xy[g] - np.median(xy[g], 0)
        dist = np.linalg.norm(local, axis=1)
        scale = r * 0.9 / max(np.percentile(dist, 90), 1e-6)
        local = local * scale
        far = np.linalg.norm(local, axis=1)
        local[far > r] *= (r / far[far > r])[:, None]
        targets[g] = c + local
        local_r[g] = np.linalg.norm(local, axis=1)
    pad = 40
    targets -= targets.min(0) - pad
    W, H = (targets.max(0) + pad).astype(int) + 1
    pos = snap_in_order(np.rint(targets).astype(np.int32), int(W), int(H), np.argsort(local_r))
    pos, W, H, _ = crop(pos, margin=8)

    # Names: islands first, then the regions within the larger islands.
    print("naming islands", flush=True)
    text = clip_text(CLUSTER_PROMPTS)
    island_names, island_prompts = name_groups(vecs, groups, text)
    labels = []
    for g, name, prompt in zip(groups, island_names, island_prompts):
        labels.append({"text": name, "x": float(np.median(pos[g, 0])) + 0.5,
                       "y": float(np.median(pos[g, 1])) + 0.5, "size": int(len(g)), "level": 0})
        if len(g) < 900:
            continue
        k = int(min(6, max(2, len(g) // 700)))
        sub = KMeans(n_clusters=k, n_init=3, random_state=7).fit_predict(vecs[g])
        subs = [g[sub == s] for s in range(k) if (sub == s).sum() >= 80]
        sub_names, _ = name_groups(vecs, subs, text, exclude={prompt})
        for sg, sname in zip(subs, sub_names):
            labels.append({"text": sname, "x": float(np.median(pos[sg, 0])) + 0.5,
                           "y": float(np.median(pos[sg, 1])) + 0.5, "size": int(len(sg)), "level": 1})
    print(f"  {sum(l['level'] == 0 for l in labels)} islands, "
          f"{sum(l['level'] == 1 for l in labels)} regions within them", flush=True)
    return W, H, pos, labels


# ── rendering ───────────────────────────────────────────────────────────────────

def render(name, W, H, rows, pos, tiles, labels):
    """rows[i] (index into artworks.json) is drawn at pos[i]."""
    out = OUT / name
    shutil.rmtree(out, ignore_errors=True)
    (out / "chunks").mkdir(parents=True)
    cells = np.full(W * H, -1, np.int32)
    cells[pos[:, 1] * W + pos[:, 0]] = rows
    (out / "cells.bin").write_bytes(cells.tobytes())

    rgba = np.zeros((H * TILE, W * TILE, 4), np.uint8)  # whole field at 32px per cell
    for row, (x, y) in zip(rows, pos):
        rgba[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE, :3] = tiles[row]
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
        "name": name, "width": W, "height": H, "count": int(len(rows)), "tile": TILE,
        "overview": OVERVIEW, "chunk": CHUNK, "chunks": chunks, "labelStyle": "cloud",
        "labels": labels,
    }))
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file()) / 1e6
    print(f"{name}: {W}×{H} grid, {len(rows)} works, {len(chunks)} chunks, {size:.0f} MB -> {out}",
          flush=True)


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--only", choices=["colour", "constellation"], help="build just one view")
    args = ap.parse_args()
    site = json.loads((SITE_DATA / "site.json").read_text())
    rows = json.loads((SITE_DATA / "artworks.json").read_text())["rows"]
    posts = site["posts"]
    keys = [[posts[r[0]]["id"], r[1].split("_", 1)[1].split(".")[0]] for r in rows]
    paths = [THUMBS_DIR / posts[r[0]]["dir"] / (Path(r[1]).stem + ".webp") for r in rows]
    tiles = load_tiles(keys, paths)
    everyone = np.arange(len(rows), dtype=np.int32)

    if args.only != "constellation":
        build_wheels(keys, tiles, everyone)
    if args.only != "colour":
        build_constellation(keys, tiles, everyone)


def build_wheels(keys, tiles, everyone):
    colour = cached("oklch", keys, lambda: oklch_summary(tiles))
    W, H, pos, labels = wheel_layout(everyone, colour)
    render("colour", W, H, everyone, pos, tiles, labels)
    vivid = np.argsort(-colour[:, 1])[:int(len(everyone) * VIVID_SHARE)].astype(np.int32)
    W, H, pos, labels = wheel_layout(vivid, colour)
    render("colour-vivid", W, H, vivid, pos, tiles, labels)


def build_constellation(keys, tiles, everyone):
    clip_keys = json.loads((DERIVED_DIR / "clip" / "keys.json").read_text())
    emb = np.load(DERIVED_DIR / "clip" / "embeddings.npy")
    emb_index = {tuple(k): i for i, k in enumerate(clip_keys)}
    vecs = np.stack([emb[emb_index[tuple(k)]] for k in keys]).astype(np.float32)
    start = time.time()
    W, H, pos, labels = constellation_layout(keys, vecs)
    print(f"  layout in {time.time() - start:.0f}s", flush=True)
    render("constellation", W, H, everyone, pos, tiles, labels)


if __name__ == "__main__":
    main()
