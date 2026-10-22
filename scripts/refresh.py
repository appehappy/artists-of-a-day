"""Bring the archive up to date with the blog in one command.

Fetches posts updated since the newest one in the database (an incremental
snapshot), then reruns every pipeline step. Each step skips work that's already
done, so a run with a few new posts takes minutes:

  fetch_feed --since → build_db → download_images → make_thumbs → extract_colors
  → embed_images → match_wikidata → build_db (merge) → analyze_embeddings
  → build_db (merge) → export_site_data

Usage: .venv/bin/python scripts/refresh.py [--force]   (--force: rebuild even with no new posts)
"""
import argparse
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aotd.config import DB_PATH, RAW_DIR  # noqa: E402

VENV_PY = ROOT / ".venv" / "bin" / "python"


def run(script, *args):
    print(f"\n── {script} {' '.join(args)}", flush=True)
    start = time.time()
    result = subprocess.run([str(VENV_PY), str(ROOT / "scripts" / script), *args], cwd=ROOT)
    if result.returncode != 0:
        sys.exit(f"{script} failed (exit {result.returncode}); fix it and re-run refresh.py")
    print(f"   ({time.time() - start:.0f}s)")


def snapshot_state():
    db = sqlite3.connect(DB_PATH)
    state = {
        "latest": db.execute("SELECT max(updated) FROM posts").fetchone()[0],
        "posts": {r[0]: r[1] for r in db.execute("SELECT id, updated FROM posts")},
    }
    db.close()
    return state


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--force", action="store_true", help="rebuild even if nothing is new")
    args = ap.parse_args()
    if not DB_PATH.exists():
        sys.exit("No database yet: run fetch_feed.py and build_db.py once first (see README).")
    if not VENV_PY.exists():
        sys.exit("No .venv: see requirements.txt for setup.")

    before = snapshot_state()
    feed_dir = RAW_DIR / "feed"
    existing = {p.name for p in feed_dir.iterdir()}
    run("fetch_feed.py", "--since", before["latest"])
    if not args.force and {p.name for p in feed_dir.iterdir()} == existing:
        print("\nAlready up to date.")
        return

    run("build_db.py")
    run("download_images.py")
    run("make_thumbs.py")
    run("extract_colors.py")
    run("embed_images.py")
    run("match_wikidata.py", "--fuzzy-minutes", "3")
    run("build_db.py")               # merge Wikidata facts, colours
    run("analyze_embeddings.py")     # needs the merged db for image kinds and posts
    run("build_db.py")               # merge new image kinds and similar works
    run("export_site_data.py")

    after = snapshot_state()
    new = [p for p in after["posts"] if p not in before["posts"]]
    edited = [p for p, u in after["posts"].items() if p in before["posts"] and u != before["posts"][p]]
    db = sqlite3.connect(DB_PATH)
    print(f"\nDone: {len(new)} new posts, {len(edited)} edited.")
    for pid in new:
        print("  +", db.execute("SELECT title FROM posts WHERE id = ?", (pid,)).fetchone()[0])
    db.close()


if __name__ == "__main__":
    main()
