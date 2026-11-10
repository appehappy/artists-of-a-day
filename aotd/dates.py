"""When each artwork was made, combined from every source we have.

Sources, strongest first:
  1. curation/overrides.json image_year              year_source 'manual'
  2. the post's caption, else the image's filename    'caption' | 'filename' (parsed at build)
  3. curation/artwork_years.csv, rows whose status    'wikidata' | 'research'
     is auto or confirmed (undated works only)
  4. a dated copy of the same image in another post   'propagated'
     (CLIP likeness), when every dated copy agrees

A year later than the post that featured the work is a completion or model year ("to be
completed by 2028", "2030 Lexus"), not when it was made: it's dropped and kept in
year_note as after_post:<year>.

year_lo/year_hi give the span each work was made in: the stated date, widened by
CIRCA_SPREAD for circa dates, never later than the post. Undated works get only that
ceiling, year_hi.
"""
import csv
import json
import re
from collections import Counter, defaultdict

from aotd.config import CURATION_DIR
from aotd.parse import parse_caption
from aotd.wikidata import fold

ARTWORK_YEARS = CURATION_DIR / "artwork_years.csv"
FIELDS = ["post_id", "url_hash", "artist", "title", "status", "year", "source", "evidence", "note"]
MANUAL = {"confirmed", "wrong"}   # statuses a person set; scripts never overwrite these rows
STATED = {"caption", "filename", "manual"}   # year_source of dates the archive itself states;
                                             # others come from artwork_years.csv
APPLY = {"auto", "confirmed"}     # statuses whose year goes into the database
CIRCA_SPREAD = 5
SAME_IMAGE = 0.95                 # CLIP cosine above which two images are one work

# Words that, with only numbers beside them, name many different works: "Untitled 3",
# "Composition No. 4", "Study", "Self-portrait".
GENERIC_WORDS = {
    "untitled", "composition", "study", "studies", "sketch", "drawing", "painting", "portrait",
    "self", "landscape", "still", "life", "abstract", "abstraction", "figure", "nude", "poster",
    "logo", "illustration", "design", "cover", "detail", "view", "installation", "exhibition",
    "series", "work", "works", "piece", "no", "nr", "n", "number", "op", "opus", "the", "a", "of",
    "and", "with", "in", "on", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x",
    "sans", "titre", "sin", "titulo", "ohne", "titel", "senza", "titolo",
}


def title_key(title):
    """Folded title for matching: 'L'Incompris (Misunderstood)' -> 'l incompris misunderstood'."""
    return " ".join(fold(title)) or None


def is_generic(key):
    words = [w for w in key.split() if not w.isdigit()]
    return len(key) < 4 or not words or set(words) <= GENERIC_WORDS


def parse_year(text):
    """'1965' | 'c.1965' | '1960-65' | '1950s' | '-330--321' (BC) -> (start, end, circa), or None."""
    if not text or not text.strip():
        return None
    text = text.strip()
    m = re.fullmatch(r"(c\.\s?)?(-?\d{1,4})(?:\s?[-–]\s?(-?\d{1,4}))?", text)
    if m and (m.group(2).startswith("-") or (m.group(3) or "").startswith("-")):
        start, end = int(m.group(2)), int(m.group(3)) if m.group(3) else None
        return start, end if end and end > start else None, bool(m.group(1))
    _, start, end, circa = parse_caption(text)
    return (start, end, circa) if start else None


def format_year(start, end=None, circa=False):
    return ("c." if circa else "") + str(start) + (f"-{end}" if end and end != start else "")


def span(start, end, circa, ceiling):
    """The years a work was made in, for placing it on a timeline."""
    lo, hi = start, end or start
    if circa:
        lo, hi = lo - CIRCA_SPREAD, hi + CIRCA_SPREAD
    hi = min(hi, ceiling)
    return min(lo, hi), hi


def load_rows():
    """{(post_id, url_hash, source): row} from curation/artwork_years.csv. A work can
    have a row from each source."""
    if not ARTWORK_YEARS.exists():
        return {}
    with open(ARTWORK_YEARS, newline="") as f:
        return {(r["post_id"], r["url_hash"], r["source"]): r for r in csv.DictReader(f)}


