"""Read images/manifest.jsonl, written by scripts/download_images.py."""
import json
from pathlib import Path

from aotd.config import IMAGES_DIR, THUMBS_DIR

MANIFEST = IMAGES_DIR / "manifest.jsonl"


def thumb_path(original_rel):
    """'originals/2026/…/007_ab12.jpg' -> THUMBS_DIR/'2026/…/007_ab12.webp'."""
    return THUMBS_DIR / Path(original_rel).relative_to("originals").with_suffix(".webp")


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
