#!/bin/sh
# Real check of the Linux driver: Xvfb + openbox + AT-SPI + a GTK form, in Docker. From the repo root:
#   docker build -t hangar-computer-linuxtest tests/computer/linux
#   docker run --rm -v "$PWD:/repo" -v "$PWD/test-results/linux:/out" hangar-computer-linuxtest sh /repo/tests/computer/linux/run.sh
# It prints a JSON summary (window, capture, elements, the typed invoice) and saves /out/capture.png.
# X server + window manager + accessibility bus + the test app, then the driver test.
set -e
export DISPLAY=:99 XDG_SESSION_TYPE=x11
Xvfb :99 -screen 0 1600x900x24 >/tmp/xvfb.log 2>&1 &
sleep 1
eval "$(dbus-launch --sh-syntax)"
export NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge
/usr/libexec/at-spi-bus-launcher --launch-immediately >/tmp/atspi.log 2>&1 &
openbox >/tmp/openbox.log 2>&1 &
sleep 1
python3 /repo/tests/computer/linux/app.py /out/lancamentos.log >/tmp/app.log 2>&1 &
sleep 2
node --experimental-transform-types --no-warnings /repo/tests/computer/linux/test.mjs
