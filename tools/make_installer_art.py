# Draws the installer's pictures and the logo into build/ (and docs/logo.png for the README):
#   installerSidebar.bmp / uninstallerSidebar.bmp  164x314, the welcome and finish pages
#   installerHeader.bmp                             150x57, the top of the inner pages
#   logo.png                                        banner: icon tile + RMT ANIMATION STUDIO
# The sidebar shows a frame from a City Breaker ultimate (docs/videos/*.jpg) under a slash, with the wordmark below.
# Run: python tools/make_installer_art.py   (needs Pillow; run build/icon.png first with tools/make_icon.py)
import json, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
BUILD = os.path.join(ROOT, "build")
ORANGE, GOLD, INK, SLASH, CREAM = (255, 122, 26), (255, 201, 60), (23, 20, 26), (42, 37, 48), (244, 239, 230)
FONT = "C:/Windows/Fonts/bahnschrift.ttf"
VERSION = json.load(open(os.path.join(ROOT, "package.json")))["version"]
SS = 2   # draw at 2x, then shrink: smooth edges at this tiny size


def font(size, weight="Bold"):
    f = ImageFont.truetype(FONT, size)
    try:
        f.set_variation_by_name(weight)
    except Exception:
        pass
    return f


def fit(draw, text, width, weight="Bold", top=700):
    size = top
    while size > 8:
        f = font(size, weight)
        box = draw.textbbox((0, 0), text, font=f)
        if box[2] - box[0] <= width:
            return f, box
        size -= 2
    f = font(8, weight)
    return f, draw.textbbox((0, 0), text, font=f)


def text_at(draw, cx, top, text, width, fill, weight="Bold", shadow=None, off=0, left=None):
    """Draw text fitted to width, horizontally centred on cx (or starting at `left`), its top edge at `top`."""
    f, box = fit(draw, text, width, weight)
    w = box[2] - box[0]
    x = (left if left is not None else cx - w // 2) - box[0]
    y = top - box[1]
    if shadow:
        draw.text((x + off, y + off), text, font=f, fill=shadow)
    draw.text((x, y), text, font=f, fill=fill)
    return box[3] - box[1]


def cover(img, w, h, focus=(0.5, 0.5)):
    """Scale to cover w x h, then crop around the focus point (fractions)."""
    s = max(w / img.width, h / img.height)
    big = img.resize((max(w, round(img.width * s)), max(h, round(img.height * s))), Image.LANCZOS)
    x = min(max(0, round(big.width * focus[0] - w / 2)), big.width - w)
    y = min(max(0, round(big.height * focus[1] - h / 2)), big.height - h)
    return big.crop((x, y, x + w, y + h))


def sidebar():
    W, H = 164 * SS, 314 * SS
    img = Image.new("RGB", (W, H), INK)
    d = ImageDraw.Draw(img)
    # a slash behind the lower half
    d.polygon([(W * 0.55, 0), (W, 0), (W, H * 0.35), (W * 0.20, H), (0, H), (0, H * 0.75)], fill=SLASH)
    # the picture: a frame from an ultimate, bottom edge cut on a slant, an orange line along the cut
    pic_h = 128 * SS
    shot = Image.open(os.path.join(ROOT, "docs", "videos", "vix_ultimate.jpg")).convert("RGB")
    shot = shot.crop((0, 96, shot.width, shot.height - 96))   # the cut-scene's letterbox bars
    pic = cover(shot, W, pic_h, focus=(0.46, 0.55))
    mask = Image.new("L", (W, pic_h), 0)
    ImageDraw.Draw(mask).polygon([(0, 0), (W, 0), (W, pic_h - 26 * SS), (0, pic_h)], fill=255)
    img.paste(pic, (0, 0), mask)
    d = ImageDraw.Draw(img)
    d.line([(0, pic_h + 2 * SS), (W, pic_h - 24 * SS)], fill=ORANGE, width=4 * SS)
    # wordmark
    pad = 14 * SS
    w = W - 2 * pad
    top = 148 * SS
    h1 = text_at(d, 0, top, "RMT", w - 4 * SS, ORANGE, shadow=GOLD, off=3 * SS, left=pad)
    y = top + h1 + 10 * SS
    h2 = text_at(d, 0, y, "ANIMATION", w, CREAM, left=pad)
    y += h2 + 6 * SS
    text_at(d, 0, y, "STUDIO", int(w * 0.62), GOLD, left=pad)
    text_at(d, 0, H - 24 * SS, "v" + VERSION + "  /  RO MADE THAT", w, (150, 143, 160), weight="Regular", left=pad)
    return img.resize((164, 314), Image.LANCZOS)


def header():
    W, H = 150 * SS, 57 * SS
    img = Image.new("RGB", (W, H), INK)
    d = ImageDraw.Draw(img)
    d.polygon([(W * 0.62, 0), (W, 0), (W, H), (W * 0.46, H)], fill=SLASH)
    d.rectangle((0, H - 3 * SS, W, H), fill=ORANGE)
    tile = Image.open(os.path.join(BUILD, "icon.png")).convert("RGBA").resize((40 * SS, 40 * SS), Image.LANCZOS)
    img.paste(tile, (8 * SS, 6 * SS), tile)
    left = 54 * SS
    h1 = text_at(d, 0, 9 * SS, "RMT", 60 * SS, ORANGE, shadow=GOLD, off=1 * SS, left=left)
    text_at(d, 0, 9 * SS + h1 + 4 * SS, "ANIMATION STUDIO", 88 * SS, CREAM, left=left)
    return img.resize((150, 57), Image.LANCZOS)


def logo():
    W, H = 1400, 400
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, W - 1, H - 1), radius=48, fill=INK)
    d.polygon([(960, 0), (W - 48, 0), (W, 48), (W, H - 48), (W - 48, H), (700, H)], fill=SLASH)
    d.rounded_rectangle((0, 0, W - 1, H - 1), radius=48, outline=ORANGE, width=6)
    tile = Image.open(os.path.join(BUILD, "icon.png")).convert("RGBA").resize((300, 300), Image.LANCZOS)
    img.paste(tile, (50, 50), tile)
    left = 390
    h1 = text_at(d, 0, 52, "RMT", 400, ORANGE, shadow=GOLD, off=8, left=left)
    y = 52 + h1 + 34
    h2 = text_at(d, 0, y, "ANIMATION STUDIO", 840, CREAM, left=left)
    text_at(d, 0, y + h2 + 30, "POSES  /  EFFECTS  /  REVIEW  /  SETUP", 640, (150, 143, 160), weight="Regular", left=left)
    return img


os.makedirs(BUILD, exist_ok=True)
sb = sidebar()
sb.save(os.path.join(BUILD, "installerSidebar.bmp"))
sb.save(os.path.join(BUILD, "uninstallerSidebar.bmp"))
header().save(os.path.join(BUILD, "installerHeader.bmp"))
lg = logo()
lg.save(os.path.join(BUILD, "logo.png"))
os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)
lg.save(os.path.join(ROOT, "docs", "logo.png"))
print("wrote installerSidebar.bmp, uninstallerSidebar.bmp, installerHeader.bmp, logo.png in", BUILD)
