# Artist of the Day Archive

Archive and interactive gallery of artists featured on
[Artist of the Day](https://visualdiplomacyusa.blogspot.com/) (2017–present).

The author's writing is archived for preservation only; it is not republished
without their consent.

## Data layout

Code and human-reviewed decisions live here. Large or slow-to-recompute data lives
in Dropbox (`~/Dropbox/ArtistOfTheDayArchive`, override with `AOTD_ARCHIVE_ROOT`):

```
raw/feed/<YYYY-MM-DD>/          full Blogger JSON feed snapshot + manifest.json
raw/feed/<timestamp>-inc/       incremental snapshots: posts updated since the last run
raw/wikidata/                   cached Wikidata responses
images/originals/<YYYY>/<YYYY-MM-DD>_<post id>/<position>_<url hash>.<ext>
                                full-resolution images as uploaded to the blog (~9 GB)
images/thumbs/…/<position>_<url hash>.webp   480px thumbnails (~4 GB)
images/manifest.jsonl           one line per download attempt: size, sha256, pixels or error
derived/colors.jsonl            5-colour palette per image
derived/clip/                   CLIP image embeddings (float16) + keys
derived/image_kinds.jsonl       artworks CLIP re-classified as artist portraits
derived/similar.jsonl           12 most similar artworks (other posts) per artwork
derived/wikidata_artists.json   Wikidata facts for matched artists
```

In the repo, `curation/wikidata_matches.csv` records each artist's Wikidata match;
edit `needs_review` rows to `confirmed` (fixing `qid` if needed) or `wrong`.
`curation/overrides.json` holds manual fixes (post kind, subject name, image kind,
artist merges). Everything is keyed by stable ids (post id, image `url_hash`, artist
slug), never by database row ids.

## Pipeline

Phases 0–2 and `build_db.py` use only the Python standard library. The enrichment
steps need Python 3.12 with the packages in `requirements.txt`:

```bash
/opt/homebrew/bin/python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

First run, in order:

```bash
python3 scripts/fetch_feed.py               # phase 0: full raw feed snapshot
python3 scripts/build_db.py                 # phase 1: snapshots -> data/aotd.sqlite
python3 scripts/download_images.py          # phase 2: images -> Dropbox
.venv/bin/python scripts/make_thumbs.py     # phase 3: thumbnails
.venv/bin/python scripts/extract_colors.py  #          colour palettes
.venv/bin/python scripts/embed_images.py    #          CLIP embeddings (Apple GPU)
python3 scripts/match_wikidata.py           #          Wikidata matching
python3 scripts/build_db.py                 #          merge enrichment
.venv/bin/python scripts/analyze_embeddings.py  #      image kinds + similar works
python3 scripts/build_db.py                 #          merge again
python3 scripts/export_site_data.py         # site JSON
.venv/bin/python scripts/build_fields.py    # Explore views: layouts + map tiles (~5 min)
.venv/bin/python scripts/build_colourmaps.py  # Colour maps explorer: sprite sheets, colours, maps
python3 -m unittest                         # tests
```

After that, one command keeps everything current (fetches only new or edited posts,
and each step skips work already done):

```bash
.venv/bin/python scripts/refresh.py
```

It runs automatically every day at 09:00 (or on wake, if the Mac was asleep) via a
LaunchAgent that calls `scripts/refresh-daily.sh`. Output goes to
`data/logs/refresh.log`; a notification appears when new posts arrive or a step
fails. Install or remove it with the commands in
`scripts/launchd/local.aotd-archive.refresh.plist`. Run it now with:

```bash
launchctl kickstart gui/$(id -u)/local.aotd-archive.refresh
```

`data/aotd.sqlite` is derived and rebuilt from scratch each run (schema in
`aotd/schema.sql`). Parsed fields (subject, nationality, roles, life dates, artwork
title/year, image kind) are heuristics; raw titles, labels and captions are kept
beside them. Wikidata replaces parsed life dates where it has a birth year. Posts
needing a human look are listed in `data/review/flagged_posts.csv`.

## Site (local only)

An Astro site in `site/`: the Wall (shuffled masonry of every artwork, filterable by
discipline, era, region, colour and living artists), artist pages with similar works
in the viewer, theme post pages, On this day, Shuffle and artist search.

Explore (prototypes) shows every artwork as one zoomable mosaic, drawn like a slippy
map from `site/public/fields/` (built by `build_fields.py`, not part of `refresh.py`
yet): **Colour Field** is a conic colour wheel: greys in a sphere at the centre,
then a gap, then a ring of every other work in hue order (OKLCH, each hue's slice as
wide as its share of the archive, muted inside to vivid at the rim). From afar it's
tinted towards a blurred colour layer so it reads as a smooth gradient. Its
**Orbits** arrangement (after Alma Thomas) shows ~1,800 of the most saturated works,
every hue represented, as pills in concentric rings around a dark sun, green at the
centre through blue, purple, red and orange to yellow at the edge, drawn by the WebGL
renderer (data from `build_colourmaps.py`). With a
"Vivid only" wheel of the most colourful quarter; **Constellation** is an archipelago of
visual likeness: CLIP-embedding clusters become islands arranged by a UMAP, named by
CLIP at two zoom levels (islands, then regions within them), with labels that never
overlap. `build_fields.py --only colour|constellation` rebuilds one view.

**Colour maps** (`/explore/maps`) draws Fabio Crameri's Scientific Colour Maps with
artworks: pick a shape (band, ring, bow-tie, steps), a map and how many
works. In the browser, each stretch of the gradient takes the closest-matching works
from the whole archive (sized to how many slots the shape has there), lined up by
fine gradient position and lightness (~350 ms). A WebGL2 renderer draws every work
from sprite sheets and flies them between layouts on the GPU; from far away tiles are
tinted towards their slot's colour, fading out as you zoom in, where real thumbnails
take over. Combinations are kept in the URL (`?map=vik&shape=bowtie&n=6000`).
Motion: tiles cascade in and filter changes animate; thumbnails morph into the viewer
and back; "More like this" hops between works inside the viewer; pages rise in.
All motion respects `prefers-reduced-motion`.

```bash
ln -sfn ~/Dropbox/ArtistOfTheDayArchive/images/originals site/public/img
ln -sfn ~/Dropbox/ArtistOfTheDayArchive/images/thumbs site/public/thumbs
npm --prefix site install
npm --prefix site run dev             # http://localhost:4321
```

Only `npm run dev` is supported for now: `astro build` would copy the image symlinks
into `dist/`. Publishing needs an image host first. The site shows factual metadata
and captions only, never the author's post text.
