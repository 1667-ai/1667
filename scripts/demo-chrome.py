"""Draws the terminal chrome that the README GIF is composited into.

The homepage frames every terminal panel with the same bar: three dots, a
title, a status, over a hairline border. It does that in CSS. A GIF in a
Markdown file has no CSS, so the bar has to be pixels, and this draws them.

Run it through scripts/render-demo.sh rather than directly.

    python3 scripts/demo-chrome.py <font.ttf> <out.png>

It prints the offset the video is composited at, which render-demo.sh reads.
"""

import sys

from PIL import Image, ImageDraw, ImageFont

# From the homepage's src/styles/tokens.css. Keep these in step with
# .terminal-video__bar over there; the two frames are compared side by side by
# anyone who follows the README link to the site.
LINE_LIT = "#2a2015"  # --line-lit, the outer border
BAR = "#120e09"  # the title bar fill
LINE = "#241c11"  # --line, the hairline under the bar
TUI = "#14100b"  # --tui-background, behind the video
DOT = "#3a2e1e"  # --line-hot
TITLE = "#7e6f58"  # --text-dim
STATUS = "#c8933f"  # --amber

# The homepage bar is measured in CSS pixels at display size. GitHub renders a
# README image at about 800px wide and the capture is 1280 wide, so every CSS
# value is scaled by 1280/800 here and lands back on the homepage's proportions
# once render-demo.sh scales the composite down.
SCALE = 1.6
VIDEO = (1280, 720)
BORDER = round(1 * SCALE)
BAR_HEIGHT = round(32 * SCALE)
DOT_SIZE = round(7 * SCALE)
DOT_GAP = round(5 * SCALE)
PAD_X = round(14 * SCALE)
TEXT_GAP = round(12 * SCALE)
FONT_SIZE = round(10.5 * SCALE)

TITLE_TEXT = "1667 · demo"
STATUS_TEXT = "the lantern keeper"


def main(font_path: str, out_path: str) -> None:
    font = ImageFont.truetype(font_path, FONT_SIZE)

    width = VIDEO[0] + BORDER * 2
    height = VIDEO[1] + BAR_HEIGHT + BORDER * 2
    image = Image.new("RGB", (width, height), LINE_LIT)
    draw = ImageDraw.Draw(image)

    right = width - BORDER - 1
    bar_bottom = BORDER + BAR_HEIGHT
    draw.rectangle([BORDER, BORDER, right, bar_bottom - 2], fill=BAR)
    draw.rectangle([BORDER, bar_bottom - 1, right, bar_bottom - 1], fill=LINE)
    draw.rectangle([BORDER, bar_bottom, right, height - BORDER - 1], fill=TUI)

    centre = BORDER + BAR_HEIGHT / 2
    x = BORDER + PAD_X
    for _ in range(3):
        draw.ellipse(
            [x, centre - DOT_SIZE / 2, x + DOT_SIZE - 1, centre + DOT_SIZE / 2 - 1],
            fill=DOT,
        )
        x += DOT_SIZE + DOT_GAP

    draw.text(
        (x - DOT_GAP + TEXT_GAP, centre),
        TITLE_TEXT,
        font=font,
        fill=TITLE,
        anchor="lm",
    )
    draw.text(
        (right - PAD_X, centre), STATUS_TEXT, font=font, fill=STATUS, anchor="rm"
    )

    image.save(out_path)
    print(f"{BORDER} {bar_bottom}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: demo-chrome.py <font.ttf> <out.png>")
    main(sys.argv[1], sys.argv[2])
