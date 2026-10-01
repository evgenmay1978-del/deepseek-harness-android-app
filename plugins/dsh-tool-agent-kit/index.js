/**
 * dsh-tool-agent-kit — усиление агента на Android.
 *
 *  android_act       действие на экране + ожидание «успокоения» UI + компактный снимок (ref для повторных тапов)
 *  android_wait_for  дождаться текста / исчезновения текста / смены приложения
 *  android_find      найти элементы по тексту, не гоняя всё дерево через контекст
 *  + guard           бюджет шагов, детектор зацикливания (agent/pre-step) — можно выключить DSH_GUARD=off
 *
 * Схемы вывода: additionalProperties:false → каждое поле, которое возвращает execute, объявлено в schema.
 */
import fs from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { call, explain, sleep } from "./lib/a11y.js";
import { compact, fingerprint, diff, render, line } from "./lib/screen.js";
import { installGuard, notifyApp } from "./lib/guard.js";
import { ensureAccessibility } from "./lib/a11y-boot.js";
import { MemoryStore } from "./lib/store.js";
import { memoryTool, installMemoryInjection } from "./lib/memory.js";
import { detectFilesDir } from "./lib/paths.js";
import { registerScheduleTools } from "./lib/schedule-tools.js";
import { installScheduleGate } from "./lib/schedule-gate.js";
import { installScheduleRunner } from "./lib/schedule-runner.js";
import { installSkillRouter } from "./lib/skill-router.js";
import { installMemoryIndex } from "./lib/memory-tools.js";
import { assembleSafely, defaultStatusPath } from "./lib/app.js";
import { installSkillCatalog } from "./lib/skill-catalog.js";
import { installSelfCheck } from "./lib/self-check.js";
import { registerVscreenTools } from "./lib/vscreen-tools.js";
import { join } from "node:path";

const name = "tool-agent-kit";
const inject = ["tools"];

const REF_TTL_MS = 120_000;
const POLL_MS = 250;

/** Снимок экрана: compact-узлы + отпечаток. */
async function snapshot(signal) {
  const v = explain(await call("/dump", { timeoutMs: 8000, signal }));
  if (!v.ok) return { ok: false, error: v.error || "нет данных экрана" };
  const pkg = typeof v.package === "string" ? v.package : "";
  const nodes = compact(v.nodes);
  return { ok: true, pkg, nodes, fp: fingerprint(pkg, nodes), truncated: v.truncated === true };
}

/**
 * Ждёт «тишины»: отпечаток экрана не менялся не менее QUIET_MS (или вышел maxMs).
 * Одного совпадения двух опросов недостаточно — промежуточный «Loading…» держится дольше 250 мс
 * и был бы принят за конечное состояние.
 */
const QUIET_MS = 500;
async function settle(signal, maxMs) {
  const t0 = Date.now();
  await sleep(Math.min(200, maxMs), signal);
  let prev = await snapshot(signal);
  let lastChange = Date.now();
  while (prev.ok && Date.now() - t0 < maxMs && !signal?.aborted) {
    if (Date.now() - lastChange >= QUIET_MS) break;
    await sleep(POLL_MS, signal);
    const cur = await snapshot(signal);
    if (!cur.ok) return cur;
    if (cur.fp !== prev.fp) lastChange = Date.now();
    prev = cur;
  }
  return prev.ok ? { ...prev, waited: Date.now() - t0 } : prev;
}

const contains = (hay, needle) => String(hay || "").toLowerCase().includes(String(needle).toLowerCase());
const hasText = (nodes, q) => nodes.some((n) => contains(n.text, q) || contains(n.desc, q));

const okOutput = (extra = {}) => ({
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true },
    error: { type: "string" },
    text: { type: "string" },
    package: { type: "string" },
    ...extra
  }
});

const renderText = (_args, v) => {
  if (!v || typeof v !== "object") return [{ type: "text", text: "Инструмент не вернул результат" }];
  return [{ type: "text", text: (v.ok ? "" : "Не удалось: " + (v.error || "неизвестная ошибка") + "\n\n") + (v.text || "") }];
};

