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
# Статический барьер (no-undef + no-use-before-define): ловит замыкания на блочные переменные,
# которые 123 зелёных теста пропустили (тихий ReferenceError 04.10.2026).
# Конфиг и версия зафиксированы в репозитории (eslint.config.mjs + devDependencies).
# Нет eslint → деплой ПАДАЕТ, а не пропускает проверку.
if [ ! -x "./node_modules/.bin/eslint" ]; then
  echo "  КРАСНЫЙ: eslint не установлен — выполните 'npm install' в plugins/dsh-tool-agent-kit"; exit 1
fi
if ! ./node_modules/.bin/eslint --config eslint.config.mjs --format stylish . > "$LOGDIR/eslint.log" 2>&1; then
  echo "  КРАСНЫЙ (eslint) — раскладка отменена, хеш не записан"; tail -20 "$LOGDIR/eslint.log"; exit 1
fi
echo "  eslint (no-undef, no-use-before-define): чисто"
if [ "$BUG" = "--selftest" ]; then cp tests/blob-store.test.mjs "$BAK"; printf '\ntest("сломанный",()=>{throw new Error("x")});\n' >> tests/blob-store.test.mjs; fi
# Флаг vm нужен сквозному тесту сборки (vm.SourceTextModule); без него он не запустится вовсе.
if ! NODE_OPTIONS="--experimental-vm-modules" timeout 300 node --test tests/*.test.mjs > "$LOG" 2>&1; then
  echo "  КРАСНЫЙ — раскладка отменена, хеш не записан"; tail -3 "$LOG"
  [ "$BUG" = "--selftest" ] && cp "$BAK" tests/blob-store.test.mjs
  exit 1
fi
[ "$BUG" = "--selftest" ] && cp "$BAK" tests/blob-store.test.mjs
grep -E '^ℹ (tests|pass|fail)' "$LOG"
TREE=$(cat index.js lib/*.js | sha256sum | cut -c1-12)
echo "дерево плагина: $TREE"
for P in web headless; do
  [ -d "$FILES/payload/dshhome/profiles/$P" ] || { echo "  $P: профиля нет — пропуск"; continue; }
  D="$FILES/payload/dshhome/profiles/$P/node_modules/dsh-tool-agent-kit"
  cp index.js "$D/" && cp lib/*.js "$D/lib/" || exit 1
  T=$(cat "$D/index.js" "$D"/lib/*.js | sha256sum | cut -c1-12)
  [ "$T" = "$TREE" ] || { echo "  РАСХОЖДЕНИЕ в $P"; exit 1; }
  echo "  $P: $T OK"
done
printf '%s тесты: %s | дерево: %s\n' "$(date -u +%FT%TZ)" "$(grep -E '^ℹ pass' "$LOG")" "$TREE" >> "$LOGDIR/deploy-log.txt"
tail -1 "$LOGDIR/deploy-log.txt"