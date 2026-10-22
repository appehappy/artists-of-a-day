"""Phase 3: 480px-wide WebP thumbnails for every downloaded image.

Writes <ARCHIVE_ROOT>/images/thumbs/<same path as originals>.webp. Existing
thumbnails are skipped, so re-running only processes new images.
Needs the .venv (Pillow): .venv/bin/python scripts/make_thumbs.py
"""
import argparse
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aotd.config import IMAGES_DIR, THUMBS_DIR  # noqa: E402
from aotd.manifest import load_downloads, thumb_path  # noqa: E402

WIDTH = 480
QUALITY = 78
Image.MAX_IMAGE_PIXELS = None  # trusted local files; some scans are very large


def make(job):
    src, dest = job
    try:
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im)
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGBA" if "transparency" in im.info or im.mode in ("LA", "PA") else "RGB")
            if im.width > WIDTH:
                im = im.resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS)
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(".tmp")
            im.save(tmp, "WEBP", quality=QUALITY, method=4)
            os.replace(tmp, dest)
        return None
    except Exception as e:
        return f"{src}: {type(e).__name__}: {e}"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--workers", type=int, default=os.cpu_count())
    args = ap.parse_args()

    jobs = []
    for rec in load_downloads().values():
        dest = thumb_path(rec["path"])
        if not dest.exists():
            jobs.append((IMAGES_DIR / rec["path"], dest))
    print(f"{len(jobs)} thumbnails to make -> {THUMBS_DIR}")
    start, errors = time.time(), []
    with ProcessPoolExecutor(args.workers) as pool:
        for n, err in enumerate(pool.map(make, jobs, chunksize=32), 1):
            if err:
                errors.append(err)
                print("  !", err, file=sys.stderr)
            if n % 5000 == 0 or n == len(jobs):
                rate = n / (time.time() - start)
                print(f"{n}/{len(jobs)}  {rate:.0f}/s  ETA {(len(jobs) - n) / rate / 60:.1f} min", flush=True)
    print(f"done, {len(errors)} errors")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
