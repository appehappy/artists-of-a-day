"""What an artwork image is made as: the nine media of the chronology plate.

The order is the plate's 3×3 reading order: flat work made by hand, then objects,
then work made with a camera or for use. scripts/classify_media.py scores every
artwork against the prompts below with CLIP, then weighs the scores by what the
artist is known for (their disciplines), because to CLIP every sculpture, building
and vase is also "a photograph".
"""

MEDIA = [
    ("painting", "Painting"),
    ("drawing", "Drawing and illustration"),
    ("print", "Printmaking"),
    ("sculpture", "Sculpture"),
    ("ceramics", "Ceramics and glass"),
    ("media", "Installation and media"),
    ("photography", "Photography"),
    ("graphic", "Graphic design"),
    ("design", "Architecture and product"),
]
KEYS = [k for k, _ in MEDIA]
# Not one artwork: left off the plate.
EXCLUDE = "exclude"

PROMPTS = {
    "painting": ["an oil painting", "an acrylic painting on canvas", "a watercolour painting",
                 "an abstract painting", "a painted portrait", "a landscape painting",
                 "a gouache painting", "a mural painted on a wall", "a still life painting"],
    "drawing": ["a pencil drawing", "a charcoal drawing", "a pen and ink drawing", "a sketch",
                "a digital illustration", "a children's book illustration", "a cartoon",
                "a comic book page", "a fashion illustration", "an editorial illustration"],
    "print": ["a woodcut print", "an etching", "a lithograph", "a linocut print",
              "a japanese woodblock print", "an engraving", "a screen print"],
    "sculpture": ["a photo of a sculpture", "a bronze sculpture", "a marble statue",
                  "a public sculpture outdoors", "a carved wooden sculpture",
                  "an abstract metal sculpture", "a figurative sculpture on a plinth"],
    "ceramics": ["a ceramic vase", "a ceramic bowl", "studio pottery", "a porcelain vessel",
                 "a glass vase", "blown glass art", "a stoneware pot"],
    "media": ["an art installation in a gallery", "a light installation",
              "an immersive installation", "a still from a video artwork",
              "a performance art photograph", "a textile wall hanging", "a mixed media assemblage"],
    "photography": ["a fine art photograph", "a black and white documentary photograph",
                    "a street photograph", "a fashion photograph", "a landscape photograph",
                    "a portrait photograph", "a vintage photograph"],
    "graphic": ["a poster design", "a logo design", "a book cover design", "a typography poster",
                "an album cover design", "a magazine cover", "a brand identity design",
                "a vintage advertising poster"],
    "design": ["a photo of a building", "modern architecture", "an interior design",
               "a chair design", "a product design photo", "a car design", "a lamp design",
               "a piece of jewellery", "a fashion design on a model"],
    EXCLUDE: ["a collage of several artworks", "a grid of many small images",
              "a page of text", "a screenshot of a website", "a book spread with text and pictures"],
}

# The site's artist disciplines (scripts/export_site_data.py DISCIPLINES) ->
# (media their work is mostly in, media it is sometimes in). Classification is by what
# the work physically is, so an illustrator's gouache is a painting.
DISCIPLINE_MEDIA = {
    "painting": (["painting"], ["drawing", "print"]),
    "street": (["painting"], ["media"]),
    "illustration": (["drawing", "painting"], ["print", "graphic"]),
    "print": (["print"], ["drawing"]),
    "sculpture": (["sculpture"], ["media", "drawing"]),
    "ceramics": (["ceramics"], ["sculpture"]),
    "media": (["media"], ["sculpture", "photography"]),
    "photography": (["photography"], []),
    "graphic": (["graphic"], ["drawing", "print"]),
    "architecture": (["design"], ["drawing"]),
    "design": (["design"], ["graphic", "ceramics"]),
}

# Weights tuned against curation/media_sample.csv (hand-labelled). A medium outside
# the artist's disciplines needs CLIP to be about 20:1 sure; "exclude" is weighed
# down because posters and book covers look like pages of text to CLIP.
SECONDARY = 0.1
UNEXPECTED = 0.05
EXCLUDE_WEIGHT = 0.3
# CLIP logit scale: 50 rather than CLIP's own 100 softens its scores, so the artist
# prior and the post's other works can tip a close call.
TEMPERATURE = 50
# How strongly the post's other works vote (exponent on their mean probabilities):
# an artist's works in one post are usually in one or two media.
POST_WEIGHT = 1.0


def prior(disciplines):
    """{medium: weight} for an artist's disciplines; every medium is weight 1 when we
    know nothing (theme posts, unrecognised roles)."""
    primary, secondary = set(), set()
    for d in disciplines:
        p, s = DISCIPLINE_MEDIA.get(d, ([], []))
        primary.update(p)
        secondary.update(s)
    if not primary:
        return {m: 1.0 for m in KEYS + [EXCLUDE]}
    weights = {m: 1.0 if m in primary else SECONDARY if m in secondary else UNEXPECTED
               for m in KEYS}
    weights[EXCLUDE] = EXCLUDE_WEIGHT
    return weights


def decide(scores, weights, post_scores=None):
    """CLIP probabilities {medium: p} for one image, weighed by the artist prior and
    the mean probabilities of all artworks in its post -> ranked [(medium, p), ...],
    renormalised so the probabilities sum to 1."""
    w = {m: p * weights.get(m, UNEXPECTED) * (post_scores[m] ** POST_WEIGHT if post_scores else 1)
         for m, p in scores.items()}
    total = sum(w.values()) or 1.0
    return sorted(((m, v / total) for m, v in w.items()), key=lambda mv: -mv[1])
