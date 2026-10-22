"""Best-effort parsers for Artist of the Day posts.

Nine years of hand-typed titles and captions means every rule here is a heuristic.
Callers keep the raw values next to the parsed ones, and parsers return flags for
anything they had to guess at so it can be reviewed later.
"""
import hashlib
import html as htmllib
import re
import unicodedata
import urllib.parse
from bisect import bisect_right
from datetime import date, datetime

MONTHS = ["january", "february", "march", "april", "may", "june", "july",
          "august", "september", "october", "november", "december"]

TITLE_DATE = re.compile(
    r"\b(" + "|".join(MONTHS) + r")\s+(\d{1,2})(?:\s*[-–&]\s*\d{1,2})?(?:\s*,?\s*(\d{4}))?",
    re.I)
# "(#2658)", "[#1854]", "#1883", "(# 1595)" at the end of a title
TITLE_NUMBER = re.compile(r"\s*[(\[]?\s*#\s*(\d+)\s*[)\]]?\s*$")
# "(2108)" — a post number missing its "#"
TITLE_BARE_NUMBER = re.compile(r"\s*\((\d{3,4})\)\s*$")
BILINGUAL_ENGLISH = re.compile(r"/\s*Artists? of the day", re.I)
THEMED_WEEK = re.compile(r"\(([^)]*\b(?:week|semaine|semana)\b[^)]*)\)", re.I)

NAME_PARTICLES = {"de", "da", "di", "del", "della", "van", "von", "der", "den", "du",
                  "la", "le", "y", "e", "&", "and", "of", "bin", "al", "el", "ten", "st.",
                  "the", "aka", "a.k.a."}
GROUP_WORDS = re.compile(
    r"\b(studio|studios|agency|firm|collective|duo|group|company|partners|team|"
    r"brothers|sisters|couple|artists|sculptors|designers|painters|photographers|"
    r"architects|illustrators)\b", re.I)
# Words that end the nationality run when capitalized ("a Brazilian Painter").
ROLE_WORDS = {"painter", "sculptor", "artist", "photographer", "designer", "illustrator",
              "architect", "graphic", "printmaker", "ceramist", "potter", "cartoonist",
              "typographer", "animator", "filmmaker", "muralist", "street", "visual",
              "fine", "contemporary", "abstract", "emerging", "pop", "conceptual",
              "installation", "fashion", "industrial", "product", "art", "letterer",
              "calligrapher", "poster", "glass", "textile", "multidisciplinary",
              "expressionist", "impressionist", "surrealist", "watercolor", "landscape",
              "portrait", "digital", "mixed", "self-taught", "modernist", "realist"}

YEAR = r"(1[2-9]\d\d|20[0-3]\d)"
CIRCA = r"(?:(c\.|ca\.|circa|c)\s*)?"
YEAR_RANGE = YEAR + r"(?:\s*[-–/]\s*(\d{2,4}))?"
CAPTION_LEADING_YEAR = re.compile(
    r"^\s*" + CIRCA + YEAR_RANGE + r"(?![\d'\"s])\s*[,.:;\-–]?\s+(?P<rest>.+)$", re.I | re.S)
CAPTION_TRAILING_YEAR = re.compile(
    r"^(?P<rest>.*?)[\s,(]+" + CIRCA + YEAR_RANGE + r"(?![\d'\"s])\s*\)?\s*\.?$", re.I | re.S)
CAPTION_ANY_YEAR = re.compile(r"(?<!\d)" + CIRCA + YEAR_RANGE + r"(?![\d'\"s])", re.I)
COPYRIGHT = re.compile(r"^\s*©|all rights reserved", re.I)

LIFE_DATES = re.compile(
    r"\(\s*[^()\d]{0,15}?\s*(?:b\.|born)?\s*(\d{4})\s*(?:(?:[-–—]|to)\s*(\d{2,4})?)?\s*\)")

CAPTION_TABLE = re.compile(
    r'<table[^>]*class="tr-caption-container"[^>]*>(.*?)</table>', re.S | re.I)
CAPTION_CELL = re.compile(r'class="tr-caption"[^>]*>(.*?)</td>', re.S | re.I)
IMG_TAG = re.compile(r"<img\b[^>]*>", re.I)
ANCHOR_BEFORE_IMG = re.compile(r'<a\s[^>]*href="([^"]+)"[^>]*>\s*$', re.I)


def html_to_text(fragment):
    s = re.sub(r"<br\s*/?>|</(p|div|h\d|li|tr)>", "\n", fragment, flags=re.I)
    s = htmllib.unescape(re.sub(r"<[^>]+>", " ", s))
    s = re.sub(r"[ \t ]+", " ", s)
    return re.sub(r"\s*\n\s*", "\n", s).strip()


