#!/bin/sh
set -eu

until curl -fsS http://127.0.0.1:3000/health >/dev/null; do
  sleep 1
done

if [ "${POC_MODE:-fixture}" = "live" ]; then
  START_URL="https://www.facebook.com/"
else
  START_URL="http://127.0.0.1:3000/fixture/login"
fi

# The browser profile lives in a named volume so login cookies survive container
# replacement. Chromium's singleton files contain the previous container's host
# identity, though, and are stale once this supervised process is starting.
rm -f \
  /data/chromium/SingletonLock \
  /data/chromium/SingletonCookie \
  /data/chromium/SingletonSocket

exec /usr/bin/chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-background-networking \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir=/data/chromium \
  --window-size=1365,768 \
  "$START_URL"

