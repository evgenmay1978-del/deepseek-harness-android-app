// @ts-check
/**
 * app — единая сборка плагина. Смысл: любая отсутствующая зависимость должна падать ГРОМКО при старте,
 * а не превращаться в тихую поломку (именно этот класс ошибок дал половину найденных дефектов:
 * непрокинутый deps у каталога скиллов, неопределённый opts, потерянный humanDirs).
 */
import { installScheduleRunner } from "./schedule-runner.js";
import { installMemoryIndex } from "./memory-tools.js";
import { installSkillCatalog } from "./skill-catalog.js";
import { createRegistry, PROFILES } from "./tool-registry.js";
import { installMemoryConsolidate } from "./memory-consolidate-runner.js";

/** Проверка обязательной зависимости: undefined — это ошибка старта, а не «пусто». */
/** Проверка ФОРМЫ, а не только наличия: Set вместо Map или строка вместо функции тоже должны падать. */
export function requireForm(deps, name, kind) {
  const v = requireDep(deps, name);
  if (kind === "function" && typeof v !== "function") throw new Error("createApp: '" + name + "' должен быть функцией, получено " + typeof v);
  if (kind === "map" && !(v instanceof Map)) throw new Error("createApp: '" + name + "' должен быть Map, получено " + (v && v.constructor && v.constructor.name));
  if (kind === "humanDirs") {
    if (!Array.isArray(v)) throw new Error("createApp: 'humanDirs' должен быть массивом каталогов (пустой — только с allowNoHumanDirs)");
    for (const d of v) if (typeof d !== "string" || !d.startsWith("/")) throw new Error("createApp: 'humanDirs' содержит не абсолютный путь: " + String(d));
  }
  if (kind === "dirs") {
    if (!Array.isArray(v) || v.length === 0) throw new Error("createApp: '" + name + "' должен быть непустым массивом каталогов");
    for (const d of v) if (typeof d !== "string" || !d) throw new Error("createApp: '" + name + "' содержит нестроковый каталог");
  }
  return v;
}

/** Валидация реестра: опечатка в allowlist молча превращается в запрет, а неизвестный side_effect — в дыру. */
export function validateRegistry(reg) {
  const problems = [];
  // Пустой реестр на этапе сборки — норма: инструменты плагина регистрируются позже, через ctx.tools.
  // Проверять allowlist против пустого реестра бессмысленно и даёт ложную шумиху в статусе.
  if (reg.list().length === 0) return problems;
  const known = new Set(reg.list().map((t) => t.name));
  for (const t of reg.list()) {
    if (!t.name) problems.push("инструмент без имени");
    if (!t.side_effect || t.side_effect === "unknown") problems.push("у '" + t.name + "' не объявлен side_effect");
  }
  for (const [profile, cfg] of Object.entries(PROFILES)) {
    for (const name of cfg.allow || []) {
      if (name === "*") continue;
      if (!known.has(name)) problems.push("профиль " + profile + " ссылается на несуществующий инструмент '" + name + "'");
    }
  }
  return problems;
}

export function requireDep(deps, name) {
  const v = deps?.[name];
  if (v === undefined) throw new Error("createApp: отсутствует обязательная зависимость '" + name + "'");
  return v;
}

/**
 * Сборка с fail-closed: при любой ошибке возвращаем {ok:false} и НЕ собираем подсистемы.
 * Вызывающий (index.js) обязан в этом случае не регистрировать инструменты, а показать статус «деградировал».
 */
/** Статус плагина лежит ВНЕ agent-memory: этот каталог агент может писать и он попадает в индекс памяти. */
export function defaultStatusPath(filesDir) { return filesDir + "/plugin-status.json"; }