def slugify(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def _name_tokens(s):
    return set(slugify(s).split("-")) - {""}


def looks_like_name(s):
    """Proper-noun-ish: 1–6 words, each capitalized or a name particle.
    Nicknames and aliases are ignored: 'Ljubica "Cuca" Sokić', 'Meir Eshel (Absalon)'."""
    s = re.sub(r"\([^)]*\)|\"[^\"]*\"|“[^”]*”", " ", s)
    words = s.split()
    if not 1 <= len(words) <= 8 or re.search(r"\d|[\"“”!?:]", s):
        return False
    # any capital counts, for names like "diCorcia"
    return all(w.lower() in NAME_PARTICLES or any(ch.isupper() for ch in w) for w in words)


def _closest_year(month, day, published):
    candidates = []
    for y in (published.year - 1, published.year, published.year + 1):
        try:
            candidates.append(date(y, month, day))
        except ValueError:
            pass
    return min(candidates, key=lambda d: abs((d - published).days)) if candidates else None


def parse_title(title, published_iso):
    """Split a post title into number, feature date, subject, descriptor and notes."""
    flags, notes = [], []
    published = datetime.fromisoformat(published_iso).date()
    t = re.sub(r"\s+", " ", title).strip()

    m = BILINGUAL_ENGLISH.search(t)
    if m:
        t = t[m.start() + 1:].strip()

    number = None
    m = TITLE_NUMBER.search(t)
    if m:
        number = int(m.group(1))
        t = t[:m.start()]
    else:
        m = TITLE_BARE_NUMBER.search(t)
        if m:
            number = int(m.group(1))
            t = t[:m.start()]
            flags.append("post_number_without_hash")

    feature_date, plural = None, False
    m = TITLE_DATE.search(t[:70])
    if m:
        prefix = t[:m.start()]
        plural = bool(re.search(r"artists\b", prefix, re.I))
        notes += re.findall(r"\(([^)]*)\)", prefix)  # "(Brazil week)"
        month, day = MONTHS.index(m.group(1).lower()) + 1, int(m.group(2))
        try:
            feature_date = (date(int(m.group(3)), month, day) if m.group(3)
                            else _closest_year(month, day, published))
        except ValueError:
            flags.append("invalid_title_date")
        rest = t[m.end():]
    else:
        flags.append("no_title_date")
        plural = bool(re.search(r"^\W*artists\b", t, re.I))
        rest = t.split(":", 1)[1] if ":" in t else t
    if feature_date and abs((feature_date - published).days) > 3:
        flags.append("title_date_far_from_published")
    rest = rest.lstrip(" :,.;-–")

    notes += re.findall(r"\[([^\]]*)\]", rest)
    rest = re.sub(r"\s*\[[^\]]*\]", "", rest).strip()

    # Themed-week asides: "(India week): X", "X (Women in the arts week): ...",
    # "Women in the arts week: X", "Bergeron family: X", stray "1: X".
    notes += THEMED_WEEK.findall(rest)
    rest = THEMED_WEEK.sub("", rest).strip().lstrip(" :,.;-–")
    m = re.match(r"^([^:,]{1,45}?)\s*:\s*(.+)$", rest)
    if m:
        prefix = m.group(1).strip()
        if (re.search(r"\b(week|family|semaine|semana)\b", prefix, re.I)
                or re.fullmatch(r"\(.*\)", prefix)):         # "(Happy birthday Canada): X"
            notes.append(prefix.strip("()"))
            rest = m.group(2)
        elif re.fullmatch(r"[\d\s-]+", prefix) or TITLE_DATE.fullmatch(prefix):  # "July 1: X"
            rest = m.group(2)

    m_is = re.match(r"^(.*?)\s+(?:is|was)\s+an?\s+(.*)$", rest)
    m_colon = re.match(r"^([^:,]+?)\s*:\s*(.+)$", rest)
    # "Flavien Couche a French painter" — article before a capitalized nationality, no comma
    m_article = re.match(r"^([^,]+?)\s+an?\s+([A-Z].*)$", rest)
    # "Wang Guangyi. A Chinese painter" — but not the initial in "Victor A. Lundy"
    m_period = re.match(r"^([^,]*?\w\w)\.\s+(?:an?\s+)?([A-Z].*)$", rest)
    if m_is and looks_like_name(m_is.group(1)):
        subject, descriptor = m_is.group(1), m_is.group(2)
    elif m_colon and looks_like_name(m_colon.group(1)):
        subject, descriptor = m_colon.group(1), m_colon.group(2)
    elif m_article and looks_like_name(m_article.group(1)):
        subject, descriptor = m_article.group(1), m_article.group(2)
    elif m_period and looks_like_name(m_period.group(1)):
        subject, descriptor = m_period.group(1), m_period.group(2)
    elif "," in rest:
        subject, descriptor = rest.split(",", 1)
    else:
        subject, descriptor = rest, None
    subject = subject.strip(" .,")
    if descriptor is not None:
        descriptor = re.sub(r"^\s*(an?|the)\s+", "", descriptor.strip(), flags=re.I)
        descriptor = descriptor.strip(" .,") or None

    if not number:
        flags.append("no_post_number")
    return {
        "post_number": number,
        "feature_date": feature_date.isoformat() if feature_date else None,
        "subject": subject or None,
        "descriptor": descriptor,
        "title_note": "; ".join(n.strip() for n in notes if n.strip()) or None,
        "plural": plural,
        "flags": flags,
    }


def classify_post(subject, descriptor, plural):
    """artist (one person) | group (duo, studio, agency) | theme (topic round-up)."""
    if not subject:
        return "theme"
    if descriptor is None:
        return "artist" if (not plural and looks_like_name(subject)) else "theme"
    if GROUP_WORDS.search(descriptor) or GROUP_WORDS.search(subject):
        return "group"
    if not looks_like_name(subject):
        return "theme"
    if re.search(r"\s(&|and)\s", subject):
        return "group"
    return "artist"


def parse_descriptor(descriptor):
    """'British-born American graphic designer, letterer' -> (nationality, roles)."""
    if not descriptor:
        return None, []
    d = re.sub(r"\([^)]*\)", " ", descriptor)
    tokens = d.replace(",", " , ").split()
    nat = []
    for tok in tokens:
        bare = tok.strip(",").lower()
        if tok == ",":
            if nat:
                continue
            break
        if (tok[0].isupper() and bare not in ROLE_WORDS) or (nat and bare in ("born", "-born")):
            nat.append(tok)
        else:
            break
    # Drop the consumed nationality tokens (and any commas between them) from the front.
    consumed, i = 0, 0
    while i < len(tokens) and consumed < len(nat):
        if tokens[i] != ",":
            consumed += 1
        i += 1
    rest = " ".join(tokens[i:])
    roles = []
    for part in re.split(r",|\band\b|&|/", rest):
        part = re.sub(r"^\s*(an?|the)\s+", "", part.strip(), flags=re.I).strip(" .").lower()
        if part and part not in roles:
            roles.append(part)
    return (" ".join(nat) or None), roles


def parse_life_dates(text, subject):
    """Find '(1863 – 1944)' near the subject's name in the bio. Returns (birth, death, raw)."""
    window_start, window_end = 0, 300
    surname = subject.split()[-1] if subject else None
    if surname:
        pos = text.find(surname, 0, 1500)
        if pos >= 0:
            window_start, window_end = pos, pos + len(surname) + 250
    m = LIFE_DATES.search(text, window_start, window_end)
    if not m:
        return None, None, None
    birth = int(m.group(1))
    death = m.group(2)
    if death:
        death = int(death)
        if death < 100:  # "(1907–78)"
            death += birth // 100 * 100
            if death < birth:
                death += 100
    if not 1200 <= birth <= 2015 or (death and not birth < death <= 2030):
        return None, None, m.group(0)
    return birth, death, m.group(0)


def original_image_url(src):
    """Rewrite a Blogger image URL to request the full-resolution original."""
    if src.startswith("data:"):
        return None
    out = re.sub(r"/(s\d+(?:-[a-z0-9-]+)?|w\d+-h\d+[^/]*|d)/([^/]+)$", r"/s0/\2", src)
    return re.sub(r"=[swh]\d[^/=]*$", "=s0", out)


def image_key(src_url, original_url):
    """Stable short id for an image, independent of database row ids. Matches the
    <hash> in downloaded filenames (<position>_<hash>.<ext>)."""
    return hashlib.sha1((original_url or src_url).encode()).hexdigest()[:10]


def image_filename(src):
    if src.startswith("data:") or "/img/a/" in src:
        return None
    name = src.rsplit("/", 1)[-1]
    return urllib.parse.unquote(urllib.parse.unquote(name)).replace("+", " ").strip() or None


def _expand_end(start, end):
    if end is None:
        return None
    end = int(end)
    if end < 100:
        end += start // 100 * 100
        if end < start:
            end += 100
    return end if start <= end <= start + 100 else None


def _clean_title(s):
    s = re.sub(r"\s+", " ", s).strip(" ,.;:-–\"'“”‘’")
    return s or None


def parse_caption(caption):
    """'1962, L'Incompris' / 'Force, 1964' / 'Aloe, c.1914-15' -> (title, start, end, circa)."""
    if not caption or re.match(r"\s*©", caption):
        return None, None, None, False
    # "Seaweed, 1927 © Georgia O'Keeffe Museum 2017" — the credit's year isn't the work's
    caption = re.sub(r"\s*(?:Photo(?:graph)?\s*(?:by|:)?\s*)?©.*$", "", caption, flags=re.I | re.S)
    if not caption.strip() or COPYRIGHT.search(caption):
        return None, None, None, False
    m = CAPTION_LEADING_YEAR.match(caption)
    if m:
        start = int(m.group(2))
        rest = m.group("rest")
        # Filenames often repeat the year at the end: "2006 Souvenir, 2006"
        rest = re.sub(r"[\s,]+" + str(start) + r"\s*$", "", rest)
        return _clean_title(rest), start, _expand_end(start, m.group(3)), bool(m.group(1))
    m = CAPTION_TRAILING_YEAR.match(caption)
    if m:
        start = int(m.group(3))
        return (_clean_title(m.group("rest")), start, _expand_end(start, m.group(4)),
                bool(m.group(2)))
    m = CAPTION_ANY_YEAR.search(caption)
    if m:
        start = int(m.group(2))
        if re.fullmatch(r"\s*" + re.escape(m.group(0)) + r"\s*", caption):
            return None, start, _expand_end(start, m.group(3)), bool(m.group(1))
        return _clean_title(caption), start, _expand_end(start, m.group(3)), bool(m.group(1))
    return _clean_title(caption), None, None, False


def filename_caption(filename):
    """Turn '0 1893 The Scream, 1893.jpg' into caption-like text, or None."""
    if not filename:
        return None
    stem = re.sub(r"\.(jpe?g|png|gif|webp|tiff?)$", "", filename, flags=re.I)
    stem = re.sub(r"^\d{1,2}(\.\d+)?\s+(?=\S)", "", stem)   # leading sort index
    stem = re.sub(r"[_]+", " ", stem).strip()
    if " " not in stem:
        stem = stem.replace("-", " ")   # "A-typical-Pakistani-truck-art-1"
    if (len(stem) < 3 or re.fullmatch(r"(img|dsc|image|photo)?[\s\d-]*", stem, re.I)
            or re.search(r"[0-9a-f]{8,}", stem, re.I) or re.fullmatch(r"\w?\d[\w\s-]*", stem)):
        return None   # camera names, web hashes like "f00bddf29ee3…", ids like "a2191503-0"
    return stem


def classify_image(position, filename, caption, subject):
    """artwork | intro | portrait | other, from filename and caption cues."""
    f = (filename or "").lower()
    c = (caption or "").lower()
    both = f + " " + c
    if "intro" in f or c.startswith("intro"):
        return "intro"
    if "signature" in both:
        return "other"
    if "self-portrait" in both or "self portrait" in both:
        return "artwork"
    if re.search(r"portrait of (the )?artist|photo(graph)? of the artist|"
                 r"the artist (in|at|with)|artist portrait|portrait de l", both):
        return "portrait"
    if subject:
        name = subject.lower()
        surname = name.split()[-1]
        if "portrait" in f and (not c or surname in c):
            return "portrait"
        if c and _name_tokens(c) and _name_tokens(c) <= _name_tokens(name) | {"photo", "portrait"}:
            return "portrait"
    if position == 0 and not caption and not filename:
        return "intro"
    return "artwork"


def _attr(tag, name):
    m = re.search(r'\b' + name + r'="([^"]*)"', tag)
    return m.group(1) if m else None


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def extract_images(content_html):
    """Every <img> in a post, in order, with its caption-table caption if it has one."""
    tables = [(m.start(), m.end(), m.group(1)) for m in CAPTION_TABLE.finditer(content_html)]
    starts = [t[0] for t in tables]
    out = []
    for pos, m in enumerate(IMG_TAG.finditer(content_html)):
        tag = m.group(0)
        src = htmllib.unescape(_attr(tag, "src") or "")
        if not src:
            continue
        caption = None
        i = bisect_right(starts, m.start()) - 1
        if i >= 0 and tables[i][0] <= m.start() < tables[i][1]:
            cell = CAPTION_CELL.search(tables[i][2])
            if cell:
                caption = re.sub(r"\s+", " ", html_to_text(cell.group(1))).strip() or None
        a = ANCHOR_BEFORE_IMG.search(content_html, max(0, m.start() - 3000), m.start())
        out.append({
            "position": pos,
            "src_url": src,
            "link_url": htmllib.unescape(a.group(1)) if a else None,
            "width": _int(_attr(tag, "data-original-width")) or _int(_attr(tag, "width")),
            "height": _int(_attr(tag, "data-original-height")) or _int(_attr(tag, "height")),
            "caption": caption,
        })
    return out


def body_text(content_html):
    """Post prose with image caption tables removed."""
    return html_to_text(CAPTION_TABLE.sub("\n", content_html))
