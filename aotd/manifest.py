"""Read images/manifest.jsonl, written by scripts/download_images.py."""
import json

from aotd.config import IMAGES_DIR

MANIFEST = IMAGES_DIR / "manifest.jsonl"


def load_downloads():
    """{(post_id, url_hash): record} for every image downloaded successfully.
    Later lines win, so a retry that succeeded overrides an earlier failure."""
    files = {}
    with open(MANIFEST) as f:
        for line in f:
            r = json.loads(line)
            if "error" not in r:
                files[(r["post_id"], r["url_hash"])] = r
    return files
