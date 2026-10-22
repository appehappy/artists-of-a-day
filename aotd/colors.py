"""Name colours and summarise an image's palette for colour browsing."""
import colorsys

# Swatches offered on the Wall, in display order, with a representative colour.
BUCKETS = {
    "red": "#c8302c", "orange": "#e07b2a", "yellow": "#e8c33a", "green": "#4e9a4a",
    "teal": "#2a9a96", "blue": "#2f5fb3", "purple": "#7a4bb0", "pink": "#de6fa1",
    "brown": "#7b5333", "black": "#1b1b1b", "grey": "#8c8c8c", "white": "#f2f0ea",
}
NEUTRAL = {"black", "grey", "white"}


def bucket(r, g, b):
    """Name an sRGB colour (0–255) as one of BUCKETS."""
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    if l < 0.12 or (s < 0.15 and l < 0.3):
        return "black"
    if l > 0.92 or (s < 0.15 and l > 0.78):
        return "white"
    if s < 0.15:
        return "grey"
    deg = h * 360
    if deg < 15 or deg >= 345:
        return "brown" if l < 0.3 else "red"
    if deg < 40:
        return "brown" if l < 0.42 or s < 0.35 else "orange"
    if deg < 65:
        return "brown" if l < 0.3 else "yellow"
    if deg < 160:
        return "green"
    if deg < 195:
        return "teal"
    if deg < 255:
        return "blue"
    if deg < 290:
        return "purple"
    return "pink"


def summarize(palette):
    """palette: [(hex, weight)] summing to ~1. Returns the image's colour buckets
    (those covering at least 12% of it, most prominent first) and its main hue,
    the strongest chromatic bucket, or None for an essentially neutral image."""
    weights = {}
    for hex_, w in palette:
        r, g, b = (int(hex_[i:i + 2], 16) for i in (1, 3, 5))
        name = bucket(r, g, b)
        weights[name] = weights.get(name, 0) + w
    ranked = sorted(weights.items(), key=lambda kv: -kv[1])
    chromatic = [(k, w) for k, w in ranked if k not in NEUTRAL]
    hue = chromatic[0][0] if chromatic and chromatic[0][1] >= 0.08 else None
    return {"buckets": [k for k, w in ranked if w >= 0.12], "hue": hue}
