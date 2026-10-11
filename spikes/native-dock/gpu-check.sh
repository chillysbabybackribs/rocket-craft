#!/bin/bash
# Real-GPU check on the user's display: launch one app for at most 20 s (timeout
# enforces it), read its GPU memory from nvidia-smi, then close it. Scratch config
# dirs so the user's own app settings are not touched.
# Usage: DISPLAY=:1 gpu-check.sh photo|grid
set -u
cd "$(dirname "$0")"
BIN=/tmp/craft-measure.b2Tv/x
case $1 in
  photo) EXE=$BIN/photocraft-0.7.0-linux-x86_64/bin/photocraft; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > run/gpu-photo.token; chmod 600 run/gpu-photo.token; ARGS="--control 47721 --control-token-file $PWD/run/gpu-photo.token" ;;
  grid) EXE=$BIN/gridcraft-0.5.0-linux-x86_64/bin/gridcraft; ARGS="--control 47722" ;;
esac
X=$PWD/run/xdg-gpu
UNIT=nd-gpu-$1-$$
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader > run/gpu-$1-before.txt
T0=$(date +%s%N)
XDG_CONFIG_HOME=$X/config XDG_DATA_HOME=$X/data XDG_CACHE_HOME=$X/cache XDG_STATE_HOME=$X/state \
  systemd-run --user --scope --quiet --unit=$UNIT -- timeout -s TERM 20 $EXE $ARGS > run/gpu-$1.log 2>&1 &
sleep 0.5
APP=$(pgrep -f -n "^$EXE ")
echo "app pid=$APP"
# Wait until it holds GPU memory (or 12 s), then sample a few times.
for i in $(seq 1 24); do
  M=$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits | awk -F', ' -v p=$APP '$1==p{print $2}')
  G=$(nvidia-smi | awk -v p=$APP '$5==p{print $8}')
  [ -n "$M$G" ] && break
  sleep 0.5
done
echo "first seen on GPU after $(( ($(date +%s%N)-T0)/1000000 )) ms"
sleep 4
for s in 1 2 3; do
  echo "sample $s: compute-apps=$(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader | grep "^$APP," ) | process-list=$(nvidia-smi | awk -v p=$APP '$5==p')"
  sleep 1
done
DISPLAY=${DISPLAY} xdotool search --pid $APP 2>/dev/null | head -3 | while read w; do echo "window $w: $(xwininfo -id $w | grep -E 'geometry|Map State' | tr -s ' ' | tr '\n' ' ')"; done
grep -iE 'GPU startup|adapter|rasterizer|backend' run/gpu-$1.log | head -4
kill -TERM $APP 2>/dev/null
for i in $(seq 1 20); do kill -0 $APP 2>/dev/null || break; sleep 0.25; done
kill -0 $APP 2>/dev/null && kill -KILL $APP
echo "closed after $(( ($(date +%s%N)-T0)/1000000 )) ms total; scope: $(systemctl --user is-active $UNIT.scope 2>&1)"
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader > run/gpu-$1-after.txt
echo "GPU total used before: $(cat run/gpu-$1-before.txt) after close: $(cat run/gpu-$1-after.txt)"
