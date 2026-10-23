"""Experience v1: lay every artwork out as a galaxy for the zoomable Constellation.

(The Colour Field, Orbits, is laid out in the browser from build_colourmaps.py's data.)

Works are clustered by their CLIP embeddings into star systems. Each system is a dense
core of its most typical works thinning into a sparse halo (an exponential disc, with
a slight spiral twist), placed where a UMAP puts the cluster, so related systems sit
side by side with their haloes overlapping. Works that sit between two systems in
likeness are pulled into the gap between them, forming tidal bridges where related
systems collide. A gentle swirl about the centre turns the whole into a galaxy. Every
work is a star: the most typical in each system shine biggest. Systems, and regions
within the larger ones, are named by CLIP.

Writes site/public/fields/constellation/:
  stars.bin    Float32 (x, y, size, t) per artwork, in artworks.json order: centre and
               diameter in cells, and its order in the entrance (0–1)
  galaxy.json  labels (with zoom level) and links between neighbouring systems

Also caches every artwork's 32px tile, which build_colourmaps.py reuses.
Run after export_site_data.py. Needs the .venv: .venv/bin/python scripts/build_fields.py
(--preview out.png also draws the galaxy as an image, for tuning.)
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
TILE = 32       # px per cached tile

SYSTEMS = 48            # star systems (clusters) in the galaxy
CORE_COVER = 0.85       # share of a system's heart covered by stars, falling off outwards
TWIST = 0.6             # radians a system's edge is turned against its core
SWIRL = 1.6             # radians the galaxy's rim is turned against its centre
BRIDGE_MARGIN = 0.015   # likeness margin below which a work is pulled towards its second system
BRIDGE_REACH = 2.2      # only between systems this many radii apart (neighbours)
LINKS_PER_SYSTEM = 2    # constellation lines from each system to its most alike neighbours

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
    """Spread the system cores: a gentle pull towards the middle (gravity) and back
    towards where UMAP put each one, with overlapping circles pushed apart."""
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


@njit(cache=True)
def separate(pos, rad, iters):
    """Push overlapping stars apart (a little air between them), using a grid of
    cells as wide as the biggest star to find neighbours."""
    n = pos.shape[0]
    cell = 2 * rad.max() * 1.1
    for _ in range(iters):
        x0, y0 = pos[:, 0].min(), pos[:, 1].min()
        gw = int((pos[:, 0].max() - x0) / cell) + 1
        gh = int((pos[:, 1].max() - y0) / cell) + 1
        head = np.full(gw * gh, -1, np.int64)
        nxt = np.full(n, -1, np.int64)
        gx = ((pos[:, 0] - x0) / cell).astype(np.int64)
        gy = ((pos[:, 1] - y0) / cell).astype(np.int64)
        for i in range(n):
            k = gy[i] * gw + gx[i]
            nxt[i] = head[k]
            head[k] = i
        moved = 0
        for i in range(n):
            for dy in range(-1, 2):
                for dx in range(-1, 2):
                    cx, cy = gx[i] + dx, gy[i] + dy
                    if cx < 0 or cy < 0 or cx >= gw or cy >= gh:
                        continue
                    j = head[cy * gw + cx]
                    while j >= 0:
                        if j > i:
                            ddx, ddy = pos[j, 0] - pos[i, 0], pos[j, 1] - pos[i, 1]
                            dist = math.sqrt(ddx * ddx + ddy * ddy) + 1e-9
                            need = (rad[i] + rad[j]) * 1.08
                            if dist < need:
                                push = (need - dist) / 2 / dist
                                pos[i, 0] -= ddx * push
                                pos[i, 1] -= ddy * push
                                pos[j, 0] += ddx * push
                                pos[j, 1] += ddy * push
                                moved += 1
                        j = nxt[j]
        if moved == 0:
            break
    return pos


def turn(p, about, angle):
    """Rotate points p (n×2) about `about` by per-point angles (radians)."""
    d = p - about
    c, s_ = np.cos(angle), np.sin(angle)
    return about + np.stack([d[:, 0] * c - d[:, 1] * s_, d[:, 0] * s_ + d[:, 1] * c], 1)


def galaxy_layout(keys, vecs):
    import umap
    from sklearn.cluster import KMeans, MiniBatchKMeans

    n = len(keys)
    rng = np.random.default_rng(7)
    xy = cached("umap2d", keys, lambda: umap.UMAP(
        n_neighbors=30, min_dist=0.15, metric="cosine", random_state=7, low_memory=True
    ).fit_transform(vecs).astype(np.float32))

    print("clustering embeddings into star systems", flush=True)
    unit = vecs / np.linalg.norm(vecs, axis=1, keepdims=True)
    km = MiniBatchKMeans(n_clusters=SYSTEMS, batch_size=8192, n_init=5, random_state=7).fit(unit)
    own = km.labels_
    centroids = km.cluster_centers_ / np.linalg.norm(km.cluster_centers_, axis=1, keepdims=True)
    sims = unit @ centroids.T
    typical = sims[np.arange(n), own]
    second = np.where(np.arange(SYSTEMS)[None] == own[:, None], -9, sims).argmax(1)
    margin = typical - sims[np.arange(n), second]
    groups = [np.where(own == c)[0] for c in range(SYSTEMS)]

    # Star sizes: brightest at each system's heart, by typicality rank within it.
    rank = np.zeros(n)  # 0 = most typical in its system, towards 1 = least
    for g in groups:
        rank[g[np.argsort(-typical[g])]] = (np.arange(len(g)) + 0.5) / len(g)
    size = 0.55 + 1.7 * (1 - rank) ** 6 + rng.uniform(0, 0.2, n)
    hubs = np.array([g[np.argmax(typical[g])] for g in groups])
    size[hubs] = 3.4

    # Within a system, stars are laid outward from the heart in order of typicality,
    # each at the radius where an exponential disc (CORE_COVER at the centre) has
    # room for all the stars before it: a bright core fading smoothly into a halo.
    dist = np.zeros(n)
    radius = np.zeros(len(groups))  # where 90% of a system's starlight lies
    for c, g in enumerate(groups):
        order = g[np.argsort(rank[g])]
        area = np.cumsum(math.pi * (size[order] / 2) ** 2)
        h = math.sqrt(area[-1] / (2 * math.pi * CORE_COVER))
        r = np.linspace(0, 9 * h, 2000)
        covered = 2 * math.pi * CORE_COVER * h * h * (1 - np.exp(-r / h) * (1 + r / h))
        dist[order] = np.interp(area - math.pi * (size[order] / 2) ** 2 / 2, covered, r)
        radius[c] = 3.9 * h

    # System centres: where UMAP puts each cluster, scaled so neighbouring haloes
    # overlap, cores kept apart.
    centres = np.stack([np.median(xy[g], 0) for g in groups])
    centres -= centres.mean(0)
    nn = np.sort(np.linalg.norm(centres[:, None] - centres[None], axis=2), 1)[:, 1].mean()
    centres *= radius.mean() * 1.6 / max(nn, 1e-6)
    centres = relax(centres, radius * 0.55, 2.0)

    # Within a system: direction from the UMAP (alike works share a side), distance
    # from the exponential disc by typicality, twisted a little like a spiral galaxy.
    pos = np.zeros((n, 2))
    for c, g in enumerate(groups):
        local = xy[g] - np.median(xy[g], 0)
        r = dist[g]
        theta = np.arctan2(local[:, 1], local[:, 0]) + TWIST * r / radius[c]
        pos[g] = centres[c] + np.stack([np.cos(theta), np.sin(theta)], 1) * r[:, None]

    # Tidal bridges: works nearly as alike to a second system are drawn into the
    # space between the two, scattered across the gap like a stream.
    a, b = centres[own], centres[second]
    gap = b - a
    span = np.linalg.norm(gap, axis=1, keepdims=True) + 1e-9
    near = span[:, 0] < BRIDGE_REACH * (radius[own] + radius[second]) / 2
    pull = np.where(near, np.clip(1 - margin / BRIDGE_MARGIN, 0, 1) ** 1.5, 0)
    perp = np.stack([-gap[:, 1], gap[:, 0]], 1) / span
    along = np.clip(rng.normal(0.42, 0.13, n), 0.15, 0.75)[:, None]  # mostly on its own side
    bridge = a + gap * along + perp * rng.normal(0, 0.035, n)[:, None] * span
    pos = pos + (bridge - pos) * (pull * 0.9)[:, None]

    # The galaxy's swirl: each system turned mostly as a whole (so it keeps its
    # shape), the streams between them bending with it; then stars nudged apart so
    # none overlap.
    middle = np.average(pos, axis=0, weights=size)
    d = np.linalg.norm(pos - middle, axis=1)
    d_system = np.linalg.norm(centres[own] - middle, axis=1)
    reach = d.max()
    pos = turn(pos, middle, SWIRL * (0.7 * (d_system / reach) ** 0.8 + 0.3 * (d / reach) ** 0.8))
    print("separating stars", flush=True)
    pos = separate(pos.astype(np.float64), (size / 2).astype(np.float64), 60)
    pos -= pos.mean(0)

    # Entrance order: spiralling out from the centre, each system's heart first.
    d = np.linalg.norm(pos, axis=1)
    t = np.clip(0.6 * d / d.max() + 0.4 * rank, 0, 1)

    # Names: systems first, then regions within the larger ones.
    print("naming systems", flush=True)
    text = clip_text(CLUSTER_PROMPTS)
    names, prompts = name_groups(unit, groups, text)
    hub_pos = pos[hubs]
    labels = []
    for g, name, prompt, h in zip(groups, names, prompts, hub_pos):
        labels.append({"text": name, "x": float(h[0]), "y": float(h[1]), "size": int(len(g)), "level": 0})
        if len(g) < 900:
            continue
        k = int(min(6, max(2, len(g) // 700)))
        sub = KMeans(n_clusters=k, n_init=3, random_state=7).fit_predict(unit[g])
        subs = [g[sub == s_] for s_ in range(k) if (sub == s_).sum() >= 80]
        sub_names, _ = name_groups(unit, subs, text, exclude={prompt})
        for sg, sname in zip(subs, sub_names):
            m = np.median(pos[sg], 0)
            labels.append({"text": sname, "x": float(m[0]), "y": float(m[1]), "size": int(len(sg)), "level": 1})

    # Constellation lines: each system to its most alike neighbours.
    alike = centroids @ centroids.T
    np.fill_diagonal(alike, -1)
    pairs = {tuple(sorted((i, int(j)))) for i in range(SYSTEMS) for j in np.argsort(-alike[i])[:LINKS_PER_SYSTEM]}
    links = [[float(hub_pos[i, 0]), float(hub_pos[i, 1]), float(hub_pos[j, 0]), float(hub_pos[j, 1]),
              round(float(alike[i, j]), 3)] for i, j in sorted(pairs)]
    print(f"  {SYSTEMS} systems, {sum(l['level'] == 1 for l in labels)} regions, {len(links)} links, "
          f"{int((pull > 0.3).sum())} works in bridges", flush=True)
    return pos.astype(np.float32), size.astype(np.float32), t.astype(np.float32), labels, links


def preview(path, pos, size, tiles, links, scale=3):
    """Draw the galaxy as an image: each star a disc of its tile's mean colour."""
    from PIL import ImageDraw
    lo = pos.min(0) - 10
    w, h = ((pos.max(0) + 10 - lo) * scale).astype(int)
    im = Image.new("RGB", (w, h), (20, 18, 16))
    draw = ImageDraw.Draw(im)
    for x1, y1, x2, y2, _ in links:
        draw.line([((x1 - lo[0]) * scale, (y1 - lo[1]) * scale), ((x2 - lo[0]) * scale, (y2 - lo[1]) * scale)],
                  fill=(90, 86, 80), width=1)
    colour = tiles.reshape(len(tiles), -1, 3).mean(1).astype(int)
    for (x, y), d, c in zip((pos - lo) * scale, size * scale / 2, colour):
        draw.ellipse([x - d, y - d, x + d, y + d], fill=tuple(c))
    im.save(path)
    print(f"preview {w}×{h} -> {path}")


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--preview", help="also draw the galaxy to this image")
    args = ap.parse_args()
    site = json.loads((SITE_DATA / "site.json").read_text())
    rows = json.loads((SITE_DATA / "artworks.json").read_text())["rows"]
    posts = site["posts"]
    keys = [[posts[r[0]]["id"], r[1].split("_", 1)[1].split(".")[0]] for r in rows]
    paths = [THUMBS_DIR / posts[r[0]]["dir"] / (Path(r[1]).stem + ".webp") for r in rows]
    tiles = load_tiles(keys, paths)

    clip_keys = json.loads((DERIVED_DIR / "clip" / "keys.json").read_text())
    emb = np.load(DERIVED_DIR / "clip" / "embeddings.npy")
    emb_index = {tuple(k): i for i, k in enumerate(clip_keys)}
    vecs = np.stack([emb[emb_index[tuple(k)]] for k in keys]).astype(np.float32)
    start = time.time()
    pos, size, t, labels, links = galaxy_layout(keys, vecs)
    print(f"  layout in {time.time() - start:.0f}s", flush=True)

    out = OUT / "constellation"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    np.concatenate([pos, size[:, None], t[:, None]], 1).astype("<f4").tofile(out / "stars.bin")
    (out / "galaxy.json").write_text(json.dumps({"count": len(rows), "labels": labels, "links": links}))
    print(f"constellation: {len(rows)} stars -> {out}")
    if args.preview:
        preview(args.preview, pos, size, tiles, links)


if __name__ == "__main__":
    main()