function apply(ctx) {
  /** Кэш последнего снимка на агента: нужен, чтобы ref → координаты. */
  const cache = new Map();
  const keyOf = (exec) => String(exec?.agent?.id ?? "default");
  const remember = (exec, snap) => {
    cache.set(keyOf(exec), { ts: Date.now(), pkg: snap.pkg, nodes: snap.nodes, fp: snap.fp });
    if (cache.size > 20) cache.delete(cache.keys().next().value);
  };

  // ───────────── android_act ─────────────
  ctx.tools.register(defineTool({
    name: "android_act",
    description:
      "Одно действие на экране + автоматическое ожидание, пока интерфейс «успокоится», + компактный снимок экрана. " +
      "Заменяет связку «tap → screen → screen». action: look (только снимок) | tap | type | scroll | back | home | swipe. " +
      "В снимке у каждого элемента есть номер [ref] — для точного повторного тапа передайте tap с ref=<номер> " +
      "(и, для страховки, expect=<часть текста элемента>: если экран успел измениться, вернётся ошибка, а не случайный тап). " +
      "tap без ref: text/desc (поиск по подстроке) или x,y / fx,fy (доля экрана 0..1 — устойчива к масштабу скриншота). " +
      "Если changed=false, экран не изменился — действие, вероятно, не сработало: не повторяйте его вслепую, смените подход. " +
      "Нужна включённая служба спец. возможностей.",
    parameters: {
      action: { type: "string", required: true, enum: ["look", "tap", "type", "scroll", "back", "home", "swipe"], description: "Что сделать" },
      ref: { type: "number", description: "tap: номер элемента из последнего снимка" },
      expect: { type: "string", description: "tap по ref: ожидаемая подстрока текста/описания элемента (защита от устаревшего ref)" },
      text: { type: "string", description: "tap: текст элемента; type: вводимый текст" },
      desc: { type: "string", description: "tap: content-description элемента" },
      x: { type: "number" }, y: { type: "number" },
      fx: { type: "number", description: "доля ширины 0..1" }, fy: { type: "number", description: "доля высоты 0..1" },
      paste: { type: "boolean", description: "type: вставлять через буфер (для WebView)" },
      direction: { type: "string", enum: ["up", "down", "left", "right"], description: "scroll: направление" },
      fx1: { type: "number" }, fy1: { type: "number" }, fx2: { type: "number" }, fy2: { type: "number" },
      durationMs: { type: "number", description: "swipe: длительность, мс" },
      settle_ms: { type: "number", description: "макс. ожидание успокоения UI, мс (по умолчанию 1500, максимум 5000)" },
      snapshot: { type: "boolean", description: "false — не возвращать снимок (быстрее, но вслепую)" }
    },
    output: {
      schema: okOutput({ changed: { type: "boolean" }, nodes: { type: "number" }, waited_ms: { type: "number" }, method: { type: "string" } }),
      render: renderText
    },
    async execute(args, exec) {
      const signal = exec?.signal;
      const act = String(args.action);
      const settleMs = Math.max(0, Math.min(5000, Number(args.settle_ms ?? 1500) || 0));

      // 1) «до»: свежий отпечаток, чтобы честно сказать changed
      const before = act === "look" ? undefined : await snapshot(signal);
      if (before && !before.ok && /Служба спец/.test(before.error || "")) return { ok: false, error: before.error };

      // 2) действие
      let actionOk = true, actionErr, method;
      if (act !== "look") {
        const r = await performAction(args, exec, cache.get(keyOf(exec)), signal);
        actionOk = r.ok; actionErr = r.error; method = r.method;
      }

      // 3) «после»
      if (args.snapshot === false) return { ok: actionOk, ...(actionErr ? { error: actionErr } : {}), ...(method ? { method } : {}), text: "(снимок отключён)" };
      const after = await settle(signal, act === "look" ? 0 : settleMs);
      if (!after.ok) return { ok: false, error: actionErr ? `${actionErr}; затем: ${after.error}` : after.error };
      remember(exec, after);

      const changed = before && before.ok ? before.fp !== after.fp : true;
      const d = before && before.ok ? diff(before.nodes, after.nodes) : { added: after.nodes.length, removed: 0 };
      const head = act === "look" ? "" : changed
        ? `Экран изменился (+${d.added}/−${d.removed}).\n` + (before.ok && before.pkg !== after.pkg ? `Приложение: ${before.pkg} → ${after.pkg}\n` : "")
        : "Экран НЕ изменился.\n";
      return {
        ok: actionOk,
        ...(actionErr ? { error: actionErr } : {}),
        changed,
        package: after.pkg,
        nodes: after.nodes.length,
        waited_ms: after.waited ?? 0,
        ...(method ? { method } : {}),
        text: head + render(after.pkg, after.nodes) + (after.truncated ? "\n(дерево усечено службой)" : "")
      };
    }
  }));

  // ───────────── android_wait_for ─────────────
  // Имя android_wait_for занято dsh-tool-agent-plus, поэтому здесь android_wait_until
  // (+ поддержка gone=true: ждать ИСЧЕЗНОВЕНИЯ текста, чего у agent-plus нет).
  ctx.tools.register(defineTool({
    name: "android_wait_until",
    description:
      "Ждёт условие на экране вместо слепых пауз: появление текста (text), исчезновение текста (text + gone=true) " +
      "или смену переднего приложения (package — подстрока имени пакета). Возвращает снимок в момент срабатывания " +
      "либо последний снимок при таймауте. Используйте после запуска приложений, загрузок, отправки форм.",
    parameters: {
      text: { type: "string", description: "Подстрока текста/описания элемента (без учёта регистра)" },
      gone: { type: "boolean", description: "true — ждать, пока текст ИСЧЕЗНЕТ" },
      package: { type: "string", description: "Подстрока пакета переднего приложения" },
      timeout_ms: { type: "number", description: "Таймаут, мс (по умолчанию 10000, максимум 60000)" },
      interval_ms: { type: "number", description: "Период опроса, мс (по умолчанию 400, минимум 150)" }
    },
    output: { schema: okOutput({ matched: { type: "boolean" }, waited_ms: { type: "number" } }), render: renderText },
    async execute(args, exec) {
      const signal = exec?.signal;
      if (!args.text && !args.package) return { ok: false, error: "нужен text или package" };
      const timeout = Math.max(500, Math.min(60000, Number(args.timeout_ms ?? 10000) || 10000));
      const interval = Math.max(150, Number(args.interval_ms ?? 400) || 400);
      const t0 = Date.now();
      let last;
      while (true) {
        const s = await snapshot(signal);
        if (!s.ok) return { ok: false, error: s.error, matched: false, waited_ms: Date.now() - t0 };
        last = s;
        const textOk = args.text ? (args.gone ? !hasText(s.nodes, args.text) : hasText(s.nodes, args.text)) : true;
        const pkgOk = args.package ? contains(s.pkg, args.package) : true;
        if (textOk && pkgOk) {
          remember(exec, s);
          return { ok: true, matched: true, waited_ms: Date.now() - t0, package: s.pkg, text: render(s.pkg, s.nodes, { maxNodes: 40, maxChars: 3000 }) };
        }
        if (signal?.aborted) return { ok: false, error: "отменено", matched: false, waited_ms: Date.now() - t0 };
        if (Date.now() - t0 + interval >= timeout) break;
        await sleep(interval, signal);
      }
      remember(exec, last);
      return {
        ok: false, matched: false, waited_ms: Date.now() - t0, package: last.pkg,
        error: `таймаут ${timeout} мс: условие не выполнено (${args.text ? (args.gone ? "текст не исчез: " : "текст не появился: ") + args.text : ""}${args.package ? " пакет: " + args.package : ""})`,
        text: render(last.pkg, last.nodes, { maxNodes: 40, maxChars: 3000 })
      };
    }
  }));

  // ───────────── android_find ─────────────
  ctx.tools.register(defineTool({
    name: "android_find",
    description:
      "Ищет на текущем экране элементы по подстроке (текст или описание) и возвращает только совпавшие — с номерами [ref] " +
      "для android_act(action=tap, ref=…). Экономит контекст на сложных экранах вместо полного дерева.",
    parameters: {
      query: { type: "string", required: true, description: "Подстрока (без учёта регистра)" },
      clickable_only: { type: "boolean", description: "Только кликабельные" },
      limit: { type: "number", description: "Максимум результатов (по умолчанию 15, максимум 50)" }
    },
    output: { schema: okOutput({ total: { type: "number" } }), render: renderText },
    async execute(args, exec) {
      const q = String(args.query ?? "").trim();
      if (!q) return { ok: false, error: "query пустой" };
      const s = await snapshot(exec?.signal);
      if (!s.ok) return { ok: false, error: s.error };
      remember(exec, s);
      const limit = Math.max(1, Math.min(50, Number(args.limit ?? 15) || 15));
      const hits = [];
      s.nodes.forEach((n, i) => {
        if ((contains(n.text, q) || contains(n.desc, q)) && (!args.clickable_only || n.clickable)) hits.push(line(n, i));
      });
      return {
        ok: true, package: s.pkg, total: hits.length,
        text: hits.length === 0
          ? `Ничего не найдено по «${q}» в ${s.pkg || "?"} (элементов на экране: ${s.nodes.length}). Попробуйте прокрутить или android_act(action=look).`
          : `Найдено ${hits.length}${hits.length > limit ? ` (показаны первые ${limit})` : ""} в ${s.pkg}:\n` + hits.slice(0, limit).join("\n")
      };
    }
  }));

  // ───────────── guard ─────────────
  if (process.env.DSH_GUARD !== "off") {
    installGuard(ctx, {
      ...(process.env.DSH_MAX_STEPS ? { maxSteps: Math.max(5, parseInt(process.env.DSH_MAX_STEPS, 10) || 60) } : {})
    });
  }

  // ───────────── agent_memory (долговременная память) ─────────────
  let memoryCount;
  if (process.env.DSH_MEMORY !== "off") {
    const file = process.env.DSH_MEMORY_FILE || join(detectFilesDir(), "agent-memory", "notes.json");
    const store = new MemoryStore(file);
    ctx.tools.register(memoryTool(defineTool, store));
    installMemoryInjection(ctx, store);
    memoryCount = () => store.count();
  }

  // ───────────── планировщик: список и отмена (см. lib/schedule.js) ─────────────
  if (process.env.DSH_SCHEDULE !== "off") registerScheduleTools(ctx);
  // Отменённые задачи не исполняются: ход с текстом отменённой задачи отклоняется (текст задачи id не несёт).
  installScheduleGate(ctx, { notify: notifyApp });
  // Исполнение отложенных задач внутри движка: приложение не проходит авторизацию API (401 на /api/session.create),
  // поэтому задачи из журнала отправляем сами через ctx.remote.session. Выключатель DSH_SCHEDULE_RUNNER=off.
  // Fail-closed: сначала сборка. Если она не удалась — НИ ОДНОГО инструмента не регистрируем,
  // а статус деградации виден снаружи (файл + лог), а не только в переписке.
  const base = detectFilesDir() || "";
  const statusPath = defaultStatusPath(base);
  // Список человеческих каталогов берём из ПОДПИСАННОГО конфига: неподписанный игнорируется.
  // Пока подписи нет (W4) список пуст, и это видно в статусе как "origin_protection: выкл" — без ложной защиты.
  const readHumanDirs = (b) => {
    try {
      const cfg = JSON.parse(fs.readFileSync(b + "/maestro/env/human-dirs.json", "utf8"));
      if (cfg && cfg.signed === true && Array.isArray(cfg.dirs)) return cfg.dirs.filter((d) => typeof d === "string" && d.startsWith("/"));
    } catch { /* конфига нет или он нечитаем */ }
    return [];
  };
  const humanDirs = readHumanDirs(base);
  const assembled = assembleSafely(ctx, {
    filesDir: base,
    memoryDirs: [base + "/maestro/env/memory-repo", base + "/agent-memory", base + "/memory"],
    skillDirs: [base + "/payload/dshhome/skills", base + "/.agents/skills", base + "/maestro/env/memory-repo/skills"],
    notify: notifyApp,
    humanDirs,
    allowNoHumanDirs: humanDirs.length === 0,
    statusPath,
  }, { statusPath, writeFile: (f, t) => { try { fs.writeFileSync(f, t); } catch { /* нет прав */ } } });
  if (!assembled.ok) {
    ctx.logger?.warn?.("[agent-kit] ДЕГРАДАЦИЯ: сборка не удалась (" + assembled.error + ") — инструменты не зарегистрированы");
    return;
  }
  ctx.logger?.warn?.("[agent-kit] createApp собрал: " + assembled.app.checks.join(", "));
  // Напоминание о скиллах: если ход похож на известную ситуацию (AGENTS §8), модель получает
  // одну строку «загрузи такие-то скиллы» — чтобы скиллы работали, а не лежали. Выключатель DSH_SKILL_ROUTER=off.
  installSkillRouter(ctx, {});

  // ───────────── самопроверка: одна строка в лог о том, что реально смонтировано ─────────────
  // Ловит частичное монтирование (инструмент не зарегистрировался) и расхождение скиллов на диске.
  installSelfCheck(ctx, { memoryCount });

  // ───────────── виртуальный экран: открыть URL на нужном дисплее ─────────────
  // android_intent не прокидывает --display, а ввод в адресную строку уходит в поиск — здесь правильный путь.
  if (process.env.DSH_VSCREEN_TOOLS !== "off") registerVscreenTools(ctx);

  // ───────────── восстановление a11y после перезапуска приложения ─────────────
  // Система вычищает компонент службы, когда процесс приложения умирает: без этого
  // после каждого перезапуска мертвы все экранные инструменты (и штатные, и эти).
  void ensureAccessibility(ctx);
}

