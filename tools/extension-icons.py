# Draws the extension's icons: a black square with a white "s", like the site.
#   python3 tools/extension-icons.py
from PIL import Image, ImageDraw, ImageFont

FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
for size in (16, 32, 48, 128):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # The store wants 128px icons drawn in the middle 96px.
    pad = 16 if size == 128 else 0
    d.rectangle([pad, pad, size - pad - 1, size - pad - 1], fill=(0, 0, 0, 255))
    inner = size - 2 * pad
    font = ImageFont.truetype(FONT, int(inner * 0.78))
    box = d.textbbox((0, 0), "s", font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1]), "s", font=font, fill=(255, 255, 255, 255))
    img.save(f"extension/icons/{size}.png")
print("icons written")
