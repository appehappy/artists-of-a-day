"""Paths and constants shared by the pipeline scripts."""
import os
from pathlib import Path

BLOG_URL = "https://visualdiplomacyusa.blogspot.com"

# Large, hard-to-recreate data (raw feed snapshots, images) goes to Dropbox so it's
# backed up. Code and derived databases stay in the repo. Override with AOTD_ARCHIVE_ROOT.
ARCHIVE_ROOT = Path(
    os.environ.get("AOTD_ARCHIVE_ROOT", Path.home() / "Dropbox" / "ArtistOfTheDayArchive")
)

RAW_DIR = ARCHIVE_ROOT / "raw"
IMAGES_DIR = ARCHIVE_ROOT / "images"

# Derived, rebuildable data lives in the repo (gitignored).
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_DIR / "aotd.sqlite"

USER_AGENT = "ArtistOfTheDayArchive/0.1 (personal archival project; contact: owner of this archive)"
