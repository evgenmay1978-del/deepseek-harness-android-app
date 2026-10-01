#!/bin/sh
# Барьер раскладки: тесты → хеш ВСЕГО дерева → копирование → сверка в целевых каталогах.
# Журналы живут в plugin-logs/ ВНЕ agent-memory: тот каталог агент может писать и он попадает в индекс памяти.
set -u
cd "$(dirname "$0")" || exit 1
FILES=/data/data/com.deepseek.harness/files
LOGDIR="$FILES/plugin-logs"
mkdir -p "$LOGDIR"
BUG=""; [ $# -ge 1 ] && BUG="$1"
LOG="$LOGDIR/deploy-tests.log"
BAK="$LOGDIR/t.bak"
if [ "$BUG" = "--selftest" ]; then cp tests/blob-store.test.mjs "$BAK"; printf '\ntest("сломанный",()=>{throw new Error("x")});\n' >> tests/blob-store.test.mjs; fi
if ! timeout 300 node --test tests/*.test.mjs > "$LOG" 2>&1; then
  echo "  КРАСНЫЙ — раскладка отменена, хеш не записан"; tail -3 "$LOG"
  [ "$BUG" = "--selftest" ] && cp "$BAK" tests/blob-store.test.mjs
  exit 1
fi
[ "$BUG" = "--selftest" ] && cp "$BAK" tests/blob-store.test.mjs
grep -E '^ℹ (tests|pass|fail)' "$LOG"
TREE=$(cat index.js lib/*.js | sha256sum | cut -c1-12)
echo "дерево плагина: $TREE"
for P in web headless; do
  D="$FILES/payload/dshhome/profiles/$P/node_modules/dsh-tool-agent-kit"
  cp index.js "$D/" && cp lib/*.js "$D/lib/" || exit 1
  T=$(cat "$D/index.js" "$D"/lib/*.js | sha256sum | cut -c1-12)
  [ "$T" = "$TREE" ] || { echo "  РАСХОЖДЕНИЕ в $P"; exit 1; }
  echo "  $P: $T OK"
done
printf '%s тесты: %s | дерево: %s\n' "$(date -u +%FT%TZ)" "$(grep -E '^ℹ pass' "$LOG")" "$TREE" >> "$LOGDIR/deploy-log.txt"
tail -1 "$LOGDIR/deploy-log.txt"