// @ts-check
/**
 * memory-consolidate-runner — ночная консолидация как ЗАДАЧА ДВИЖКА, а не как агентская сессия.
 *
 * Почему так: агентская сессия попадает под запрет планирования (capability "schedules"), а консолидация —
 * служебная работа движка. Она не должна требовать человека и не должна уметь ничего, кроме правки заметок.
 * Правила: по умолчанию только отчёт (dryRun), человеческие каталоги не трогаются вообще,
 * отчёт пишется в plugin-logs/.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { scan, plan, consolidate } from "./memory-consolidate.js";

export function installMemoryConsolidate(ctx, opts = {}) {
  const dirs = opts.dirs || [];
  const humanDirs = opts.humanDirs || [];
  const dryRun = opts.dryRun !== false;          // по умолчанию — только отчёт
  const intervalMs = opts.intervalMs || 24 * 60 * 60 * 1000;
  const reportPath = opts.reportPath;
  const log = opts.log || (() => {});
  let last = null;

  /** Один проход. Возвращает отчёт — он же используется в тестах и в диагностике. */
  const runOnce = ({ apply = false } = {}) => {
    const startedAt = new Date().toISOString();
    const perDir = [];
    for (const dir of dirs) {
      const human = humanDirs.includes(dir);
      let groups = [];
      try { groups = plan(scan(dir, opts.deps || {})); } catch (e) { perDir.push({ dir, human, error: String(e?.message || e) }); continue; }
      const entry = { dir, human, groups: groups.length, applied: 0, mode: human ? "пропуск (человеческий каталог)" : (dryRun || !apply ? "dryRun" : "применение") };
      // Человеческие каталоги не трогаем ни в каком режиме: там источник правды — человек.
      if (!human && apply && !dryRun && groups.length) {
        try { const rep = consolidate(dir, { deps: opts.deps || {}, dryRun: false }); entry.applied = (rep?.changed || []).length; }
        catch (e) { entry.error = String(e?.message || e); }
      }
      perDir.push(entry);
    }
    last = { at: startedAt, dryRun, dirs: perDir };
    try { if (reportPath) { mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(last, null, 2), "utf8"); } } catch { /* отчёт не критичен */ }
    log("[agent-kit] консолидация памяти: " + JSON.stringify(perDir.map((x) => (x.dir.split("/").pop() || x.dir) + ":" + x.mode + "(" + x.groups + ")")));
    return last;
  };

  const timer = setInterval(() => { try { runOnce({ apply: !dryRun }); } catch { /* не роняем движок */ } }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { runOnce, get last() { return last; }, stop: () => clearInterval(timer) };
}
