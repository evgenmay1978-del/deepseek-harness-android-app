#!/usr/bin/env bash
# Собирает devhome для build.sh из APK upstream: assets/payload.zip -> runtime/dshroot/bin/dshhome
set -euo pipefail
APK="$1"; DH="${2:-devhome}"; NEW_ID="${3:-com.deepseek.harness.plus}"
rm -rf "$DH"; mkdir -p "$DH" "$DH/build" "$DH/rish"
TMP="$(mktemp -d)"
unzip -q -o "$APK" 'assets/payload.zip' -d "$TMP"
unzip -q -o "$TMP/assets/payload.zip" -d "$DH"
# Если payload распаковался вложенно (одним корнем) — поднять содержимое наверх:
# build.sh ждёт $H/git/bin/git, $H/dshroot, $H/.dsh — при вложенности он падает на cp.
if [ ! -d "$DH/git" ] && [ ! -d "$DH/dshhome" ] && [ ! -d "$DH/dshroot" ]; then
  for cand in "$DH"/*/; do
    if [ -d "${cand}dshhome" ] || [ -d "${cand}dshroot" ] || [ -d "${cand}git" ]; then
      echo "payload вложен в $cand — поднимаю содержимое наверх"
      for x in "$cand"*; do mv "$x" "$DH"/ 2>/dev/null || true; done
      rmdir "$cand" 2>/dev/null || true
      break
    fi
  done
fi
# Диагностика: что реально лежит в devhome (видно в логе CI).
echo "состав devhome: $(ls -1 "$DH" | tr '\n' ' ')"

# build.sh ждёт $H/.dsh/{settings.yaml,profiles/web/*}, в payload это dshhome/
if [ -d "$DH/dshhome" ]; then rm -rf "$DH/.dsh"; mv "$DH/dshhome" "$DH/.dsh"; fi
printf '#!/bin/sh\n# toolchain берётся с раннера\n:\n' > "$DH/build/env.sh"; chmod +x "$DH/build/env.sh"
# в payload не должно быть ключей
[ -e "$DH/.dsh/.credentials.yaml" ] && { echo "!! в payload есть .credentials.yaml"; exit 1; }
if grep -rqE "sk-[A-Za-z0-9]{20,}" "$DH/.dsh" 2>/dev/null; then echo "!! в payload найден API-ключ"; exit 1; fi
# плагины в payload по умолчанию зовут ОРИГИНАЛЬНЫЙ пакет — переключаем на клон
find "$DH/dshroot" -path '*dsh-tool-*' -name index.js -print0 2>/dev/null | while IFS= read -r -d '' f; do
  sed -i "s/\"com\.deepseek\.harness\"/\"$NEW_ID\"/g" "$f"
done
# Наш плагин: без этого шага APK собирается без памяти, скиллов и диспетчера.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node "$REPO_ROOT/ci/install-agent-kit.mjs" "$DH" "$REPO_ROOT"
echo "devhome готов: $(ls -1 "$DH" | tr '\n' ' ')"
