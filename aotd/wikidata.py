"""Match archive artists to Wikidata people: record parsing and scoring.

Network access lives in scripts/match_wikidata.py, which turns SPARQL rows into
small normalized records:

  person: {id, label, description, names, human, birth, death, gender,
           occupations, countries (QIDs), birthplace (QID), movements, enwiki}
  place/country: {id, label, continents (QIDs), demonyms, coord, country (QID)}

Everything here is pure so the scoring rules can be unit-tested.
"""
import re
import unicodedata

HUMAN = "Q5"

ART_OCCUPATION = re.compile(
    r"artist|paint|sculpt|photograph|design|illustrat|architect|printmak|ceramic|potter|"
    r"cartoon|typograph|animat|calligraph|graphic|mural|engrav|draughts|drafts|"
    r"art director|letter|poster|glass|textile|etcher|lithograph|caricatur|comics|"
    r"jewel|fashion|furniture|installation|video|performance|woodcut|watercolo|craft",
    re.I)

# Continent QIDs -> display region. Countries in the Americas other than the US and
# Canada are grouped as Latin America & Caribbean.
CONTINENT_REGION = {
    "Q46": "Europe", "Q48": "Asia", "Q15": "Africa", "Q49": "North America",
    "Q18": "Latin America & Caribbean", "Q538": "Oceania", "Q55643": "Oceania",
    "Q3960": "Oceania", "Q51": "Antarctica",
}
NORTH_AMERICA_PROPER = {"Q30", "Q16"}  # United States, Canada


def fold(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9 ]+", " ", s).split()


def search_names(name):
    """Name variants worth searching: 'Ljubica "Cuca" Sokić' -> ['Ljubica Sokić', 'Cuca'],
    'Nikolator (Nikolai Muth)' -> ['Nikolator', 'Nikolai Muth']."""
    aliases = re.findall(r"\(([^)]*)\)|\"([^\"]*)\"|“([^”]*)”", name)
    base = re.sub(r"\([^)]*\)|\"[^\"]*\"|“[^”]*”", " ", name)
    base = re.sub(r"\s(a\.?k\.?a\.?|aka)\s.*$", "", base, flags=re.I)
    base = re.sub(r"^(sir|dame|lady|lord)\s+", "", base.strip(), flags=re.I)
    out = [re.sub(r"\s+", " ", base).strip()]
    m = re.search(r"\s(?:a\.?k\.?a\.?|aka)\s+(.+)$", name, flags=re.I)
    extra = [m.group(1)] if m else []
    for groups in aliases:
        extra += [a for a in groups if a]
    for a in extra:
        a = re.sub(r"^(aka|a\.k\.a\.)\s+", "", a.strip(), flags=re.I)
        if len(a) > 2 and a not in out:
            out.append(a)
    return [n for n in out if n]


def name_similarity(query, names):
    """1.0 for an exact folded match with any label/alias, else best token overlap."""
    q = fold(query)
    if not q:
        return 0.0
    best = 0.0
    for name in names:
        n = fold(name)
        if not n:
            continue
        if n == q:
            return 1.0
        if sorted(n) == sorted(q):
            best = max(best, 0.97)  # "Munch Edvard"
            continue
        best = max(best, len(set(q) & set(n)) / len(set(q) | set(n)))
    return best


def country_region(cid, country):
    continents = country.get("continents", [])
    if "Q46" in continents:  # Russia, Turkey etc. list Europe and Asia; prefer Europe
        return "Europe"
    for q in continents:
        if q == "Q49" and cid not in NORTH_AMERICA_PROPER:
            return "Latin America & Caribbean"
        if q in CONTINENT_REGION:
            return CONTINENT_REGION[q]
    return None


def describe(person, refs):
    """Resolve a person's referenced places/countries (refs: {qid: record})."""
    countries = [refs[c] for c in person["countries"] if c in refs]
    demonyms = sorted({d for c in countries for d in c.get("demonyms", [])})
    region = next((r for c in countries if (r := country_region(c["id"], c))), None)
    birthplace = None
    place = refs.get(person.get("birthplace") or "")
    if place:
        coord = place.get("coord")
        birthplace = {"name": place.get("label"),
                      "lat": coord[0] if coord else None, "lon": coord[1] if coord else None}
        if region is None and place.get("country") in refs:
            region = country_region(place["country"], refs[place["country"]])
    return {
        "qid": person["id"], "label": person.get("label"), "description": person.get("description"),
        "names": person.get("names", []), "human": person.get("human", False),
        "birth": person.get("birth"), "death": person.get("death"), "gender": person.get("gender"),
        "countries": [c.get("label") for c in countries if c.get("label")],
        "demonyms": demonyms, "region": region, "birthplace": birthplace,
        "occupations": person.get("occupations", []), "movements": person.get("movements", []),
        "enwiki": person.get("enwiki"),
    }


def score(artist, cand, rank):
    """Score one candidate (describe() output) for an archive artist
    ({name, birth, nationality}). Returns (score, reasons)."""
    if not cand["human"]:
        return 0.0, ["not a person"]
    reasons = []
    sim = max(name_similarity(n, cand["names"]) for n in search_names(artist["name"]))
    s = 3 * sim
    reasons.append(f"name {sim:.2f}")
    if any(ART_OCCUPATION.search(o) for o in cand["occupations"] + [cand["description"] or ""]):
        s += 1.5
        reasons.append("art occupation")
    if artist.get("birth") and cand["birth"]:
        gap = abs(artist["birth"] - cand["birth"])
        if gap <= 1:
            s += 2
            reasons.append("birth year matches")
        elif gap > 5:
            s -= 1.5
            reasons.append(f"birth year differs ({cand['birth']})")
    nat = set(fold(artist.get("nationality") or "")) - {"born"}
    if nat:
        theirs = {t for d in cand["demonyms"] + cand["countries"] for t in fold(d)}
        if nat & theirs:
            s += 1
            reasons.append("nationality matches")
    if rank == 0:
        s += 0.3
    return round(s, 2), reasons


def decide(best, runner_up, artist):
    """auto | needs_review | no_match, given the two best (score, reasons, cand)."""
    if best is None or best[0] < 3.5:
        return "no_match"
    s, reasons, _ = best
    exactish = any(r.startswith("name ") and float(r.split()[1]) >= 0.95 for r in reasons)
    art = "art occupation" in reasons
    # Parsed birth years are sometimes wrong (another date near the name in the bio),
    # so a matching nationality also corroborates, and a mismatch alone isn't fatal.
    corroborated = "birth year matches" in reasons or "nationality matches" in reasons
    contradicted = any(r.startswith("birth year differs") for r in reasons)
    margin = s - (runner_up[0] if runner_up else 0)
    if exactish and art and margin >= 1.5 and (
            corroborated or (not contradicted and margin >= 2.5)):
        return "auto"
    return "needs_review"
