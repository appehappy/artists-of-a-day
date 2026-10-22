"""Phase 3: dominant colours for every image, from its thumbnail.

Appends one line per image to <ARCHIVE_ROOT>/derived/colors.jsonl:
  {post_id, url_hash, palette: [[hex, weight], ...5], buckets, hue, lightness}
Images already in the file are skipped. Run make_thumbs.py first.
Needs the .venv (Pillow): .venv/bin/python scripts/extract_colors.py
"""
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aotd.colors import summarize  # noqa: E402
from aotd.config import DERIVED_DIR  # noqa: E402
from aotd.manifest import load_downloads, thumb_path  # noqa: E402

OUT = DERIVED_DIR / "colors.jsonl"
SAMPLE_WIDTH = 64
COLORS = 5


def analyze(job):
    post_id, url_hash, path = job
    try:
        with Image.open(path) as im:
            if im.mode in ("RGBA", "LA", "P"):
                im = im.convert("RGBA")
                bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
                im = Image.alpha_composite(bg, im)
            im = im.convert("RGB")
            im.thumbnail((SAMPLE_WIDTH, SAMPLE_WIDTH * 4))
            q = im.quantize(colors=COLORS, method=Image.Quantize.MEDIANCUT)
            pal = q.getpalette()
            counts = sorted(q.getcolors(), reverse=True)
            total = sum(c for c, _ in counts)
            palette = [["#%02x%02x%02x" % tuple(pal[i * 3:i * 3 + 3]), round(c / total, 3)]
                       for c, i in counts]
            gray = im.convert("L")
            lightness = round(sum(gray.getdata()) / (gray.width * gray.height) / 255, 3)
        return {"post_id": post_id, "url_hash": url_hash, "palette": palette,
                **summarize(palette), "lightness": lightness}
    except Exception as e:
        return {"post_id": post_id, "url_hash": url_hash, "error": f"{type(e).__name__}: {e}"}


def main():
    done = set()
    if OUT.exists():
        with open(OUT) as f:
            done = {(r["post_id"], r["url_hash"]) for r in map(json.loads, f) if "error" not in r}
    jobs = [(pid, h, thumb_path(rec["path"])) for (pid, h), rec in load_downloads().items()
            if (pid, h) not in done]
    print(f"{len(jobs)} images to analyse -> {OUT}")
    DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    start, errors = time.time(), 0
    with open(OUT, "a") as out, ProcessPoolExecutor(os.cpu_count()) as pool:
        for n, rec in enumerate(pool.map(analyze, jobs, chunksize=64), 1):
            out.write(json.dumps(rec) + "\n")
            errors += "error" in rec
            if n % 10000 == 0 or n == len(jobs):
                print(f"{n}/{len(jobs)}  {n / (time.time() - start):.0f}/s  errors {errors}", flush=True)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
