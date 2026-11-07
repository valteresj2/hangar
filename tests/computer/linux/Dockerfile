FROM node:24-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb openbox xdotool x11-utils imagemagick xprintidle \
      python3 python3-gi gir1.2-gtk-3.0 gir1.2-atspi-2.0 at-spi2-core dbus dbus-x11 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /t
