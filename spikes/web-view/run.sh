#!/usr/bin/env bash
# Run one scenario on a display. Usage: ./run.sh <scenario> <label> [display]
# Starts a private Xvfb on :92 when display is :92 and none is running, and stops it afterwards.
set -euo pipefail
cd "$(dirname "$0")"
SCENARIO=$1 LABEL=$2 DISP=${3:-:92}
STARTED=
if [[ $DISP == :92 ]] && ! xdpyinfo -display :92 >/dev/null 2>&1; then
  Xvfb :92 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &
  STARTED=$!
  for _ in $(seq 50); do xdpyinfo -display :92 >/dev/null 2>&1 && break; sleep 0.1; done
fi
trap '[[ -n $STARTED ]] && kill $STARTED 2>/dev/null || true' EXIT
DISPLAY=$DISP SPIKE_SCENARIO=$SCENARIO SPIKE_LABEL=$LABEL systemd-run --user --scope --quiet --unit=craft-webview-spike-$LABEL-$$ \
  timeout ${SPIKE_TIMEOUT:-600} ./node_modules/.bin/electron . 2>&1 \
  | grep -v -E 'dbus|Fontconfig|libva|viz_main_impl|gles2_cmd|ui/gl/|Gtk-' || true
