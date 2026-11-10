"""Date artworks by researching them on the web with Claude: one request per artist.

Claude gets the artist and a list of their works by title, searches the web (the
blog itself is blocked, so it can't read back our own captions) and records a year
only where a source it read states it for that work, with the source's URL.

Accuracy is measured as it goes: each request also lists up to --holdout works the
blog's captions already date, unmarked among the undated ones. Those answers are
scored against the captions and never written to the curation file.

Writes source=research rows to curation/artwork_years.csv with status needs_review
(or auto, for answers at or above --accept confidence). Raw answers and token use
are cached per artist in <ARCHIVE_ROOT>/raw/research/artwork_years.jsonl, so a re-run
only asks about artists not done yet; the curation rows are rebuilt from that cache.

Needs the Anthropic SDK (.venv) and credentials: ANTHROPIC_API_KEY, or a profile
from `ant auth login`.

Usage:
  .venv/bin/python scripts/research_artwork_years.py --pilot 50     # random artists
  .venv/bin/python scripts/research_artwork_years.py --artist alma-thomas
  .venv/bin/python scripts/research_artwork_years.py --pilot 50 --dry-run
"""
import argparse
import json
import random
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aotd import dates  # noqa: E402
from aotd.config import BLOG_URL, DB_PATH, RAW_DIR  # noqa: E402

CACHE = RAW_DIR / "research" / "artwork_years.jsonl"
MODEL = "claude-opus-5-5"
MAX_WORKS = 40          # per request; prolific artists are split across requests
CONFIDENCE = ["low", "medium", "high"]

SYSTEM = """You date artworks for an archive of artists featured on an art blog. For one \
artist you get a numbered list of their works by title, as the blog captioned them. \
Find out the year each work was made.

Search the web: the artist's own site, galleries, museum collections, auction records, \
catalogues raisonnés, publishers, design databases, reliable articles. A year counts only \
if a page you actually read states it for that specific work. Don't infer a year from the \
artist's career, a series, a neighbouring work or an exhibition date, and don't guess. \
Exhibition, publication or sale dates are not creation dates unless the source says the \
work was made then. Titles may be translated, abbreviated or slightly misspelled; match \
on the work, and leave it undated if you can't tell which work a title means.

Work efficiently: start with searches likely to cover many works at once (the artist's \
own works or catalogue page, a museum collection listing), then fill gaps one by one.

When you're done, call record_dates once with an entry for every work in the list, \
including the ones you couldn't date (year null)."""

RECORD_TOOL = {
    "name": "record_dates",
    "description": "Record what you found: one entry per work in the list.",
    "strict": True,
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["works"],
        "properties": {"works": {"type": "array", "items": {
            "type": "object",
            "additionalProperties": False,
            "required": ["id", "year", "source_url", "confidence", "note"],
            "properties": {
                "id": {"type": "integer", "description": "the work's number in the list"},
                "year": {"type": ["string", "null"], "description":
                         "when it was made: '1965', 'c.1965', '1960-1965' or '1950s'; "
                         "null if no source you read states it"},
                "source_url": {"type": ["string", "null"],
                               "description": "the page that states the year"},
                "confidence": {"type": "string", "enum": CONFIDENCE, "description":
                               "high: a source names this exact work and year; medium: "
                               "the match between title and work is a little uncertain; "
                               "low: the source is weak or the year approximate"},
                "note": {"type": "string", "description": "anything a reviewer should know; "
                         "may be empty"},
            },
        }}},
    },
}

BLOG_HOST = BLOG_URL.split("//", 1)[1]
# Caps keep a request's cost bounded: each search or fetch adds its results to the
# context every later step re-reads.
def tools(searches, fetches):
    return [
        {"type": "web_search_20260209", "name": "web_search", "blocked_domains": [BLOG_HOST],
         "max_uses": searches},
        {"type": "web_fetch_20260209", "name": "web_fetch", "blocked_domains": [BLOG_HOST],
         "max_uses": fetches, "max_content_tokens": 8000},
        RECORD_TOOL,
    ]
# USD per million tokens (claude-opus-5-5) and per search, for the cost estimate printed
PRICE = {"input": 4.00, "cache_write": 5.00, "cache_read": 0.20, "output": 20.00, "search": 0.01}


def cost(u):
    return (sum(u.get(k, 0) * PRICE[k] for k in ("input", "cache_write", "cache_read", "output")) / 1e6
            + u.get("searches", 0) * PRICE["search"])


def load_cache():
    out = {}
    if CACHE.exists():
        for line in CACHE.read_text().splitlines():
            r = json.loads(line)
            out[r["key"]] = r
    return out


