# The recording of the real product used by 1667's README and by the homepage.
#
# Run it with `scripts/render-demo.sh`, which creates demo-out/ first and then
# derives the README GIF from the MP4 this writes. Running `vhs` on this file
# directly works only if demo-out/ already exists.
#
# The flow is deliberate and `test/demo-tape.test.ts` holds it: compose a
# direction, let the model stream a real part, compare two sibling takes, open
# the path map, then show the complete keyboard reference. It drives the actual
# TUI through its deterministic, network-free demo fixture, so nothing here is
# staged.
#
# The pacing is load-bearing. The homepage seeks to chapter timestamps measured
# against this recording, and its `test/demo-video.test.mjs` samples pixels at
# those timestamps. Changing a Sleep moves those boundaries and fails that test.
Output demo-out/1667-demo.mp4

Require bun
Require ffmpeg

Set Shell "zsh"
Set FontFamily "Berkeley Mono"
Set FontSize 16
Set LetterSpacing 0
Set Width 1280
Set Height 720
Set Padding 0
Set Framerate 24
Set TypingSpeed 32ms
Set CursorBlink false
Set WaitTimeout 15s

Hide
Type "cd tui && exec bun start -- --demo"
Enter
Wait+Screen /the lantern keeper/
Show

Sleep 1.8s
Screenshot demo-out/1667-demo-poster.png

# Compose a direction and let the real demo stream produce the next part.
Enter
Sleep 900ms
Type "let the unlit lantern answer"
Sleep 600ms
Enter
Wait+Screen /lantern flame bent/
Sleep 3.8s

# Return to the five-take passage, then compare two real sibling takes.
Up
Sleep 700ms
Up
Sleep 1.2s
Left
Sleep 2s
Right
Sleep 2s

# Explore the path map, including its rows and sibling takes.
Type "m"
Sleep 2.2s
Up
Sleep 1.1s
Up
Sleep 1.1s
Down
Sleep 1.1s
Left
Sleep 1.1s
Right
Sleep 2.2s
Escape
Sleep 900ms

# End on the complete keyboard reference, then return to the story for looping.
Type "?"
Sleep 2.2s
PageDown
Sleep 1.8s
Escape
Sleep 1.6s
