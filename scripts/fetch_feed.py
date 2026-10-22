"""Phase 0: capture a raw, untouched snapshot of the blog's Blogger JSON feeds.

Saves every feed page exactly as received, plus a manifest, under
    <ARCHIVE_ROOT>/raw/feed/<snapshot>/
All later parsing works from these files, so the blog only needs to be hit once.

Blogger caps each response by size (~54 posts), not by max-results. Its rel="next"
links still assume max-results per page and would skip most posts, so we page by
start-index + entries actually received. Re-running resumes from pages on disk.

Usage: python3 scripts/fetch_feed.py [--snapshot 2026-10-21] [--delay 1.5]
"""
import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aotd.config import BLOG_URL, RAW_DIR, USER_AGENT  # noqa: E402

FEEDS = {
    "posts": f"{BLOG_URL}/feeds/posts/default",
    "pages": f"{BLOG_URL}/feeds/pages/default",
}


def page_url(base, start):
    return f"{base}?alt=json&max-results=500&start-index={start}"


def fetch(url, retries=5):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()
        except (urllib.error.URLError, TimeoutError) as e:
            status = getattr(e, "code", None)
            if status is not None and status < 500 and status != 429:
                raise
            wait = 5 * 2 ** attempt
            print(f"  ! {e} — retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"giving up on {url}")


def capture(name, base_url, out_dir, delay):
    start, page_no, pages, ids, total = 1, 1, [], set(), None
    while True:
        url = page_url(base_url, start)
        path = out_dir / f"{name}-{page_no:04d}.json"
        if path.exists():
            raw = path.read_bytes()
            fresh = False
        else:
            raw = fetch(url)
            path.write_bytes(raw)
            fresh = True
        feed = json.loads(raw)["feed"]
        if int(feed["openSearch$startIndex"]["$t"]) != start:
            sys.exit(f"{path} does not start at index {start}; delete the snapshot and re-run")
        entries = feed.get("entry", [])
        total = int(feed["openSearch$totalResults"]["$t"])
        if not entries:
            path.unlink()  # trailing empty page carries no data
            break
        ids.update(e["id"]["$t"] for e in entries)
        pages.append({
            "file": path.name,
            "url": url,
            "entries": len(entries),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "first_published": entries[0]["published"]["$t"],
            "last_published": entries[-1]["published"]["$t"],
        })
        print(f"{name} page {page_no}: {len(entries)} entries "
              f"({len(ids)}/{total}){'' if fresh else ' [cached]'}")
        start += len(entries)
        page_no += 1
        if fresh:
            time.sleep(delay)
    return {"feed_url": base_url, "total_results": total, "unique_entries": len(ids),
            "complete": total is not None and len(ids) == total, "pages": pages}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--snapshot", default=datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    ap.add_argument("--delay", type=float, default=1.5, help="seconds between requests")
    args = ap.parse_args()

    out_dir = RAW_DIR / "feed" / args.snapshot
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Snapshot dir: {out_dir}")

    manifest = {"blog": BLOG_URL, "snapshot": args.snapshot,
                "started_at": datetime.now(timezone.utc).isoformat(), "feeds": {}}
    for name, base_url in FEEDS.items():
        manifest["feeds"][name] = capture(name, base_url, out_dir, args.delay)
    manifest["finished_at"] = datetime.now(timezone.utc).isoformat()

    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    for name, info in manifest["feeds"].items():
        status = "complete" if info["complete"] else "INCOMPLETE"
        print(f"{name}: {info['unique_entries']}/{info['total_results']} — {status}")
    if not all(f["complete"] for f in manifest["feeds"].values()):
        sys.exit(1)


if __name__ == "__main__":
    main()
