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
images/                  downloaded artwork images (phase 2)
```

## Pipeline

```bash
python3 scripts/fetch_feed.py   # phase 0: raw feed snapshot (resumable)
```
