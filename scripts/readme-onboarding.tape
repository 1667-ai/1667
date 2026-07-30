# Run this tape from the repository root.
# It captures the real starter onboarding story in a new, isolated project.

Require bun
Require trash

Set Shell "zsh"
Set FontFamily "Berkeley Mono"
Set FontSize 16
Set LetterSpacing 0
Set LineHeight 1.15
Set Width 1280
Set Height 720
Set Padding 18
Set MarginFill "#0B0906"
Set Margin 64
Set BorderRadius 14
Set WindowBar "Colorful"
Set WindowBarSize 40
Set CursorBlink false
Set WaitTimeout 15s

Hide
Type "readme_capture_root=$(mktemp -d /tmp/1667-readme.XXXXXX)"
Enter
Type "cd tui && AI_1667_STATE=$readme_capture_root/state XDG_CONFIG_HOME=$readme_capture_root/config bun start -- --data $readme_capture_root/project"
Enter
Wait+Screen /Welcome to 1667/
Show

Sleep 1s
Screenshot docs/assets/starter-onboarding.png

Type "q"
Hide
Sleep 1s
Type "trash $readme_capture_root"
Enter
