-- Phase 1 schema. The database is derived: scripts/build_db.py rebuilds it from a
-- raw feed snapshot, so it is safe to delete. Parsed fields are best-effort
-- heuristics; raw source values are always kept alongside them.

CREATE TABLE posts (
    id            TEXT PRIMARY KEY,   -- Blogger post id
    post_number   INTEGER,            -- "(#2658)" as written in the title; NULL on early posts
    published     TEXT NOT NULL,      -- ISO timestamp from Blogger
    updated       TEXT,
    feature_date  TEXT,               -- YYYY-MM-DD the title says the post is for
    url           TEXT NOT NULL,
    title         TEXT NOT NULL,      -- raw title
    subject       TEXT,               -- "Bari Ziperstein", "Art Deco movement (Part 1)"
    descriptor    TEXT,               -- "American ceramist" (article stripped)
    title_note    TEXT,               -- bracketed asides, e.g. "New artist to watch in 2026"
    kind          TEXT NOT NULL,      -- artist | group | theme
    labels        TEXT NOT NULL,      -- JSON array of Blogger labels, raw
    life_dates_raw TEXT,              -- "(1935 – 2012)" as found in the bio
    content_html  TEXT NOT NULL,      -- archived only; author's writing, not for republishing
    content_text  TEXT NOT NULL,      -- plain text minus image captions; archived only
    flags         TEXT NOT NULL       -- JSON array of parse warnings for review
);

-- A creator featured on the blog: a person, or a group (duo, studio, agency).
-- One creator can be featured in several posts.
CREATE TABLE artists (
    id            INTEGER PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL,      -- person | group
    birth_year    INTEGER,
    death_year    INTEGER,
    nationality   TEXT,               -- as written: "British-born American"
    roles         TEXT NOT NULL,      -- JSON array: ["ceramist", "sculptor"]
    wikidata_qid  TEXT,               -- phase 3, when matched (auto or confirmed)
    dates_source  TEXT,               -- wikidata | parsed | NULL
    region        TEXT                -- Europe, Asia, Africa, North America, ...
);

-- Phase 3 enrichment, merged in from derived/ and curation/ on every build.
CREATE TABLE artist_wikidata (
    artist_id     INTEGER PRIMARY KEY REFERENCES artists(id),
    qid           TEXT NOT NULL,
    label         TEXT,
    description   TEXT,
    birth_year    INTEGER,
    death_year    INTEGER,
    gender        TEXT,
    countries     TEXT NOT NULL,      -- JSON array of country names
    birthplace    TEXT,               -- JSON {name, lat, lon}
    movements     TEXT NOT NULL,      -- JSON array
    occupations   TEXT NOT NULL,      -- JSON array
    enwiki        TEXT                -- English Wikipedia article title
);

CREATE TABLE image_colors (
    post_id       TEXT NOT NULL,
    url_hash      TEXT NOT NULL,
    palette       TEXT NOT NULL,      -- JSON [[hex, weight], ...]
    buckets       TEXT NOT NULL,      -- JSON colour names covering >= 12%
    hue           TEXT,               -- strongest chromatic colour, NULL if neutral
    lightness     REAL,
    PRIMARY KEY (post_id, url_hash)
);

CREATE TABLE image_similar (
    post_id       TEXT NOT NULL,
    url_hash      TEXT NOT NULL,
    similar       TEXT NOT NULL,      -- JSON [[post_id, url_hash, cosine], ...] from other posts
    PRIMARY KEY (post_id, url_hash)
);

CREATE TABLE post_artists (
    post_id       TEXT NOT NULL REFERENCES posts(id),
    artist_id     INTEGER NOT NULL REFERENCES artists(id),
    PRIMARY KEY (post_id, artist_id)
);

-- Labels that aren't the subject's name: roles ("Painter"), themed weeks ("Italia week").
CREATE TABLE post_tags (
    post_id       TEXT NOT NULL REFERENCES posts(id),
    tag           TEXT NOT NULL,
    PRIMARY KEY (post_id, tag)
);

CREATE TABLE images (
    id            INTEGER PRIMARY KEY,
    post_id       TEXT NOT NULL REFERENCES posts(id),
    position      INTEGER NOT NULL,   -- order within the post, from 0
    url_hash      TEXT NOT NULL,      -- stable key (aotd.parse.image_key); ids change on rebuild
    src_url       TEXT NOT NULL,      -- as embedded in the post
    link_url      TEXT,               -- the <a href> wrapping the image, if any
    original_url  TEXT,               -- full-resolution URL; NULL for embedded data: images
    filename      TEXT,               -- decoded filename, when the URL has one
    width         INTEGER,            -- data-original-width/height
    height        INTEGER,
    caption_raw   TEXT,
    caption_source TEXT,              -- caption | filename | NULL
    title         TEXT,               -- parsed artwork title
    year_start    INTEGER,
    year_end      INTEGER,
    circa         INTEGER NOT NULL DEFAULT 0,
    kind          TEXT NOT NULL,      -- artwork | intro | portrait | other
    kind_source   TEXT NOT NULL       -- heuristic (phase 1); later: clip, manual
);

CREATE INDEX images_post ON images(post_id, position);
CREATE UNIQUE INDEX images_key ON images(post_id, url_hash, position);
CREATE INDEX images_kind ON images(kind);
CREATE INDEX post_artists_artist ON post_artists(artist_id);
CREATE INDEX posts_feature_date ON posts(feature_date);

CREATE TABLE build_info (
    key           TEXT PRIMARY KEY,
    value         TEXT
);
