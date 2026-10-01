// Гейт отменённых задач планировщика.
//
// Зачем: приложение при срабатывании будильника шлёт текст задачи в движок как обычный промпт
// (ScheduleExecutor.sendPromptRaw → session.prompt), id задачи при этом не передаётся. Настоящей отмены
// будильника без APK нет (см. lib/schedule.js), поэтому отменённую задачу можно только НЕ ИСПОЛНИТЬ.
//
// Как: на agent/pre-step шага 1 сравниваем входящие сообщения хода с текстами отменённых задач
// (файл <files>/scheduled-cancelled.json, который пишет android_schedule_cancel). Совпало — ход
// отклоняется ({kind:"reject"}), модель не тратит токены, а владелец получает уведомление.
//
// Безопасность: сравнение только по нормализованному тексту и только для текстов длиной ≥ 10 символов,
// чтобы случайное короткое сообщение не было принято за отменённую задачу. Выключатель: DSH_SCHEDULE_GATE=off.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectFilesDir } from "./paths.js";
import { parseMarkers, markersHaveText, emptyMarkers } from "./schedule.js";

const textOf = (m) => {
  if (!m) return "";
  if (typeof m === "string") return m;
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && b.type === "text" ? b.text : "")).join(" ").trim();
  return "";
};

export function installScheduleGate(ctx, opts = {}) {
  const log = (m) => (ctx.logger?.warn ? ctx.logger.warn(m) : console.warn(m));
  if (process.env.DSH_SCHEDULE_GATE === "off") return undefined;
  const file = opts.file || join(detectFilesDir(), "scheduled-cancelled.json");
  const notify = opts.notify;

  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    try {
      const { step, messages, signal } = payload;
      if (decision.kind === "reject" || signal?.aborted) return decision;
      if (step !== 1) return decision;
      let markers = emptyMarkers();
      try { markers = parseMarkers(await readFile(file, "utf8")); } catch { return decision; } // файла нет — нечего проверять
      if (!markers.texts.length) return decision;
      const hit = (messages || []).map(textOf).find((t) => t && markersHaveText(markers, t));
      if (!hit) return decision;
      log("[agent-kit] пропущена отменённая задача планировщика: " + hit.slice(0, 80));
      try { if (notify) await notify("Задача отменена", "Исполнение пропущено: " + hit.slice(0, 60)); } catch { /* не критично */ }
      return { kind: "reject", reason: "задача отменена через android_schedule_cancel" };
    } catch (e) {
      log("[agent-kit] schedule-gate: " + (e && e.message || e)); // гейт не должен ронять ход
    }
    return decision;
  });
  return { file };
}

