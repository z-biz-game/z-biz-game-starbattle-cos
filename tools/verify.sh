#!/usr/bin/env bash
# One-shot browser verification: real Chrome, real DOM, scripted scenarios.
#
#   npm run verify                 # default scenario set: boot gen play hint win
#   SCENARIOS="play hint" npm run verify
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-starbattle-cos/ npm run verify
#   SHOTS=1 npm run verify          # also writes tools/shots/*.png
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates every core and, with no CDP client attached, Chrome will not exit
# on its own.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
# 5314 is this game's port in the org's table and 9364 the DevTools in front of it. Sibling repos
# (tapa 5312/9362, skyscraper 5313/9363, kenken 5315/9365, nurikabe 5311/9361) run their own
# verify.sh on this machine at the same minute, so the pair is hard-coded: nothing here may be
# pointed at another repo's server by accident.
HTTP=${HTTP_PORT:-5314}
PORT=${CDP_PORT:-9364}
BASE=${BASE_URL:-http://127.0.0.1:$HTTP/}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

LOCAL=0
case "$BASE" in "http://127.0.0.1:$HTTP/"*) LOCAL=1 ;; esac
# Refuse to run on top of ports somebody else already owns. An orphan server from a sibling repo's
# verify.sh would answer the pre-flight curl with its own index.html, and every scenario below would
# then be asserting against a different game.
if command -v lsof >/dev/null 2>&1; then
  for p in $([ "$LOCAL" = 1 ] && echo "$HTTP") "$PORT"; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
      echo "port $p is already being listened on:" >&2
      lsof -nP -iTCP:"$p" -sTCP:LISTEN >&2 | tail -3
      echo "kill the orphan (or set HTTP_PORT/CDP_PORT) — this harness only trusts servers it starts itself" >&2
      exit 2
    fi
  done
fi
SPID=0
if [ "$LOCAL" = 1 ]; then
  node "$HERE/server.cjs" "$HTTP" >/tmp/starbattle-server.log 2>&1 &
  SPID=$!
  for i in $(seq 1 40); do
    curl -fsS -m 1 "http://127.0.0.1:$HTTP/" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi
# Pre-flight: prove the bytes we are about to assert on are this app's index.html and not some
# long-lived server from another repo that happens to own the port.
SERVED=$(curl -fsS -m 3 "$BASE" 2>/dev/null || true)
case "$SERVED" in *js/main.js*) ;; *) echo "nothing served at $BASE (see /tmp/starbattle-server.log)" >&2; exit 2 ;; esac
echo "$SERVED" | grep -qi '双星' || { echo "port $HTTP is serving a different app, not 双星/starbattle" >&2; exit 2; }
echo "$SERVED" | grep -qi 'star battle' || { echo "port $HTTP serves 双星 but not Star Battle — wrong index.html" >&2; exit 2; }
echo "pre-flight: $BASE serves 双星 · Star Battle"

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$PORT --user-data-dir=$UDD \
  --window-size=900,900 --no-first-run --no-default-browser-check about:blank >/tmp/starbattle-chrome.log 2>&1 &
CPID=$!
cleanup() {
  [ "$SPID" != 0 ] && kill $SPID 2>/dev/null
  kill -9 $CPID 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT
# The watchdog redirects its fds: a background subshell inherits this script's stdout, and inside a
# pipeline it would hold the write end open long after the tests finished.
# 900 s, not tapa's 420: a master-tier draw is a seeded retry loop that re-runs the pencil path after
# every boundary transfer (measured p50 1568 ms / max 4369 ms on this machine), and the gen scenario
# also hands each shipped board to the exhaustive counter.
( sleep ${WD_TIMEOUT:-900}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools later than a warm profile: wait on the endpoint, not on a
# fixed sleep.
for i in $(seq 1 120); do
  curl -fsS -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$PORT (see /tmp/starbattle-chrome.log)" >&2; exit 3; }

export CDP_PORT=$PORT
export BASE_URL=$BASE
cd "$HERE"
node tools/playtest.cjs open "$BASE" | head -5

BOOT=""
for i in $(seq 1 60); do
  BOOT=$(node tools/playtest.cjs eval "window.starbattle?window.starbattle.version:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot: starbattle $BOOT at $BASE"
[ "$BOOT" = "nope" ] && { echo "window.starbattle never appeared at $BASE" >&2; exit 4; }

FAILED=0
for s in ${SCENARIOS:-boot gen play hint win}; do
  echo "=== $s ==="
  node tools/playtest.cjs scenario "$s" 2>/tmp/starbattle-$s.console.log | tail -1 | sed 's/^RESULT //' | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    print('  NO RESULT (see /tmp/starbattle-$s.console.log)'); sys.exit(1)
try:
    d = json.loads(raw)
except Exception:
    print('  UNPARSED:', raw[:300]); sys.exit(1)
for r in d['rows']:
    if not r['pass']: print('  FAIL %-46s %s' % (r['test'], r['detail']))
extra = {k: v for k, v in d.items() if k not in ('rows', 'fail')}
if not d['rows']:
    print('  NO CHECKS RUN — a scenario that asserts nothing cannot be green'); sys.exit(1)
print('  %d checks, %d failed  %s' % (len(d['rows']), d['fail'], extra if extra else ''))
sys.exit(1 if d['fail'] else 0)
" || FAILED=1
  if [ -s /tmp/starbattle-$s.console.log ]; then
    echo "  --- console ---"
    sed 's/^/  /' /tmp/starbattle-$s.console.log | tail -12
  fi
done

if [ -n "${SHOTS:-}" ]; then
  mkdir -p tools/shots
  for shot in menu board win; do
    case $shot in
      menu) node tools/playtest.cjs eval "window.starbattle.show('menu');'ok'" nonav >/dev/null 2>&1 ;;
      board) node tools/playtest.cjs eval "window.starbattle.begin('regular',{seed:'shot-board'});'ok'" nonav >/dev/null 2>&1
             for i in $(seq 1 60); do node tools/playtest.cjs eval "window.starbattle.puzzle&&window.starbattle.puzzle.originSeed==='shot-board'?'ready':'wait'" nonav | grep -q ready && break; sleep 0.5; done ;;
      win) node tools/playtest.cjs eval "window.starbattle.begin('apprentice',{seed:'shot-win'});'ok'" nonav >/dev/null 2>&1
             for i in $(seq 1 60); do node tools/playtest.cjs eval "window.starbattle.puzzle&&window.starbattle.puzzle.originSeed==='shot-win'?'ready':'wait'" nonav | grep -q ready && break; sleep 0.5; done
             node tools/playtest.cjs eval "window.starbattle.solveWithLogic();'ok'" nonav >/dev/null 2>&1 ;;
    esac
    sleep 1.4
    node tools/playtest.cjs shot tools/shots/$shot-$SHOTS.png >/dev/null
  done
  echo "shots: $(ls tools/shots/*-$SHOTS.png | tr '\n' ' ')"
fi

kill $WD 2>/dev/null
# 部署集闸：ci.yml 跑这两步、本地整闸以前一次都不跑。缺这一步就是「本地全绿、线上 404 自己的
# manifest / sw.js / 图标」这一整类坏法。它不碰 Chrome，也不读页面，纯查产物。
echo "=== deploy-set ==="
node tools/deploy-set.mjs || FAILED=1
node tools/deploy-set-selftest.mjs || FAILED=1
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
