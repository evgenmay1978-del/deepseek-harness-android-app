// memory-tools — подключение индекса памяти к плагину: автосборка + инструмент поиска.
import { watch } from "node:fs";
import { join } from "node:path";
import { openIndex, rebuildAll, search } from "./memory-index.js";
import { detectFilesDir } from "./paths.js";

/** Каталоги памяти: приватный репозиторий заметок и каталог заметок приложения. */
export function memoryDirs(files = detectFilesDir()) {
  return [join(files, "agent-memory"), join(files, "memory")].filter(Boolean);
}

export function installMemoryIndex(ctx, opts = {}) {
  const dirs = opts.dirs || memoryDirs(opts.filesDir);
  const log = opts.log || (() => {});
  const db = openIndex(opts.dbPath || ":memory:");
  let count = 0;
  const refresh = (options = {}) => {
    try {
      const r = rebuildAll(db, dirs, { ...(opts.deps || {}), verifySignature: opts.verifySignature }, { log, humanDirs: opts.humanDirs || [], ...options });
      // если подмена отменена (инвариант/обвал) — оставляем прежнее содержимое и прежний счётчик
      count = r.swapped ? r.inserted : (r.previous || 0);
    } catch (e) { log("пересборка не удалась: " + ((e && e.message) || e)); }
    return count;
  };
  count = refresh();

  // Пересборка при изменении заметок: индекс — кэш, он не должен отставать от файлов.
  const watchers = [];
  for (const d of dirs) {
    try {
      const w = watch(d, () => { clearTimeout(w._t); w._t = setTimeout(refresh, 500); w._t.unref?.(); });
      w.unref?.(); watchers.push(w);
    } catch { /* каталога нет */ }
  }

  if (ctx?.tools?.register && opts.registerTool !== false) {
    try {
      ctx.tools.register({
        name: "memory_search",
        side_effect: "none",   // явно: иначе при дефолте "unknown" инструмент молча отклоняется под readonly
        capabilities: [],
        description: "Ищет по памяти проекта (заметки в репозитории): релевантность + свежесть, заменённые факты скрыты.",
        parameters: { query: { type: "string", required: true }, limit: { type: "number" } },
        async execute(args) {
          const hits = search(db, String(args?.query || ""), { limit: Number(args?.limit) || 5, now: Date.now() });
          return { ok: true, count: hits.length, items: hits.map((h) => ({ id: h.id, key: h.key, updated: h.updated, text: h.body.slice(0, 400) })) };
        },
      });
    } catch { /* инструмент уже зарегистрирован */ }
  }
  return {
    refresh,
    search: (q, o) => search(db, q, { now: Date.now(), ...o }),
    get count() { return count; },
    db,                       // доступ к собственной базе: нужен для диагностики и тестов паритета
    dirs,
    stop: () => watchers.forEach((w) => { try { w.close(); } catch {} }),
  };
}
