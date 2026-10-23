"""Data for the Colour maps explorer (site/src/pages/explore/maps.astro).

Writes site/public/fields/maps/:
  atlas-NN.webp  every artwork as a 24px tile, 85×85 per 2048px sheet, in
                 artworks.json row order (sheet = row // 7225)
  atlas.json     tile size, tiles per row and per sheet, sheet count
  colour.bin     Float32 OKLab (L, a, b) per artwork: its tile's centre-weighted
                 mean colour, i.e. how it reads from a distance
  signature.bin  Float32 (L, a, b, share) per artwork: the mean OKLab of its tile's
                 dominant hue among coloured pixels, and the share of the tile it
                 covers (Orbits places works by this: a red-and-white poster is red,
                 where its mean colour would be pink-grey)
  maps.json      Scientific Colour Maps (Crameri, MIT licence), 64 stops each,
                 grouped by type

Run after build_fields.py (it reuses that script's 32px tile cache).
Needs the .venv: .venv/bin/python scripts/build_colourmaps.py
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_fields import CACHE, SITE_DATA, TILE, keys_digest  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "site" / "public" / "fields" / "maps"
SMALL = 24
SHEET = 2048
PER_ROW = SHEET // SMALL
PER_SHEET = PER_ROW * PER_ROW
STOPS = 64

# Crameri's Scientific Colour Maps, by type (as in the official overview).
MAPS = {
    "Sequential": ["batlow", "batlowW", "batlowK", "glasgow", "lipari", "navia", "hawaii", "buda",
                   "imola", "oslo", "grayC", "nuuk", "devon", "lajolla", "bamako", "davos",
                   "bilbao", "lapaz", "acton", "turku", "tokyo"],
    "Diverging": ["broc", "cork", "vik", "lisbon", "tofino", "berlin", "bam", "roma", "vanimo",
                  "managua"],
    "Cyclic": ["romaO", "bamO", "brocO", "corkO", "vikO"],
    "Multi-sequential": ["oleron", "bukavu", "fes"],
}


def oklab(rgb):
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    l_ = np.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    m_ = np.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    s_ = np.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return np.stack([0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
                     1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
                     0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_], -1)


def mean_colours(tiles):
    yy, xx = np.mgrid[0:TILE, 0:TILE]
    c = (TILE - 1) / 2
    w = np.exp(-(((xx - c) ** 2 + (yy - c) ** 2) / (2 * (TILE * 0.35) ** 2))).ravel()
    w /= w.sum()
    out = np.zeros((len(tiles), 3), np.float32)
    for s in range(0, len(tiles), 4096):
        lab = oklab(tiles[s:s + 4096].reshape(-1, TILE * TILE, 3).astype(np.float32) / 255)
        out[s:s + 4096] = (lab * w[None, :, None]).sum(1)
    return out


HUE_BINS = 24


def signature_colours(tiles):
    """Per tile: the strongest hue (±1 bin, weighted by chroma) among pixels with
    some colour, its pixels' mean OKLab, and the share of the tile they cover."""
    out = np.zeros((len(tiles), 4), np.float32)
    px = TILE * TILE
    for s in range(0, len(tiles), 4096):
        lab = oklab(tiles[s:s + 4096].reshape(-1, px, 3).astype(np.float32) / 255)
        n = len(lab)
        chroma = np.hypot(lab[..., 1], lab[..., 2])
        coloured = chroma > 0.03
        hue = (np.arctan2(lab[..., 2], lab[..., 1]) / (2 * np.pi) * HUE_BINS).astype(int) % HUE_BINS
        idx = (np.arange(n)[:, None] * HUE_BINS + hue)[coloured]

        def per_bin(w):  # sum of w over each tile's hue bins, then over ±1 bin
            m = np.bincount(idx, w, n * HUE_BINS).reshape(n, HUE_BINS)
            return m + np.roll(m, 1, 1) + np.roll(m, -1, 1)

        best = per_bin(chroma[coloured]).argmax(1)
        pick = lambda m: m[np.arange(n), best]  # noqa: E731
        count = pick(per_bin(np.ones(len(idx))))
        safe = np.maximum(count, 1)
        for c in range(3):
            out[s:s + n, c] = pick(per_bin(lab[..., c][coloured])) / safe
        out[s:s + n, 3] = count / px
    return out


def main():
    from cmcrameri import cm
    rows = json.loads((SITE_DATA / "artworks.json").read_text())["rows"]
    posts = json.loads((SITE_DATA / "site.json").read_text())["posts"]
    keys = [[posts[r[0]]["id"], r[1].split("_", 1)[1].split(".")[0]] for r in rows]
    tag = CACHE / "tiles32.key"
    if not tag.exists() or tag.read_text() != keys_digest(keys):
        sys.exit("Tile cache is stale or missing: run build_fields.py first.")
    tiles = np.load(CACHE / "tiles32.npy")
    OUT.mkdir(parents=True, exist_ok=True)

    sheets = math.ceil(len(tiles) / PER_SHEET)
    for s in range(sheets):
        sheet = Image.new("RGB", (SHEET, SHEET), (18, 17, 15))
        for i in range(s * PER_SHEET, min(len(tiles), (s + 1) * PER_SHEET)):
            j = i - s * PER_SHEET
            tile = Image.fromarray(tiles[i]).resize((SMALL, SMALL), Image.BOX)
            sheet.paste(tile, ((j % PER_ROW) * SMALL, (j // PER_ROW) * SMALL))
        sheet.save(OUT / f"atlas-{s:02d}.webp", "WEBP", quality=80, method=4)
    (OUT / "atlas.json").write_text(json.dumps({
        "tile": SMALL, "sheet": SHEET, "perRow": PER_ROW, "perSheet": PER_SHEET,
        "sheets": sheets, "count": len(tiles)}))

    mean_colours(tiles).astype("<f4").tofile(OUT / "colour.bin")
    sig = signature_colours(tiles)
    sig.astype("<f4").tofile(OUT / "signature.bin")
    vivid = (np.hypot(sig[:, 1], sig[:, 2]) >= 0.1) & (sig[:, 3] >= 0.15)
    print(f"{int(vivid.sum())} works with a signature colour of chroma ≥ 0.1 over ≥ 15% of the tile")

    maps = []
    for kind, names in MAPS.items():
        for name in names:
            rgb = getattr(cm, name)(np.linspace(0, 1, STOPS))[:, :3]
            maps.append({"name": name, "type": kind,
                         "stops": ["#%02x%02x%02x" % tuple(int(round(c * 255)) for c in col) for col in rgb]})
    (OUT / "maps.json").write_text(json.dumps({
        "credit": "Scientific colour maps by Fabio Crameri (doi:10.5281/zenodo.1243862)",
        "maps": maps}))
    size = sum(f.stat().st_size for f in OUT.iterdir()) / 1e6
    print(f"{len(tiles)} works, {sheets} atlas sheets, {len(maps)} colour maps, {size:.1f} MB -> {OUT}")


if __name__ == "__main__":
    main()