export function assembleSafely(ctx, deps = {}, io = {}) {
  const write = io.writeFile || (() => {});
  const statusPath = io.statusPath;
  const bootId = io.bootId || String(Date.now());
  const stamp = () => new Date().toISOString();
  // Сначала "pending": падение процесса посреди сборки не оставит старый ok:true.
  let wrotePending = true;
  try { if (statusPath) write(statusPath, JSON.stringify({ ok: false, pending: true, boot_id: bootId, at: stamp() })); }
  catch { wrotePending = false; }
  const writeStatus = (payload) => {
    try {
      if (statusPath) write(statusPath, JSON.stringify({ boot_id: bootId, at: stamp(), wrote_pending: wrotePending, ...payload }));
      return true;
    } catch { return false; }
  };
  try {
    const app = createApp(ctx, deps);
    const ok = writeStatus({
      ok: true, checks: app.checks, validation: app.validation,
      origin_protection: app.origin_protection, protected_paths: app.protectedPaths,
    });
    // Ошибка записи статуса не переводит плагин в рабочий режим: статус — часть контракта.
    if (!ok) return { ok: false, error: "статус не записан (fail-closed)" };
    return { ok: true, app };
  } catch (e) {
    const error = (e && e.message) || String(e);
    writeStatus({ ok: false, error, tools: "не зарегистрированы (fail-closed)" });
    return { ok: false, error };
  }
}

export function createApp(ctx, deps = {}) {
  const app = { checks: [] };
  const files = requireDep(deps, "filesDir");
  const memoryDirs = requireForm(deps, "memoryDirs", "dirs");
  const skillDirs = requireForm(deps, "skillDirs", "dirs");
  // humanDirs обязателен: пустой список допустим ТОЛЬКО явным флагом, иначе пропуск снова станет молчаливым.
  if (Array.isArray(deps.humanDirs) && deps.humanDirs.length === 0 && deps.allowNoHumanDirs !== true) {
    throw new Error("createApp: 'humanDirs' пуст — нужен явный allowNoHumanDirs");
  }
  const humanDirs = (Array.isArray(deps.humanDirs) && deps.humanDirs.length === 0 && deps.allowNoHumanDirs === true)
    ? []
    : requireForm(deps, "humanDirs", "humanDirs");
  if (deps.appPost !== undefined) requireForm(deps, "appPost", "function");
  if (deps.state !== undefined) requireForm(deps, "state", "map");

  if (Array.isArray(memoryDirs) && memoryDirs.length === 0) throw new Error("createApp: memoryDirs пуст");
  if (Array.isArray(skillDirs) && skillDirs.length === 0) throw new Error("createApp: skillDirs пуст");

  app.schedule = installScheduleRunner(ctx, { ...(deps.schedule || {}) }, { notify: deps.notify, filesDir: files, appPost: deps.appPost });
  app.checks.push("schedule");

  app.memory = installMemoryIndex(ctx, { dirs: memoryDirs, humanDirs, verifySignature: deps.verifySignature, registerTool: deps.registerTools !== false, log: deps.log });
  app.checks.push("memory");

  app.skills = installSkillCatalog(ctx, { dirs: skillDirs, deps: deps.skillDeps || {}, registerTool: deps.registerTools !== false });
  app.checks.push("skills");

  // Консолидация памяти — задача ДВИЖКА (таймер в процессе), не агентская сессия: иначе попадает
  // под запрет планирования. По умолчанию dryRun, человеческие каталоги не трогаются.
  app.consolidate = installMemoryConsolidate(ctx, {
    dirs: memoryDirs,
    humanDirs,
    dryRun: deps.consolidateDryRun !== false,
    reportPath: files ? files + "/plugin-logs/memory-consolidate.json" : null,
    intervalMs: deps.consolidateIntervalMs || 24 * 60 * 60 * 1000,
  });
  app.checks.push("consolidate");

  // Реестр и диспетчер — обязательная часть: без них движок не должен считать плагин собранным.
  app.registry = deps.registry || createRegistry();
  app.validation = validateRegistry(app.registry);
  if (deps.strictRegistry === true && app.registry.list().length === 0) {
    throw new Error("createApp: реестр пуст — диспетчер без инструментов не считается собранным");
  }
  if (deps.strictRegistry === true && app.validation.length) {
    throw new Error("createApp: реестр невалиден — " + app.validation.join("; "));
  }
  app.checks.push("registry");
  // Пути, которые агентским инструментам писать нельзя: человеческие каталоги и файл статуса.
  app.protectedPaths = [...humanDirs, ...(deps.statusPath ? [deps.statusPath] : [])];
  app.origin_protection = humanDirs.length ? "вкл" : "выкл (нет подписанного списка humanDirs, W4)";
  // Идемпотентность вместо модульного кэша: повторная сборка закрывает прежние ресурсы.
  app.dispose = () => { try { app.memory?.stop?.(); } catch {} try { app.schedule?.stop?.(); } catch {} try { app.consolidate?.stop?.(); } catch {} };

  return app;
}
