# Artist of the Day Archive

Archive and interactive gallery of artists featured on
[Artist of the Day](https://visualdiplomacyusa.blogspot.com/) (2017–present).

The author's writing is archived for preservation only; it is not republished
without their consent.

## Data layout

Code lives here. Large data lives in Dropbox (`~/Dropbox/ArtistOfTheDayArchive`,
override with `AOTD_ARCHIVE_ROOT`):

```
raw/feed/<YYYY-MM-DD>/   untouched Blogger JSON feed pages + manifest.json
images/originals/<YYYY>/<YYYY-MM-DD>_<post id>/<position>_<url hash>.<ext>
                         full-resolution images as uploaded to the blog (~9 GB)
images/manifest.jsonl    one line per download attempt: size, sha256, pixels or error
```

## Pipeline

```bash
python3 scripts/fetch_feed.py   # phase 0: raw feed snapshot (resumable)
python3 scripts/build_db.py     # phase 1: parse latest snapshot -> data/aotd.sqlite
python3 scripts/download_images.py   # phase 2: images -> Dropbox (resumable, retries failures)
python3 -m unittest             # parser tests
```

`data/aotd.sqlite` is derived and rebuilt from scratch each run (schema in
`aotd/schema.sql`): `posts`, `artists`, `post_artists`, `post_tags`, `images`.
Parsed fields (subject, nationality, roles, life dates, artwork title/year, image
kind) are heuristics; raw titles, labels and captions are kept beside them.
Posts needing a human look are listed in `data/review/flagged_posts.csv`.
