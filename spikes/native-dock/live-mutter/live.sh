#!/bin/bash
# One block on a display: record the pointer (xdotool getmouselocation) and the clipboard
# text, start the spike, run drive.py, quit the spike, check that every process and scope
# is gone, then put the pointer and the clipboard back. Prints the total time the spike
# window existed. Usage: DISPLAY=:1 ./live.sh <label>
set -u
cd "$(dirname "$0")"
L=$1
LOG=run/live-$L.log
: > "$LOG"
say() { echo "$(date +%T.%3N) $*" | tee -a "$LOG"; }
export SPIKE_USERDATA=/tmp/lm-home/electron-ud-$L SPIKE_XDG=/tmp/lm-xdg-$L SPIKE_X=${SPIKE_X:-200} SPIKE_Y=${SPIKE_Y:-80}
mkdir -p /tmp/lm-home "$SPIKE_XDG"

PTR=$(xdotool getmouselocation --shell); say "pointer before: $(echo $PTR | tr '\n' ' ')"
eval "$PTR"; PX=$X; PY=$Y
ACT0=$(xprop -root _NET_ACTIVE_WINDOW | awk '{print $NF}'); say "active window before: $ACT0"
CLIP=/tmp/lm-home/clip-$L; rm -f "$CLIP"; umask 077
TG=$(timeout 3 xclip -o -selection clipboard -t TARGETS 2>/dev/null | tr '\n' ' ')
if echo "$TG" | grep -qw UTF8_STRING; then timeout 3 xclip -o -selection clipboard -t UTF8_STRING > "$CLIP" 2>/dev/null; CT=UTF8_STRING
elif echo "$TG" | grep -qw image/png; then timeout 5 xclip -o -selection clipboard -t image/png > "$CLIP" 2>/dev/null; CT=image/png
else CT=; fi
say "clipboard saved: type=${CT:-none} bytes=$( [ -f "$CLIP" ] && stat -c %s "$CLIP" || echo 0) (content not printed)"

rm -f run/ctl.sock
T0=$(date +%s%3N)
setsid ../node_modules/.bin/electron --no-sandbox . > run/electron-$L.log 2>&1 &
EPID=$!; echo $EPID > run/electron.pid
for i in $(seq 1 60); do [ -S run/ctl.sock ] && break; sleep 0.25; done
sleep 1.5
say "spike up after $(( $(date +%s%3N) - T0 )) ms (pid $EPID)"
timeout 240 python3 -I drive.py "$L" 2>&1 | tee -a "$LOG"
say "drive done after $(( $(date +%s%3N) - T0 )) ms"

node ctl.mjs quit > /dev/null 2>&1
for i in $(seq 1 40); do kill -0 $EPID 2>/dev/null || break; sleep 0.25; done
kill -0 $EPID 2>/dev/null && { say "electron still alive, SIGTERM"; kill -TERM -$EPID; sleep 2; kill -KILL -$EPID 2>/dev/null; }
T1=$(date +%s%3N)
say "LIVE WINDOW TIME: $(( T1 - T0 )) ms (spike start to spike exit)"

# Put the pointer back first, then check that it is back.
xdotool mousemove --screen ${SCREEN:-0} $PX $PY
sleep 0.2
eval "$(xdotool getmouselocation --shell)"; say "pointer after restore: $X,$Y (before $PX,$PY) $([ "$X,$Y" = "$PX,$PY" ] && echo RESTORED || echo MISMATCH)"

# Leftovers: apps, bridges, helpers. Only processes carrying this run's scratch
# environment (inherited from the spike) are ours; anything else is left alone.
mine() { for p in $(pgrep -f "photocraft|gridcraft|xdock.py|electron|xclip"); do
  grep -qz "^SPIKE_USERDATA=$SPIKE_USERDATA$" /proc/$p/environ 2>/dev/null && echo $p; done; }
sleep 1
LEFT=$(mine)
[ -n "$LEFT" ] && { say "leftovers (SIGTERM): $(ps -o pid=,args= -p $(echo $LEFT | tr ' ' ',') | cut -c1-120 | tr '\n' ';')"; kill -TERM $LEFT 2>/dev/null; sleep 2; L2=$(mine); [ -n "$L2" ] && kill -KILL $L2; }
say "our processes after: $(mine | wc -l)"
say "nd-* scopes after: $(systemctl --user list-units 'nd-*' --all --no-legend | wc -l) $(systemctl --user list-units 'nd-*' --all --no-legend | tr '\n' ' ')"

if [ -n "$CT" ] && [ -s "$CLIP" ]; then
  xclip -quiet -i -selection clipboard -t $CT < "$CLIP" > /dev/null 2>&1 &
  XC=$!; sleep 1.5; kill $XC 2>/dev/null; sleep 0.5
  NOW=$(mktemp /tmp/lm-home/clipnow.XXXX); timeout 3 xclip -o -selection clipboard -t $CT > "$NOW" 2>/dev/null
  say "clipboard restore: $(cmp -s "$CLIP" "$NOW" && echo RESTORED || echo DIFFERENT)"
  shred -u "$CLIP" "$NOW" 2>/dev/null
else say "clipboard had nothing to restore"; fi
say "active window after: $(xprop -root _NET_ACTIVE_WINDOW | awk '{print $NF}') (before $ACT0)"
