#!/bin/bash
# Keyboard focus between the chat and a docked GridCraft, with the pointer moved away
# after each click so "keys follow the pointer" cannot pass the test by accident, plus
# a mouse-wheel scroll over the app while the chat keeps the keyboard. Each typed
# cell is the one the click actually selected (read back from the app).
# Needs the spike running with grid shown. Usage: focus-test.sh <label> [delay-ms]
set -u
cd "$(dirname "$0")"
DELAY=${2:-150}
read OX OY < <(node ctl.mjs state | python3 -c "import json,sys; d=json.load(sys.stdin); s=d['stageOnRoot']; print(s['rx']-d['stage']['x'], s['ry']-d['stage']['y'])")
at() { echo $(( $1 + OX )) $(( $2 + OY )); }
active() { node ctl.mjs mcp '{"app":"grid","tool":"inspect_workbook"}' >/dev/null; python3 -c "import json; print(json.load(open('run/last-mcp-grid.txt'))['activeCell'])"; }
cell() { node ctl.mjs mcp "{\"app\":\"grid\",\"tool\":\"read_range\",\"args\":{\"range\":\"$1\"}}" >/dev/null; python3 -c "import json; print(json.load(open('run/last-mcp-grid.txt'))['values'][0][0])"; }
node ctl.mjs eval '{"js":"document.getElementById(\"chatInput\").value=\"\"; 1"}' >/dev/null
# 0. start in the chat
xdotool mousemove $(at 190 120) click 1; sleep 0.3
# 1. click a cell in the app, move the pointer over the chat, type
xdotool mousemove $(at 740 351) click 1; sleep 0.3; C1=$(active)
xdotool mousemove $(at 190 400); sleep 0.2; F1=$(xdotool getwindowfocus -f)
xdotool type --delay $DELAY 'to-app'; xdotool key Return; sleep 0.4
# 2. click the chat textarea, move the pointer over the app, type
xdotool mousemove $(at 190 120) click 1; sleep 0.3
xdotool mousemove $(at 800 500); sleep 0.2; F2=$(xdotool getwindowfocus -f)
xdotool type --delay 80 'to-chat'; sleep 0.4
# 3. back into the app: click another cell, pointer away, type
xdotool mousemove $(at 740 415) click 1; sleep 0.3; C3=$(active); xdotool mousemove $(at 190 400); sleep 0.2
xdotool type --delay $DELAY 'again'; xdotool key Return; sleep 0.4
# 4. chat again, then the wheel over the app while the chat keeps the keyboard
xdotool mousemove $(at 190 120) click 1; sleep 0.3; xdotool mousemove $(at 800 500); sleep 0.2
S0=$(python3 -I gridui.py 47712 scroll); xdotool click --repeat 5 --delay 60 5; sleep 0.5; S1=$(python3 -I gridui.py 47712 scroll)
xdotool type --delay 80 '+wheel'; sleep 0.3
xdotool click --repeat 5 --delay 60 4; sleep 0.3
CHAT=$(node ctl.mjs eval '{"js":"document.getElementById(\"chatInput\").value"}')
echo "$1 (delay ${DELAY} ms): focus after app click=$F1 after chat click=$F2 | $C1='$(cell $C1)' (typed to-app) $C3='$(cell $C3)' (typed again) | chat=$CHAT (typed to-chat, +wheel) | scroll $S0 -> $S1"
import -window root "shots/focus-$1.png"