def artist_works(db, slug):
    """(artist facts, undated artworks, dated artworks) for one artist."""
    a = db.execute("""SELECT a.id, a.name, a.birth_year, a.death_year, a.nationality, a.roles,
                      (SELECT p.descriptor FROM posts p JOIN post_artists pa ON pa.post_id = p.id
                       WHERE pa.artist_id = a.id LIMIT 1)
                      FROM artists a WHERE a.slug = ?""", (slug,)).fetchone()
    rows = db.execute("""SELECT i.post_id, i.url_hash, i.title, i.year_start, i.year_end, i.circa,
                         i.year_source
                         FROM images i JOIN post_artists pa ON pa.post_id = i.post_id
                         WHERE pa.artist_id = ? AND i.kind = 'artwork' AND i.title IS NOT NULL
                         ORDER BY i.post_id, i.position""", (a[0],)).fetchall()
    seen, undated, dated = set(), [], []
    for r in rows:
        key = dates.title_key(r[2])
        if not key or dates.is_generic(key) or key in seen:
            continue   # one question per title; repeats are copied below
        seen.add(key)
        if r[6] not in dates.STATED:   # undated, or dated only by artwork_years.csv
            undated.append(r)
        elif r[6] == "caption":
            dated.append(r)
    return a, undated, dated, rows


def user_prompt(a, works):
    _, name, birth, death, nationality, roles, descriptor = a
    life = f" ({birth or '?'}–{death or ''})" if birth or death else ""
    about = descriptor or ", ".join(filter(None, [nationality, ", ".join(json.loads(roles))]))
    lines = "\n".join(f"{i}. {w[2]}" for i, w in enumerate(works, 1))
    return f"Artist: {name}{life}" + (f", {about}" if about else "") + f"\n\nWorks:\n{lines}"


def ask(client, prompt, effort, caps):
    """One research request, resumed through pause_turn. Returns (works, usage, model)."""
    messages = [{"role": "user", "content": prompt}]
    usage = Counter()
    for _ in range(8):
        response = client.beta.messages.create(
            model=MODEL, max_tokens=16000, system=SYSTEM, tools=tools(*caps),
            output_config={"effort": effort}, cache_control={"type": "ephemeral"},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            messages=messages)
        u = response.usage
        usage.update({"input": u.input_tokens, "output": u.output_tokens,
                      "cache_read": u.cache_read_input_tokens or 0,
                      "cache_write": u.cache_creation_input_tokens or 0,
                      "searches": (u.server_tool_use.web_search_requests or 0) if u.server_tool_use else 0,
                      "fetches": (getattr(u.server_tool_use, "web_fetch_requests", 0) or 0)
                      if u.server_tool_use else 0})
        if response.stop_reason == "refusal":
            raise RuntimeError(f"refused: {response.stop_details}")
        call = next((b for b in response.content
                     if b.type == "tool_use" and b.name == "record_dates"), None)
        if call:
            return call.input["works"], dict(usage), response.model
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "pause_turn":
            messages.append({"role": "user", "content":
                             "Please call record_dates now with what you have found."})
    raise RuntimeError("no record_dates call after 8 turns")


def research(client, db, slug, holdout, effort, caps, rng):
    a, undated, dated, _ = artist_works(db, slug)
    held = rng.sample(dated, min(holdout, len(dated)))
    results = []
    for i in range(0, len(undated), MAX_WORKS - len(held)):
        works = undated[i:i + MAX_WORKS - len(held)] + (held if i == 0 else [])
        rng.shuffle(works)
        answers, usage, model = ask(client, user_prompt(a, works), effort, caps)
        for ans in answers:
            if 1 <= ans["id"] <= len(works):
                w = works[ans["id"] - 1]
                results.append({**ans, "post_id": w[0], "url_hash": w[1], "title": w[2],
                                "held_out": w[3] is not None, "caption_year": w[3]})
        yield {"usage": usage, "model": model}
    yield {"results": results, "asked": len(undated), "held_out": len(held)}


def score(cache_rows):
    """Held-out accuracy and coverage over cached runs."""
    s = Counter()
    for r in cache_rows:
        for x in r["results"]:
            y = dates.parse_year(x["year"]) if x["year"] else None
            if x["held_out"]:
                s["held-out asked"] += 1
                if y:
                    s["held-out answered"] += 1
                    off = abs(y[0] - x["caption_year"])
                    s["held-out within 1 year"] += off <= 1
                    s["held-out within 5 years"] += off <= 5
                    s[f"held-out answered ({x['confidence']})"] += 1
                    s[f"held-out within 1 year ({x['confidence']})"] += off <= 1
            else:
                s["undated asked"] += 1
                s["undated dated"] += bool(y)
                s[f"undated dated ({x['confidence']})"] += bool(y)
        for k, v in r["usage"].items():
            s[f"usage: {k}"] += v
    return s


