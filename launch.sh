#!/bin/zsh
cd ~/Desktop/CODE\ 2026/emotion-mosaic
/usr/local/bin/npm run dev &
until curl -s http://localhost:5186 > /dev/null 2>&1; do sleep 0.5; done
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-ipc-flooding-protection \
  --js-flags=--max-old-space-size=8192 \
  http://localhost:5186
wait
