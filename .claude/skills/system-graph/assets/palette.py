#!/usr/bin/env python3
"""
Generate + validate the system-graph categorical palette in OKLCH.

Design law (see references/design-system.md):
  - Categorical hues are generated at CONSTANT lightness L and chroma C so no
    category reads as louder or "more important" than another.
  - Colour is NEVER the sole carrier of category: every node kind also has a
    distinct SHAPE. That is what makes the palette colour-vision-deficiency safe
    without paying the Okabe-Ito lightness-stagger tax.
  - Every generated pair is validated against WCAG 1.4.11 (>=3:1 for graphical
    objects vs canvas) and 1.4.3 (>=4.5:1 for label text on its own fill).

Run:  python3 palette.py            # print table + validation
      python3 palette.py --json     # emit tokens.json
"""
import json
import math
import sys

# ---------------------------------------------------------------- colour math

def _srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _linear_to_srgb(c):
    return 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


def oklch_to_srgb(L, C, H):
    """OKLCH -> linear sRGB triple (may be out of gamut)."""
    h = math.radians(H)
    a, b = C * math.cos(h), C * math.sin(h)
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    return (r, g, bl)


def oklch_to_hex(L, C, H):
    """Gamut-map by reducing chroma until the colour fits sRGB, then hex it."""
    c = C
    for _ in range(200):
        rgb = oklch_to_srgb(L, c, H)
        if all(-1e-4 <= v <= 1 + 1e-4 for v in rgb):
            break
        c *= 0.98
    rgb = oklch_to_srgb(L, c, H)
    out = []
    for v in rgb:
        v = min(1.0, max(0.0, v))
        out.append(round(_linear_to_srgb(v) * 255))
    return "#{:02x}{:02x}{:02x}".format(*out)


def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def relative_luminance(hexstr):
    r, g, b = (_srgb_to_linear(c) for c in hex_to_rgb(hexstr))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = relative_luminance(a), relative_luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


# ------------------------------------------------------------------- the spec
# Five categorical hues + two structural neutrals + one reserved alert hue.
# Hues are chosen for perceptual separation, not by dividing 360 evenly.
KINDS = [
    # key        hue  shape             meaning
    ("intake",    264, "round-tag",     "Where work enters the factory"),
    ("transform", 152, "round-rect",    "Work is done / value is added"),
    ("gate",       82, "diamond",       "A decision, check, or quality gate"),
    ("store",     310, "cylinder",      "Durable state or an artifact at rest"),
    ("release",   196, "cut-rect",      "Work leaves the factory"),
]
CONTROL_HUE = 264   # control spine is achromatic-leaning ink, hue only tints it
ALERT_HUE = 27      # reserved: violations / gaps. NEVER a category.

THEMES = {
    # name : (canvas L, surface L, accent L, accent C, fill L, fill C, text L, text C)
    "dark":  dict(canvasL=0.1750, surfaceL=0.2180, accentL=0.7600, accentC=0.1450,
                  fillL=0.2850,  fillC=0.0450,   textL=0.9550,  textC=0.0120,
                  neutralHue=264),
    "light": dict(canvasL=0.9850, surfaceL=1.0000, accentL=0.5450, accentC=0.1550,
                  fillL=0.9450,  fillC=0.0400,   textL=0.3100,  textC=0.0520,
                  neutralHue=264),
}