def update_rows(source, new_rows):
    """Replace one source's machine-made rows with new_rows; rows a person reviewed stay.
    Returns how many rows the file now holds for that source."""
    rows = load_rows()
    for k, r in list(rows.items()):
        if r["source"] == source and r["status"] not in MANUAL:
            del rows[k]
    for r in new_rows:
        k = (r["post_id"], r["url_hash"], source)
        if k in rows and rows[k]["status"] in MANUAL:
            continue
        rows[k] = {f: r.get(f, "") for f in FIELDS} | {"source": source}
    with open(ARTWORK_YEARS, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(sorted(rows.values(), key=lambda r: (r["artist"], r["title"], r["post_id"])))
    return sum(r["source"] == source for r in rows.values())


def apply(db, overrides):
    """Settle every image's date in a freshly built database. Returns counts."""
    stats = Counter()
    ceiling = {pid: max(int(pub[:4]), int(fd[:4]) if fd else 0)
               for pid, pub, fd in db.execute("SELECT id, published, feature_date FROM posts")}

    for iid, pid, y in db.execute(
            "SELECT id, post_id, year_start FROM images WHERE year_start IS NOT NULL").fetchall():
        if y > ceiling[pid]:
            db.execute("UPDATE images SET year_start = NULL, year_end = NULL, circa = 0, "
                       "year_source = NULL, year_note = ? WHERE id = ?", (f"after_post:{y}", iid))
            stats["years later than their post, dropped"] += 1

    for key, text in overrides["image_year"].items():
        post_id, url_hash = key.split("/")
        y = parse_year(text)
        if y:
            cur = db.execute("UPDATE images SET year_start = ?, year_end = ?, circa = ?, "
                             "year_source = 'manual', year_note = NULL "
                             "WHERE post_id = ? AND url_hash = ?", (*y[:2], int(y[2]), post_id, url_hash))
        else:
            cur = db.execute("UPDATE images SET year_start = NULL, year_end = NULL, circa = 0, "
                             "year_source = NULL, year_note = 'nd' "
                             "WHERE post_id = ? AND url_hash = ?", (post_id, url_hash))
        stats["manual dates"] += cur.rowcount

    # Where sources both date a work, confirmed rows win, then Wikidata over research.
    for r in sorted(load_rows().values(),
                    key=lambda r: (r["status"] != "confirmed", r["source"] != "wikidata")):
        y = parse_year(r["year"]) if r["status"] in APPLY else None
        if not y or y[0] > ceiling.get(r["post_id"], 0):
            continue
        cur = db.execute("UPDATE images SET year_start = ?, year_end = ?, circa = ?, year_source = ? "
                         "WHERE post_id = ? AND url_hash = ? AND year_start IS NULL",
                         (*y[:2], int(y[2]), r["source"], r["post_id"], r["url_hash"]))
        stats[f"years from {r['source']}"] += cur.rowcount

    stats.update(propagate(db, ceiling))

    spans = [(*span(start, end, circa, ceiling[pid]), iid) for iid, pid, start, end, circa in db.execute(
        "SELECT id, post_id, year_start, year_end, circa FROM images WHERE year_start IS NOT NULL")]
    db.executemany("UPDATE images SET year_lo = ?, year_hi = ? WHERE id = ?", spans)
    stats.update(estimate(db, ceiling))
    for source, n in db.execute("SELECT year_source, COUNT(*) FROM images WHERE kind = 'artwork' "
                                "AND year_start IS NOT NULL GROUP BY year_source"):
        stats[f"dated artworks: {source}"] = n
    return stats


def estimate(db, ceiling):
    """Give each undated artwork an estimated span (year_lo..year_hi), a best guess
    (year_est) and what they rest on (year_basis), strongest first:

      siblings  the nearest dated works before and after it in the same post: posts
                mostly run in order, so the span between them, padded
      artist    the artist's dated works in other posts
      likeness  dated works that look most like it (CLIP neighbours), kept inside the
                artist's adult life when we know it
      life      the artist's adult life
      post      nothing but the post date, which is only a ceiling

    Every span ends no later than the post. Needs dated works' spans already set."""
    stats = Counter()
    dated = {}                                    # (post, hash) -> (lo, hi)
    by_post, by_artist = defaultdict(list), defaultdict(list)
    artist_of = dict(db.execute("SELECT post_id, artist_id FROM post_artists"))
    for p, h, pos, lo, hi in db.execute("SELECT post_id, url_hash, position, year_lo, year_hi "
                                        "FROM images WHERE kind = 'artwork' AND year_start IS NOT NULL "
                                        "ORDER BY post_id, position"):
        dated[(p, h)] = (lo, hi)
        by_post[p].append((pos, lo, hi))
        if p in artist_of:
            by_artist[artist_of[p]].append((p, lo, hi))
    life = {aid: (birth, death, kind) for aid, birth, death, kind in
            db.execute("SELECT id, birth_year, death_year, type FROM artists")}
    similar = {(p, h): json.loads(s) for p, h, s in db.execute(
        "SELECT post_id, url_hash, similar FROM image_similar")}

    rows = []
    for iid, p, h, pos in db.execute("SELECT id, post_id, url_hash, position FROM images "
                                     "WHERE kind = 'artwork' AND year_start IS NULL").fetchall():
        aid = artist_of.get(p)
        before = [s[1:] for s in by_post.get(p, []) if s[0] < pos][-1:]
        after = [s[1:] for s in by_post.get(p, []) if s[0] > pos][:1]
        others = [(lo, hi) for q, lo, hi in by_artist.get(aid, []) if q != p]
        neighbours = [dated[(q, qh)] for q, qh, _ in similar.get((p, h), []) if (q, qh) in dated]
        lo, hi, est, basis = guess(before + after, others, neighbours, life.get(aid), ceiling[p])
        rows.append((lo, hi, est, basis, iid))
        stats[f"estimated artworks: {basis}"] += 1
    db.executemany("UPDATE images SET year_lo = ?, year_hi = ?, year_est = ?, year_basis = ? "
                   "WHERE id = ?", rows)
    return stats


SIBLING_PAD = 2        # 96% of dated works fall within 2 years of the span of the dated
                       # works either side of them (median width 5)
ARTIST_PAD = 5         # 94% inside the artist's dated span ±5 (median width 48)
LIKENESS_PAD = 8       # look-alikes: 89% inside, median width 43, best guess off by a
                       # median 11 years; it places a work in its generation, no closer
LIKENESS_K = 12        # nearest dated look-alikes to use (image_similar keeps 12)
LIKENESS_Q = 0.1       # span between these quantiles of their years
ADULT_AGE = 15         # earliest age we expect a person's featured work
MIDCAREER_AGE = 35


def mid(spans):
    """Median of the spans' midpoints."""
    m = sorted((lo + hi) / 2 for lo, hi in spans)
    n = len(m)
    return round((m[(n - 1) // 2] + m[n // 2]) / 2)


def guess(siblings, artist, neighbours, life, ceiling):
    """(year_lo, year_hi, year_est, year_basis) for one undated work; see estimate().
    siblings: the dated works either side of it in its post (one or two spans)."""
    birth, death, kind = life or (None, None, None)
    adult = (birth + (ADULT_AGE if kind == "person" else 0) if birth else None,
             min(death, ceiling) if death else ceiling)
    if siblings:
        lo, hi = min(s[0] for s in siblings) - SIBLING_PAD, max(s[1] for s in siblings) + SIBLING_PAD
        est, basis = mid(siblings), "siblings"
    elif artist:
        lo, hi = min(s[0] for s in artist) - ARTIST_PAD, max(s[1] for s in artist) + ARTIST_PAD
        est, basis = mid(artist), "artist"
    else:
        lo = hi = est = None
        if neighbours:
            near = sorted((lo + hi) / 2 for lo, hi in neighbours[:LIKENESS_K])
            q = int(len(near) * LIKENESS_Q)
            lo, hi = round(near[q]) - LIKENESS_PAD, round(near[-1 - q]) + LIKENESS_PAD
            lo, hi = max(lo, adult[0] or lo), min(hi, adult[1])
            est, basis = mid(neighbours[:LIKENESS_K]), "likeness"
        if lo is None or lo > hi:                   # no look-alikes, or none inside their life
            if not birth:
                return None, ceiling, None, "post"
            lo, hi = adult
            est, basis = birth + MIDCAREER_AGE, "life"
    hi = min(hi, ceiling)
    lo = min(lo, hi)
    return lo, hi, min(max(est, lo), hi), basis


def propagate(db, ceiling):
    """Date a reposted work from a dated copy of the same image in another post.

    Copies are found by CLIP likeness (image_similar lists each artwork's nearest works
    in other posts), not by title: one post often captions a dozen different works
    "Land Art" and dates only one of them."""
    stats = Counter()
    dated = {(p, h): (s, e, c) for p, h, s, e, c in db.execute(
        "SELECT post_id, url_hash, year_start, year_end, circa FROM images "
        "WHERE kind = 'artwork' AND year_start IS NOT NULL")}
    undated = {(p, h): iid for iid, p, h in db.execute(
        "SELECT id, post_id, url_hash FROM images WHERE kind = 'artwork' AND year_start IS NULL")}
    found = defaultdict(set)
    for p, h, similar in db.execute("SELECT post_id, url_hash, similar FROM image_similar"):
        for q, qh, cosine in json.loads(similar):
            if cosine < SAME_IMAGE:
                continue
            if (p, h) in undated and (q, qh) in dated:      # similarity lists aren't symmetric
                found[(p, h)].add(dated[(q, qh)])
            elif (q, qh) in undated and (p, h) in dated:
                found[(q, qh)].add(dated[(p, h)])
    for (p, h), dates in found.items():
        if max(d[0] for d in dates) - min(d[0] for d in dates) > 1:
            stats["same image, conflicting dates: not propagated"] += 1
            continue
        start, end, circa = min(dates)
        if start <= ceiling[p]:
            db.execute("UPDATE images SET year_start = ?, year_end = ?, circa = ?, "
                       "year_source = 'propagated' WHERE id = ?", (start, end, circa, undated[(p, h)]))
    return stats
