"""Phase 2: download every post image at full resolution into Dropbox.

Files land at
    <ARCHIVE_ROOT>/images/originals/<YYYY>/<YYYY-MM-DD>_<post id>/<position>_<url hash>.<ext>
and every attempt is appended to <ARCHIVE_ROOT>/images/manifest.jsonl (size, sha256,
pixel size, or the error). Files already on disk are skipped, so re-running resumes
and retries anything that failed. The image list comes from data/aotd.sqlite.

Usage: python3 scripts/download_images.py [--posts N] [--workers 6]
"""
import argparse
import base64
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aotd.config import DATA_DIR, DB_PATH, IMAGES_DIR, USER_AGENT  # noqa: E402
from aotd.imageinfo import FORMATS, sniff  # noqa: E402

ORIGINALS = IMAGES_DIR / "originals"
MANIFEST = IMAGES_DIR / "manifest.jsonl"
TMP_DIR = DATA_DIR / "tmp_downloads"  # same volume as Dropbox, so the final move is atomic


def url_hash(url):
    return hashlib.sha1(url.encode()).hexdigest()[:10]


def post_dir(published, post_id):
    return ORIGINALS / published[:4] / f"{published[:10]}_{post_id}"


def fetch(url, retries=5):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read(), resp.headers.get("Content-Type")
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429:
                raise
            err = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            err = e
        time.sleep(3 * 2 ** attempt)
    raise err


def download(row):
    image_id, post_id, published, position, src_url, original_url = row
    key = original_url or src_url
    h = url_hash(key)
    record = {"image_id": image_id, "post_id": post_id, "position": position,
              "url": original_url, "url_hash": h,
              "fetched_at": datetime.now(timezone.utc).isoformat()}
    try:
        if original_url:
            data, content_type = fetch(original_url)
        else:  # embedded data: URI
            header, b64 = src_url.split(",", 1)
            data, content_type = base64.b64decode(b64), header[5:].split(";")[0]
        fmt, width, height = sniff(data)
        if fmt is None:
            raise ValueError(f"not an image ({content_type}, {len(data)} bytes)")
        dest = post_dir(published, post_id) / f"{position:03d}_{h}.{FORMATS[fmt]}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = TMP_DIR / f"{h}.part"
        tmp.write_bytes(data)
        os.replace(tmp, dest)
        record.update(path=str(dest.relative_to(IMAGES_DIR)), bytes=len(data),
                      sha256=hashlib.sha256(data).hexdigest(), format=fmt,
                      width=width, height=height, content_type=content_type)
    except Exception as e:  # recorded in the manifest and retried on the next run
        record.update(error=f"{type(e).__name__}: {e}", status=getattr(e, "code", None))
    return record


def existing_files():
    """{(post folder name, position, url hash)} already on disk."""
    found = set()
    if ORIGINALS.exists():
        for year in ORIGINALS.iterdir():
            for folder in (year.iterdir() if year.is_dir() else []):
                for f in folder.iterdir():
                    if f.suffix != ".part":
                        pos, h = f.stem.split("_", 1)
                        found.add((folder.name, int(pos), h))
    return found


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--posts", type=int, help="only the N most recent posts (for testing)")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    db = sqlite3.connect(DB_PATH)
    post_filter = ("WHERE p.id IN (SELECT id FROM posts ORDER BY published DESC LIMIT %d)"
                   % args.posts if args.posts else "")
    rows = db.execute(
        "SELECT i.id, p.id, p.published, i.position, i.src_url, i.original_url "
        "FROM images i JOIN posts p ON p.id = i.post_id " + post_filter +
        " ORDER BY p.published DESC, i.position").fetchall()
    db.close()

    have = existing_files()
    todo = [r for r in rows
            if (f"{r[2][:10]}_{r[1]}", r[3], url_hash(r[5] or r[4])) not in have]
    print(f"{len(rows)} images in scope, {len(rows) - len(todo)} already on disk, "
          f"{len(todo)} to fetch -> {ORIGINALS}")
    if not todo:
        return

    TMP_DIR.mkdir(parents=True, exist_ok=True)
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    ok = failed = total_bytes = 0
    start = time.time()
    with open(MANIFEST, "a") as manifest, ThreadPoolExecutor(args.workers) as pool:
        futures = [pool.submit(download, r) for r in todo]
        for n, fut in enumerate(as_completed(futures), 1):
            rec = fut.result()
            manifest.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if "error" in rec:
                failed += 1
                print(f"  ! post {rec['post_id']} #{rec['position']}: {rec['error']}", file=sys.stderr)
            else:
                ok += 1
                total_bytes += rec["bytes"]
            if n % 500 == 0 or n == len(todo):
                manifest.flush()
                rate = n / (time.time() - start)
                eta = (len(todo) - n) / rate / 60
                print(f"{n}/{len(todo)}  ok {ok}  failed {failed}  "
                      f"{total_bytes / 1e9:.2f} GB  {rate:.1f}/s  ETA {eta:.0f} min", flush=True)
    print(f"done: {ok} downloaded, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
