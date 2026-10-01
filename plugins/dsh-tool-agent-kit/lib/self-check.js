/**
 * self-check — одна строка в лог при старте движка: что реально смонтировано и в каком состоянии.
 *
 * Зачем: провал монтирования плагина не виден (ошибка импорта уходит в <files>/dsh-web.log),
 * а частичное монтирование выглядит как «инструмента просто нет». Здесь мы за один раз проверяем
 * реестр инструментов, число правил роутера скиллов, состояние раннера и гейта, скиллы на диске
 * (с учётом скрытых от модели через disable-model-invocation) и размер памяти.
 *
 * Выключатель: DSH_SELFCHECK=off.
 */
import { readdirSync, statSync, readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { detectFilesDir } from "./paths.js";
import { RULES } from "./skill-router.js";

export const KIT_TOOLS = [
  "android_act", "android_wait_until", "android_find", "agent_memory",
  "android_schedule_list", "android_schedule_cancel"
];

function countSkills(dir, withHidden) {
  const out = { total: 0, hidden: 0 };
  try {
    for (const name of readdirSync(dir)) {
      const f = join(dir, name, "SKILL.md");
      try {
        if (!statSync(join(dir, name)).isDirectory() || !existsSync(f)) continue;
      } catch { continue; }
      out.total++;
      if (withHidden) {
        try { if (/^disable-model-invocation:\s*true/m.test(readFileSync(f, "utf8"))) out.hidden++; } catch { /* не критично */ }
      }
    }
  } catch { /* каталога нет */ }
  return out;
}

export function installSelfCheck(ctx, opts = {}) {
  if (process.env.DSH_SELFCHECK === "off") return undefined;
  const log = opts.log || ((m) => (ctx.logger?.warn ? ctx.logger.warn(m) : console.warn(m)));
  const files = opts.filesDir || detectFilesDir();
  const run = () => {
    try {
      const names = opts.tools || KIT_TOOLS;
      const missing = names.filter((n) => { try { return typeof ctx.tools?.get !== "function" || !ctx.tools.get(n); } catch { return true; } });
      const live = countSkills(join(files, "payload/dshhome/skills"), true);
      const mirror = countSkills(join(files, ".agents/skills"), false);
      const mem = opts.memoryCount ? opts.memoryCount() : undefined;
      const line = "[agent-kit] самопроверка: инструменты " + (names.length - missing.length) + "/" + names.length +
        (missing.length ? " (НЕТ в реестре: " + missing.join(", ") + ")" : "") +
        " · правил роутера " + RULES.length +
        " · раннер " + (process.env.DSH_SCHEDULE_RUNNER === "off" ? "выкл" : "вкл") +
        " · гейт отмены " + (process.env.DSH_SCHEDULE_GATE === "off" ? "выкл" : "вкл") +
        " · скиллов на диске " + live.total + "/" + mirror.total + " (скрытых от модели " + live.hidden + ")" +
        (mem === undefined ? "" : " · память " + mem + " заметок");
      // Пишем и в свой файл: лог плагинов (<files>/payload/dshhome/logs/plugins.log) после перезапусков
      // приложения перестаёт пополняться (проверено 30.09.2026: последняя запись 20:44, старты в 21:00–23:44 — тишина).
      if (opts.logFile !== false) {
        try {
          const dir = join(files, "agent-memory");
          mkdirSync(dir, { recursive: true });
          appendFileSync(join(dir, "self-check.log"), new Date().toISOString() + " " + line + "\n");
        } catch { /* не критично */ }
      }
      log(line);
      return true;
    } catch (e) {
      log("[agent-kit] самопроверка не удалась: " + ((e && e.message) || e));
      return false;
    }
  };
  const t = setTimeout(run, opts.delayMs ?? 7000);
  t.unref?.();
  return { run };
}
