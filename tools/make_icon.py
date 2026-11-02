# Draws build/icon.png and build/icon.ico (the installer / window icon): RMT in orange with a gold offset on a dark tile, a slash behind,
# ANIMATION underneath - the same family as Fight Studio's FS tile. Run: python tools/make_icon.py
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build")
S = 1024
ORANGE, GOLD, INK, SLASH, CREAM = (255, 122, 26), (255, 201, 60), (23, 20, 26), (42, 37, 48), (244, 239, 230)
FONT = "C:/Windows/Fonts/bahnschrift.ttf"

def font(size, weight="Bold"):
    f = ImageFont.truetype(FONT, size)
    try:
        f.set_variation_by_name(weight)
    except Exception:
        pass
    return f

def fit(draw, text, weight, width):
    size = 600
    while size > 40:
        f = font(size, weight)
        box = draw.textbbox((0, 0), text, font=f)
        if box[2] - box[0] <= width:
            return f, box
        size -= 6
    return font(40, weight), draw.textbbox((0, 0), text, font=font(40, weight))

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((32, 32, S - 32, S - 32), radius=230, fill=ORANGE)
d.rounded_rectangle((58, 58, S - 58, S - 58), radius=205, fill=INK)
# the slash, clipped to the tile
slash = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(slash).polygon([(620, 200), (890, 200), (430, 830), (160, 830)], fill=SLASH)
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((58, 58, S - 58, S - 58), radius=205, fill=255)
img.paste(slash, (0, 0), Image.composite(slash.split()[3], Image.new("L", (S, S), 0), mask))
d = ImageDraw.Draw(img)
f, box = fit(d, "RMT", "Bold", 740)
w, h = box[2] - box[0], box[3] - box[1]
x, y = (S - w) // 2 - box[0], 300 - box[1]
d.text((x + 16, y + 16), "RMT", font=f, fill=GOLD)
d.text((x, y), "RMT", font=f, fill=ORANGE)
f2, box2 = fit(d, "ANIMATION", "Bold", 620)
w2 = box2[2] - box2[0]
d.text(((S - w2) // 2 - box2[0], 775 - box2[1]), "ANIMATION", font=f2, fill=CREAM)
img.save(os.path.join(OUT, "icon.png"))
img.save(os.path.join(OUT, "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", os.path.normpath(OUT))
