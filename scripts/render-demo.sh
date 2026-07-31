#!/bin/sh

# Renders the product demo into demo-out/, which is not committed.
#
# Three artifacts come out of one recording, so the README and the homepage can
# never drift apart:
#
#   1667-demo.mp4         the full 29.5s recording, re-encoded for the web
#   1667-demo-poster.png  the frame the homepage shows before playback
#   demo.gif              the README hero, cut to the first 20 seconds
#
# The homepage consumes the first two through its own scripts/render-demo.sh.
# The GIF is published to 1667.ai under a revision-carrying name, because the
# README embeds an absolute URL: npmjs.com renders that README too and drops
# relative paths, and GitHub's camo proxy caches an overwritten file for far
# too long to update one in place.

set -eu

out_dir="demo-out"
demo_mp4="$out_dir/1667-demo.mp4"
demo_gif="$out_dir/demo.gif"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/1667-demo.XXXXXX")"

trap 'rm -rf "$temp_dir"' EXIT

mkdir -p "$out_dir"
vhs scripts/demo.tape

ffmpeg -v error -i "$demo_mp4" \
  -c:v libx264 -preset slow -crf 24 \
  -pix_fmt yuv420p -movflags +faststart \
  "$temp_dir/1667-demo.mp4"
mv "$temp_dir/1667-demo.mp4" "$demo_mp4"

# 20 seconds reaches the path map, which is the beat that separates 1667 from a
# chat box. The remaining nine seconds are the keyboard reference, which the
# README already gives in text, and they cost about a third of the file.
#
# 800px wide at 10fps keeps Berkeley Mono legible while the file stays around
# 2 MB. GitHub renders README images at roughly 890px, so a wider source buys
# display sharpness the reader never sees.
ffmpeg -v error -y -t 20 -i "$demo_mp4" \
  -vf "fps=10,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
  "$demo_gif"

printf '\n%s\n' "wrote:"
ls -lh "$out_dir"
printf '\n%s\n' "To publish the GIF, copy it into the homepage as the next revision:"
printf '%s\n' "  cp $demo_gif ../1667-homepage/public/demo-<n>.gif"
printf '%s\n' "then update the README link and the homepage _headers rule."