/** Выполняет один жест через службу спец. возможностей. */
async function performAction(args, exec, cached, signal) {
  const act = String(args.action);
  const num = (v) => String(Number(v));
  switch (act) {
    case "tap": {
      const p = {};
      if (args.ref !== undefined) {
        if (!cached || Date.now() - cached.ts > REF_TTL_MS) return { ok: false, error: "нет свежего снимка для ref — сначала android_act(action=look) или android_find" };
        const n = cached.nodes[Number(args.ref)];
        if (!n) return { ok: false, error: `ref=${args.ref} вне диапазона (0..${cached.nodes.length - 1})` };
        if (args.expect && !(contains(n.text, args.expect) || contains(n.desc, args.expect)))
          return { ok: false, error: `ref=${args.ref} теперь «${(n.text || n.desc || "").slice(0, 40)}», ожидалось «${args.expect}» — снимок устарел, сделайте look` };
        p.x = num(n.x); p.y = num(n.y);
      } else {
        if (args.text) p.text = String(args.text);
        if (args.desc) p.desc = String(args.desc);
        for (const k of ["x", "y", "fx", "fy"]) if (args[k] !== undefined) p[k] = num(args[k]);
      }
      if (Object.keys(p).length === 0) return { ok: false, error: "tap: нужен ref, text, desc или x/y (fx/fy)" };
      const v = explain(await call("/tap", { params: p, signal }));
      return { ok: v.ok !== false && v.found !== false, method: v.method, error: v.ok === false || v.found === false ? (v.error || "элемент не найден") : undefined };
    }
    case "type": {
      if (args.text === undefined || args.text === null) return { ok: false, error: "type: нужен text" };
      const p = { text: String(args.text) };
      if (args.paste === true) p.mode = "paste";
      const v = explain(await call("/input", { params: p, signal }));
      return { ok: v.ok !== false, method: v.method, error: v.ok === false ? v.error : undefined };
    }
    case "scroll": {
      const v = explain(await call("/scroll", { params: { direction: String(args.direction || "down") }, signal }));
      return { ok: v.ok !== false, method: v.method, error: v.ok === false ? v.error : undefined };
    }
    case "back":
    case "home": {
      const v = explain(await call("/" + act, { signal, timeoutMs: 6000 }));
      return { ok: v.ok !== false, error: v.ok === false ? v.error : undefined };
    }
    case "swipe": {
      const p = {};
      for (const k of ["fx1", "fy1", "fx2", "fy2"]) if (args[k] !== undefined) p[k] = num(args[k]);
      if (args.durationMs !== undefined) p.duration = num(args.durationMs);
      if (!("fx1" in p && "fy1" in p && "fx2" in p && "fy2" in p)) return { ok: false, error: "swipe: нужны fx1,fy1,fx2,fy2 (доли 0..1)" };
      const v = explain(await call("/swipe", { params: p, signal, timeoutMs: 12000 }));
      return { ok: v.ok !== false, error: v.ok === false ? v.error : undefined };
    }
    default:
      return { ok: false, error: "неизвестное действие: " + act };
  }
}

export { apply, inject, name };
