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
.venv/bin/python scripts/build_fields.py    # Constellation: the galaxy layout (~1 min)
.venv/bin/python scripts/build_colourmaps.py  # Colour Field + Colour maps: sprite sheets, colours, maps
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
discipline, era and region, with a column of colour swatches beside it and Reshuffle /
Clear filters pinned to the foot of the window), artist pages
with similar works in the viewer, theme post pages, On this day, Shuffle and artist
search. Choosing a colour on the Wall tints the UI to match: the current nav pill,
pressed chips and the search line. The nav (after Floema's) draws its pills as one liquid
shape: neighbours join with soft waists, and the current page's pill stands 6px apart.
The header persists across pages, so on each change the new pill stretches away until
its neck pinches off while the old one flows back in; hovering eases a pill apart and a
faint glow follows the pointer; on first load each pill buds out of the one before.
Shuffle shuffles its letters before it picks an artist.

Explore (prototypes) has three views:

**Colour Field** (after Alma Thomas) shows the archive's 12,000 most colourful works as
pills in concentric rings around a dark sun, green at the centre through blue, purple,
red and orange to yellow at the edge. Works are placed by their signature colour: their
tile's strongest hue among coloured pixels (from `build_colourmaps.py`), so a
red-and-white poster counts as red, and every hue gets rings in proportion to the square
root of how common it is. Every pill is the same size and evenly spaced along its ring.
The rings appear at once in flat colour and spiral out from the sun while the sprite
sheets load (a clock round the sun's rim shows progress); images fade in as each sheet
arrives. After a few idle seconds the rings drift, alternate rings turning opposite
ways and slower close up; any input stops them. Selecting a work dims everything else
to 88% (the sun too), leaving it and its look-alikes lit and joined by fine white lines with a small dot at each end.

**Constellation** is a galaxy of visual likeness, every work a star (built by
`build_fields.py` into `site/public/fields/constellation/`, not part of `refresh.py`
yet). CLIP embeddings cluster the works into 48 star systems placed where a UMAP puts
them; each is a bright core of its most typical works (the biggest stars) fading into a
halo. Works nearly as alike to a neighbouring system are drawn into streams between the
two, so related systems collide, and the whole is turned in a gentle swirl. Ringed
anchor stars are joined by constellation lines to their most alike systems; system
names show from afar (more as you zoom), regions within them closer in. Click a star
and lines join it to its look-alikes; Surprise me and "More like this" fly to frame a
work with its look-alikes. It's quietly alive: distant stars glint now and then, and
when left idle the galaxy turns, about once in half an hour. It responds to the pointer:
as it moves through the stars it nudges them gently out of its way, and the
disturbance spreads outward through space: stars further off drift away a little later
and glide back without bouncing, nearer ones (each star has a depth) further than
distant ones, like parallax. A resting pointer pushes nothing, so the work under it
can be clicked. A spotlight follows it while the rest of the galaxy dims. Selecting a
star sends a larger disturbance across its neighbourhood, and dims everything but it
and its look-alikes until the card is closed. `build_fields.py --preview out.png` draws the galaxy as an image
for tuning.

**Colour maps** (`/explore/maps`) draws Fabio Crameri's Scientific Colour Maps with
artworks: pick a shape (steps, band, bow-tie, ring), a map and how many
works. In a background worker, each stretch of the gradient takes the closest-matching
works from the whole archive (sized to how many slots the shape has there), lined up
by fine gradient position and lightness (~0.3s; the page stays responsive). A WebGL2 renderer draws every work
from sprite sheets and flies them between layouts on the GPU. Sheets (and their smaller
mipmap sizes, built as files) are decoded in workers and copied to the GPU a few
milliseconds per frame, so entrances don't stutter while they load. On arrival the shape
draws itself along the gradient like a brushstroke (each work trailing in from a little
earlier in the map), in flat colour until the images fade in, with the map itself
filling in beneath as a loading bar. From far away tiles are
tinted towards their slot's colour, fading out as you zoom in. Detail follows the
zoom in every Explore view: as tiles outgrow their sprite, works near the centre swap
to 128px crops of their thumbnails (cached on the GPU, up to ~1,500 at a time), and
close up the full thumbnails take over. Combinations are kept in the URL (`?map=vik&shape=bowtie&n=6000`).
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
