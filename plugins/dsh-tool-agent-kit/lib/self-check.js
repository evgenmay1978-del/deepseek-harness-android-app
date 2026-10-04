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
      // Каждая секция в своём try/catch: падение одной строки не должно съедать остальные.
      // (04.10.2026: ReferenceError в чтении журнала стирал всю строку самопроверки целиком.)
      const parts = [];
      const section = (label, fn) => {
        try { const s = fn(); if (s) parts.push(s); }
        catch (e) { parts.push(label + ": НЕ УДАЛОСЬ (" + ((e && e.message) || e) + ")"); }
      };
      section("инструменты", () => {
        const names = opts.tools || KIT_TOOLS;
        const missing = names.filter((n) => { try { return typeof ctx.tools?.get !== "function" || !ctx.tools.get(n); } catch { return true; } });
        return "инструменты " + (names.length - missing.length) + "/" + names.length +
          (missing.length ? " (НЕТ в реестре: " + missing.join(", ") + ")" : "");
      });
      parts.push("правил роутера " + RULES.length);
      parts.push("раннер " + (process.env.DSH_SCHEDULE_RUNNER === "off" ? "выкл" : "вкл"));
      parts.push("гейт отмены " + (process.env.DSH_SCHEDULE_GATE === "off" ? "выкл" : "вкл"));
      section("скиллы", () => {
        const live = countSkills(join(files, "payload/dshhome/skills"), true);
        const mirror = countSkills(join(files, ".agents/skills"), false);
        return "скиллов на диске " + live.total + "/" + mirror.total + " (скрытых от модели " + live.hidden + ")";
      });
      section("память", () => {
        const mem = opts.memoryCount ? opts.memoryCount() : undefined;
        return mem === undefined ? "" : "память " + mem + " заметок";
      });
      // Строка пишется на старте, поэтому показывает инъекцию ПРОШЛОЙ сессии — подписано явно.
      // Живое состояние на момент вызова даёт agent_memory(action="status").
      section("инъекция", () => {
        const injArr = opts.injectionLog ? opts.injectionLog() : [];
        const last = Array.isArray(injArr) ? injArr[injArr.length - 1] : null;
        return last
          ? "последняя инъекция ДО СТАРТА: " + last.at + " " + (last.branch || "?") +
            " via " + (last.via || "?") + " (запрос " + (last.qlen ?? "?") + " симв) " +
            ((last.keys || []).length) + " шт, " + last.size + "/" + last.cap
          : "инъекций ДО СТАРТА не было";
      });
      const line = "[agent-kit] самопроверка: " + parts.join(" · ");
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
      const why = (e && e.message) || e;
      // Канал self-check.log обязан оставаться живым и при падении: молча проглоченная ошибка
      // уже стоила нескольких кругов (04.10.2026, ReferenceError в чтении журнала).
      try {
        const dir = join(files, "agent-memory");
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "self-check.log"), new Date().toISOString() + " [agent-kit] самопроверка НЕ УДАЛАСЬ: " + why + "\n");
      } catch { /* и это не критично */ }
      log("[agent-kit] самопроверка не удалась: " + why);
      return false;
    }
  };
  const t = setTimeout(run, opts.delayMs ?? (Number(process.env.DSH_SELFCHECK_DELAY_MS) || 7000));
  t.unref?.();
  return { run };
}
