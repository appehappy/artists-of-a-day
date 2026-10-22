"""Locate raw feed snapshots and merge them into one set of entries."""
import json


def read_manifest(snapshot_dir):
    return json.loads((snapshot_dir / "manifest.json").read_text())


def snapshot_layers(feed_dir, base=None):
    """The full snapshot to build from (latest, or `base`) and every incremental
    snapshot taken after it, oldest first."""
    dirs = sorted(p for p in feed_dir.iterdir() if (p / "manifest.json").exists())
    kinds = {p.name: read_manifest(p).get("type", "full") for p in dirs}
    fulls = [p for p in dirs if kinds[p.name] == "full"]
    if not fulls:
        raise SystemExit(f"no full snapshot in {feed_dir}; run fetch_feed.py first")
    full = next(p for p in fulls if p.name == base) if base else fulls[-1]
    return full, [p for p in dirs if kinds[p.name] == "incremental" and p.name > full.name]


def load_snapshot(snapshot_dir):
    manifest = read_manifest(snapshot_dir)
    if not manifest["feeds"]["posts"]["complete"]:
        raise SystemExit(f"{snapshot_dir} is an incomplete snapshot; re-run fetch_feed.py")
    entries = []
    for page in manifest["feeds"]["posts"]["pages"]:
        entries += json.loads((snapshot_dir / page["file"]).read_text())["feed"]["entry"]
    return entries


def merge_entries(layers):
    """Combine entry lists (oldest snapshot first). A post seen again replaces the
    earlier copy when its `updated` time is the same or later. Returns entries
    newest-published first, the feed's own order."""
    merged = {}
    for entries in layers:
        for e in entries:
            key = e["id"]["$t"]
            if key not in merged or e["updated"]["$t"] >= merged[key]["updated"]["$t"]:
                merged[key] = e
    return sorted(merged.values(), key=lambda e: e["published"]["$t"], reverse=True)