def write_rows(cache_rows, db, accept):
    """Curation rows for every undated copy of each answered title."""
    rows = []
    for r in cache_rows:
        _, _, _, all_rows = artist_works(db, r["slug"])
        by_key = {}
        for w in all_rows:
            if w[6] not in dates.STATED:
                by_key.setdefault(dates.title_key(w[2]), []).append(w)
        for x in r["results"]:
            if x["held_out"] or not x["year"] or not dates.parse_year(x["year"]):
                continue
            status = ("auto" if accept and CONFIDENCE.index(x["confidence"]) >= CONFIDENCE.index(accept)
                      else "needs_review")
            for w in by_key.get(dates.title_key(x["title"]), []):
                rows.append({"post_id": w[0], "url_hash": w[1], "artist": r["slug"], "title": w[2],
                             "status": status, "year": x["year"], "evidence": x["source_url"] or "",
                             "note": f"{x['confidence']}: {x['note']}".strip(": ")})
    return dates.update_rows("research", rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--pilot", type=int, help="research this many randomly chosen artists")
    ap.add_argument("--artist", action="append", default=[], help="artist slug (repeatable)")
    ap.add_argument("--holdout", type=int, default=5, help="dated works mixed in per artist")
    ap.add_argument("--effort", default="medium", choices=["low", "medium", "high", "xhigh"])
    ap.add_argument("--accept", choices=CONFIDENCE,
                    help="mark answers at or above this confidence 'auto' instead of needs_review")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--searches", type=int, default=15, help="web searches allowed per request")
    ap.add_argument("--fetches", type=int, default=8, help="page fetches allowed per request")
    ap.add_argument("--redo", action="store_true", help="research the artists again even if cached")
    ap.add_argument("--dry-run", action="store_true", help="show what would be asked")
    args = ap.parse_args()

    db = sqlite3.connect(DB_PATH)
    rng = random.Random(args.seed)
    cache = load_cache()
    slugs = list(args.artist)
    if args.pilot:
        candidates = [s for (s,) in db.execute("SELECT slug FROM artists ORDER BY slug")
                      if len(artist_works(db, s)[1]) >= 3]
        slugs += rng.sample(candidates, min(args.pilot, len(candidates)))
    todo = slugs if args.redo else [s for s in slugs if f"{s}|{MODEL}" not in cache]

    if args.dry_run:
        n = sum(len(artist_works(db, s)[1]) for s in todo)
        print(f"{len(todo)} artists to research ({len(slugs) - len(todo)} cached), {n} undated titles")
        a, undated, dated, _ = artist_works(db, todo[0])
        print("\nExample request:\n" + user_prompt(a, undated[:MAX_WORKS] + dated[:args.holdout]))
        return

    import anthropic
    client = anthropic.Anthropic()
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    for n, slug in enumerate(todo, 1):
        t0, usage, model = time.time(), Counter(), MODEL
        try:
            for part in research(client, db, slug, args.holdout, args.effort,
                                 (args.searches, args.fetches), rng):
                if "usage" in part:
                    usage.update(part["usage"])
                    model = part["model"]
                else:
                    rec = {"key": f"{slug}|{MODEL}", "slug": slug, "model": model,
                           "effort": args.effort, "caps": [args.searches, args.fetches],
                           "usage": dict(usage), **part}
        except (anthropic.APIError, RuntimeError) as e:
            print(f"[{n}/{len(todo)}] {slug}: failed ({type(e).__name__}: {e})", file=sys.stderr)
            continue
        with open(CACHE, "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        cache[rec["key"]] = rec
        found = sum(bool(x["year"]) for x in rec["results"] if not x["held_out"])
        print(f"[{n}/{len(todo)}] {slug}: {found}/{rec['asked']} dated, "
              f"{usage['searches']} searches, ~${cost(usage):.2f}, {time.time() - t0:.0f}s", flush=True)

    done = [cache[f"{s}|{MODEL}"] for s in slugs if f"{s}|{MODEL}" in cache]
    for k, v in sorted(score(done).items()):
        print(f"{k}: {v}")
    print(f"estimated cost: ${sum(cost(r['usage']) for r in done):.2f} for {len(done)} artists")
    print(f"research rows in {dates.ARTWORK_YEARS.name}: {write_rows(list(cache.values()), db, args.accept)}")


if __name__ == "__main__":
    main()
