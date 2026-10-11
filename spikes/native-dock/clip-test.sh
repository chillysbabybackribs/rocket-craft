#!/bin/bash
# Copy and paste both ways between a docked GridCraft and Electron's chat textarea,
# through the X CLIPBOARD selection. Needs the spike running with grid shown.
set -u
cd "$(dirname "$0")"
read OX OY < <(node ctl.mjs state | python3 -c "import json,sys; d=json.load(sys.stdin); s=d['stageOnRoot']; print(s['rx']-d['stage']['x'], s['ry']-d['stage']['y'])")
at() { echo $(( $1 + OX )) $(( $2 + OY )); }
active() { node ctl.mjs mcp '{"app":"grid","tool":"inspect_workbook"}' >/dev/null; python3 -c "import json; print(json.load(open('run/last-mcp-grid.txt'))['activeCell'])"; }
cell() { node ctl.mjs mcp "{\"app\":\"grid\",\"tool\":\"read_range\",\"args\":{\"range\":\"$1\"}}" >/dev/null; python3 -c "import json; print(json.load(open('run/last-mcp-grid.txt'))['values'][0][0])"; }
# app -> chat
xdotool mousemove $(at 587 287) click 1; sleep 0.3; A=$(active)
node ctl.mjs mcp "{\"app\":\"grid\",\"tool\":\"write_range\",\"args\":{\"range\":\"$A\",\"values\":[[\"copied-from-app\"]]}}" >/dev/null
xdotool key ctrl+c; sleep 0.4; CLIP1=$(xclip -o -selection clipboard 2>/dev/null)
node ctl.mjs eval '{"js":"document.getElementById(\"chatInput\").value=\"\"; 1"}' >/dev/null
xdotool mousemove $(at 190 120) click 1; sleep 0.3; xdotool key ctrl+v; sleep 0.4
CHAT=$(node ctl.mjs eval '{"js":"JSON.stringify(document.getElementById(\"chatInput\").value)"}')
# chat -> app
node ctl.mjs eval '{"js":"document.getElementById(\"chatInput\").value=\"pasted-into-app\"; 1"}' >/dev/null
xdotool key ctrl+a ctrl+c; sleep 0.4; CLIP2=$(xclip -o -selection clipboard 2>/dev/null)
xdotool mousemove $(at 638 287) click 1; sleep 0.3; B=$(active); xdotool key ctrl+v; sleep 0.6; xdotool key Return; sleep 0.3
echo "$1: app $A copy -> clipboard='$CLIP1' -> chat paste=$CHAT | chat copy -> clipboard='$CLIP2' -> app $B='$(cell $B)'"
