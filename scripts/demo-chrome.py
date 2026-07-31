"""Draws the window frame that the README GIF is composited into.

The hero is the outermost frame a reader sees: it says "this is a program you
run", so it wears window chrome. The panels further down the homepage are views
inside the program and wear the site's own bar instead. Those are different
jobs, and they get different frames on purpose.

Measured off the screenshot this replaced, so the frame is the one that was
there before rather than an approximation of it. Nothing is rounded: the
original had square corners inside and out.

Run it through scripts/render-demo.sh rather than directly.

    python3 scripts/demo-chrome.py <out.png>

It prints the offset the video is composited at, which render-demo.sh reads.
"""

import sys

from PIL import Image, ImageDraw

FRAME = (23, 23, 23)  # #171717
TUI = (19, 15, 10)  # behind the video, matching the capture's own background
LIGHTS = ((255, 79, 77), (255, 186, 0), (0, 204, 28))

VIDEO = (1280, 720)
INSET = (18, 58)  # where the capture sits: 18 left, 58 down past the bar
MARGIN = 18  # right and bottom
LIGHT_R = 6
LIGHT_Y = 19.5
LIGHT_X = (19.5, 37.5, 55.5)

# ImageDraw does not anti-alias. The circles are the only curves here, so the
# frame is drawn large and reduced, which costs one resize and looks right.
SUPERSAMPLE = 4


def main(out_path: str) -> None:
    width = VIDEO[0] + INSET[0] + MARGIN
    height = VIDEO[1] + INSET[1] + MARGIN

    scale = SUPERSAMPLE
    image = Image.new("RGB", (width * scale, height * scale), FRAME)
    draw = ImageDraw.Draw(image)

    draw.rectangle(
        [
            INSET[0] * scale,
            INSET[1] * scale,
            (INSET[0] + VIDEO[0]) * scale - 1,
            (INSET[1] + VIDEO[1]) * scale - 1,
        ],
        fill=TUI,
    )

    for centre_x, colour in zip(LIGHT_X, LIGHTS):
        draw.ellipse(
            [
                (centre_x - LIGHT_R) * scale,
                (LIGHT_Y - LIGHT_R) * scale,
                (centre_x + LIGHT_R) * scale,
                (LIGHT_Y + LIGHT_R) * scale,
            ],
            fill=colour,
        )

    image.resize((width, height), Image.LANCZOS).save(out_path)
    print(f"{INSET[0]} {INSET[1]}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: demo-chrome.py <out.png>")
    main(sys.argv[1])