def build():
    tokens = {"meta": {"space": "oklch", "generated_by": "assets/palette.py"},
              "kinds": {k: {"hue": h, "shape": s, "meaning": m}
                        for k, h, s, m in KINDS},
              "themes": {}}

    for tname, t in THEMES.items():
        nh = t["neutralHue"]
        canvas = oklch_to_hex(t["canvasL"], 0.010, nh)
        surface = oklch_to_hex(t["surfaceL"], 0.012, nh)
        theme = {
            "canvas": canvas,
            "surface": surface,
            "hairline": oklch_to_hex(
                t["canvasL"] + (0.10 if tname == "dark" else -0.09), 0.012, nh),
            "ink": oklch_to_hex(t["textL"] if tname == "light" else 0.965, 0.008, nh),
            "ink_muted": oklch_to_hex(
                0.660 if tname == "dark" else 0.520, 0.014, nh),
            "alert": {
                "accent": oklch_to_hex(t["accentL"], t["accentC"] * 1.15, ALERT_HUE),
                "fill": oklch_to_hex(t["fillL"], t["fillC"] * 1.3, ALERT_HUE),
                "text": oklch_to_hex(t["textL"], t["textC"], ALERT_HUE),
            },
            "control": {
                "accent": oklch_to_hex(
                    0.720 if tname == "dark" else 0.480, 0.018, nh),
                "fill": oklch_to_hex(
                    0.330 if tname == "dark" else 0.915, 0.010, nh),
                "text": oklch_to_hex(t["textL"], 0.008, nh),
            },
            "external": {
                "accent": oklch_to_hex(
                    0.560 if tname == "dark" else 0.640, 0.012, nh),
                "fill": oklch_to_hex(
                    0.225 if tname == "dark" else 0.968, 0.006, nh),
                "text": oklch_to_hex(
                    0.680 if tname == "dark" else 0.470, 0.010, nh),
            },
            "kinds": {},
        }
        for key, hue, _shape, _m in KINDS:
            theme["kinds"][key] = {
                "accent": oklch_to_hex(t["accentL"], t["accentC"], hue),
                "fill": oklch_to_hex(t["fillL"], t["fillC"], hue),
                "text": oklch_to_hex(t["textL"], t["textC"], hue),
            }
        tokens["themes"][tname] = theme
    return tokens


def validate(tokens, verbose=True):
    """Returns list of failures. Empty list == palette is compliant."""
    fails = []
    for tname, theme in tokens["themes"].items():
        canvas = theme["canvas"]
        groups = dict(theme["kinds"])
        groups["control"] = theme["control"]
        groups["external"] = theme["external"]
        groups["alert"] = theme["alert"]
        for key, c in groups.items():
            # WCAG 1.4.11 - graphical object (the node's accent border) vs canvas
            r1 = contrast(c["accent"], canvas)
            # WCAG 1.4.3 - node label text on the node's own fill
            r2 = contrast(c["text"], c["fill"])
            # fill must be distinguishable from canvas at all (soft target)
            r3 = contrast(c["fill"], canvas)
            ok1, ok2 = r1 >= 3.0, r2 >= 4.5
            if verbose:
                print(f"  {tname:5s} {key:10s} accent/canvas {r1:5.2f} "
                      f"{'OK ' if ok1 else 'FAIL'}   text/fill {r2:5.2f} "
                      f"{'OK ' if ok2 else 'FAIL'}   fill/canvas {r3:4.2f}")
            if not ok1:
                fails.append(f"{tname}.{key}: accent vs canvas {r1:.2f} < 3.0")
            if not ok2:
                fails.append(f"{tname}.{key}: text vs fill {r2:.2f} < 4.5")
    return fails


if __name__ == "__main__":
    tk = build()
    if "--json" in sys.argv:
        print(json.dumps(tk, indent=2))
    else:
        for tname, theme in tk["themes"].items():
            print(f"\n[{tname}] canvas {theme['canvas']}  surface {theme['surface']}")
            for k, v in list(theme["kinds"].items()) + [
                    ("control", theme["control"]), ("external", theme["external"]),
                    ("alert", theme["alert"])]:
                print(f"    {k:10s} accent {v['accent']}  fill {v['fill']}  text {v['text']}")
        print("\nWCAG validation (1.4.11 >=3:1 accent/canvas, 1.4.3 >=4.5:1 text/fill):")
        f = validate(tk)
        print("\nRESULT:", "PASS - palette is compliant" if not f else
              "FAIL\n  " + "\n  ".join(f))
        sys.exit(1 if f else 0)
