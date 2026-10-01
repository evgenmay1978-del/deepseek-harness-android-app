/**
 * schedule-runner — очередь планировщика внутри движка (единственный источник правды и единственный исполнитель).
 *
 * Почему так: приложение ставит будильники в ОДИН слот (requestCode 0) — новое задание затирало прежнее,
 * отмена была меткой. Теперь все задания живут в очереди (<files>/agent-memory/schedule-queue.json),
 * а в слот приложения всегда взводится только БЛИЖАЙШЕЕ (и только если dumpsys показывает расхождение).
 *
 * Что делает тик (по умолчанию каждые 30 с):
 *   1) захват новых заданий из журнала приложения (фильтры: свои строки [q:… и заглушки noop — не берём;
 *      известные id не воскрешаем — надгробия живут в очереди);
 *   2) исполнение наступивших (в пределах maxAge) и пересчёт повторов;
 *   3) взведение ближайшего в слот приложения; пусто → заглушка на 2099 год, чтобы слот не «выстрелил» зря;
 *   4) heartbeat в файл состояния (видно, что тик живёт: ticks/lastTick/lastError/executor).
 *
 * Доставка: сначала собственный сервис ядра (ctx.get("remote").session.new|create + prompt), если он есть;
 * иначе пишем в heartbeat, что исполнитель недоступен (это видно снаружи, а не молча).
 *
 * Выключатели: DSH_SCHEDULE_RUNNER=off — выключить целиком; opts.intervalMs, opts.startupDelayMs,
 * opts.maxAgeMs, opts.arm (false — только очередь, без взведения слота).
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { watch } from "node:fs";
import { join, dirname } from "node:path";
import { detectFilesDir } from "./paths.js";
import { parseTasks, parseLiveAlarms, NOOP_TEXT, NEUTRAL_WHEN } from "./schedule.js";
import {
  emptyQueue, adopt, nearest, dueTasks, markDelivered, markNotified, rearmRepeat, prune, summary,
  markedText, splitMarker, queueId,
} from "./schedule-queue.js";

const DEFAULTS = {
  intervalMs: 30000,
  startupDelayMs: 8000,
  maxAgeMs: 24 * 3600e3,
  arm: true,
  /**
   * ИСПОЛНЕНИЕ ВЫКЛЮЧЕНО ПО УМОЛЧАНИЮ (срочное требование ревью 01.10.2026).
   * Пока нет жёсткого allowlist для сессии по расписанию и подтверждения от человека, раннер
   * только ведёт очередь и взводит ближайшую задачу («умный будильник»), но НИЧЕГО не исполняет —
   * даже если сервис сессий вдруг найдётся после обновления ядра.
   * Включать только после allowlist + подтверждения владельца. Ручной выключатель: DSH_SCHEDULE_EXECUTE=1.
   */
  execute: false,
};

const APP_LOG = "/sdcard/DeepSeekHarness/scheduled-log.txt";
const state0 = () => ({ version: 2, ticks: 0, lastTick: 0, lastError: null, executor: null, armed: null, adopted: 0, delivered: 0 });

export function installScheduleRunner(ctx, opts = {}, deps = {}) {
  if (process.env.DSH_SCHEDULE_RUNNER === "off") return undefined;
  const o = { ...DEFAULTS, ...opts };
  const log = deps.log || ((m) => (ctx.logger?.warn ? ctx.logger.warn(m) : console.warn(m)));
  const notify = deps.notify;
  const now = deps.now || (() => Date.now());
  const files = deps.filesDir || detectFilesDir();
  const journal = join(files, "scheduled-tasks.json");
  const stateFile = join(files, "agent-memory", "schedule-runner.json");
  const queueFile = join(files, "agent-memory", "schedule-queue.json");
  const readText = deps.readFile || ((p) => readFile(p, "utf8"));
  const writeText = deps.writeFile || (async (p, s) => {
    await mkdir(dirname(p), { recursive: true });
    const tmp = p + ".tmp";
    await writeFile(tmp, s, "utf8");
    await rename(tmp, p);
  });
  /** Канал к приложению (порт+токен из окружения движка): взведение слота и dumpsys. */
  const appPost = deps.appPost || (async (path, body) => {
    const port = process.env.APP_NOTIFY_PORT;
    if (!port) throw new Error("APP_NOTIFY_PORT не задан");
    const r = await fetch("http://127.0.0.1:" + port + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, token: process.env.APP_LOCAL_TOKEN }),
      signal: AbortSignal.timeout(20000),
    });
    return r.json();
  });
  let running = false;
  let pendingTick = false;   // тик, запрошенный во время работы: выполним сразу после, без параллельности

  const loadState = async () => { try { return { ...state0(), ...JSON.parse(await readText(stateFile)) }; } catch { return state0(); } };
  const loadQueue = async () => { try { return { ...emptyQueue(), ...JSON.parse(await readText(queueFile)) }; } catch { return emptyQueue(); } };

  /** Кандидаты имён сервисов ядра: переписываем в heartbeat — видно, куда стучаться (протокол версий различается). */
  // "agents" — имя, которым пользуется сам ACP-плагин ядра (ctx.agents.create/resume): это ФАКТ из кода, не догадка.
  const CANDIDATES = ["agents", "remote", "sessions", "agent", "session", "mux", "connection", "router", "protocol", "stream", "web", "server", "rpc"];
  function census() {
    const out = {};
    try { if (ctx.get) for (const k of CANDIDATES) { try { const s = ctx.get(k); if (s) out[k] = Object.keys(s).slice(0, 8).join("/"); } catch { /* нет сервиса */ } } } catch { /* нет ctx.get */ }
    try { if (ctx.remote) out["ctx.remote"] = Object.keys(ctx.remote).slice(0, 8).join("/"); } catch { /* нет */ }
    return out;
  }

  /** Исполнитель: ищем доступный сервис сессий ядра. Пробуем и «точечные», и «слэш»-методы протокола. */
  function executor() {
    const holders = [];
    try { if (ctx.get) for (const k of CANDIDATES) { try { const s = ctx.get(k); if (s) holders.push([k, s]); } catch { /* нет */ } } } catch { /* нет ctx.get */ }
    try { if (ctx.remote) holders.push(["ctx.remote", ctx.remote]); } catch { /* нет */ }
    for (const [key, holder] of holders) {
      const s = holder && holder.session ? holder.session : holder;
      const tries = [
        ["session.new", s && s.new, s && s.prompt],
        ["session.create", s && s.create, s && s.prompt],
        ["session/new", holder && holder["session/new"], holder && holder["session/prompt"]],
        ["session.create", holder && holder["session.create"], holder && holder["session.prompt"]],
      ];
      for (const [name, createFn, promptFn] of tries) {
        if (typeof createFn === "function" && typeof promptFn === "function") {
          return { name: key + "." + name, create: (a) => createFn.call(s, a), prompt: (a) => promptFn.call(s, a) };
        }
      }
    }
    return { name: null };
  }

  /** Не исполнило ли уже приложение? Его лог успеха — на внешней памяти. */
  async function appAlreadyDelivered(text) {
    try {
      const raw = await readText(APP_LOG);
      const lines = String(raw).split("\n").slice(-40);
      const tail = text.slice(0, 40);
      return lines.some((l) => l.includes("任务已发送") && l.includes(tail));
    } catch { return false; }
  }

  async function armNearest(q, state, nowMs) {
    if (!o.arm) return;
    const n = nearest(q, nowMs);
    const want = n ? { id: n.id, when: n.when } : null;
    // Взведённое состояние — и задача, и ЗАГЛУШКА (пустая очередь). Раньше при пустой очереди
    // want === null, условие не срабатывало, state.armed сбрасывался в null и заглушка ставилась
    // КАЖДЫЙ тик → приложение слало уведомление «noop (cancelled)» каждые 30 с (найдено 02.10.2026).
    const already = !!state.armed && (want
      ? state.armed.id === want.id && state.armed.when === want.when
      : state.armed.id === null);
    if (already) return; // уже взведено
    try {
      const text = n ? markedText(n.id, n.text) : NOOP_TEXT;
      const when = n ? fmt(n.when) : NEUTRAL_WHEN;
      const r = await appPost("/schedule", { text, when, repeat: "once", intervalMin: 0 });
      state.armed = want || { id: null, when: null };
      state.lastArm = { at: nowMs, ok: !!(r && r.ok), id: want ? want.id : null, when };
      log("[agent-kit] schedule-runner: взведено " + (want ? want.id + " на " + when : "заглушка"));
    } catch (e) {
      state.lastError = "взведение: " + ((e && e.message) || e);
      log("[agent-kit] schedule-runner: " + state.lastError);
    }
  }

  async function tick() {
    if (running) { pendingTick = true; return { skipped: "уже выполняется" }; }
    running = true;
    const report = { adopted: 0, due: 0, delivered: [], missed: [], errors: [] };
    const nowMs = now();
    let state = await loadState();
    try {
      const q = await loadQueue();
      let raw = "";
      try { raw = await readText(journal); } catch { raw = ""; }
      if (!String(raw).trim()) {
        // Приложение переписывает журнал с обрезкой (take/write): пустое чтение — НЕ «все задачи исчезли».
        // Даём файлу осесть и читаем ещё раз, только потом считаем журнал пустым.
        await new Promise((r) => setTimeout(r, 250));
        try { raw = await readText(journal); } catch { raw = ""; }
      }
      const lines = parseTasks(raw);
      report.adopted = adopt(q, lines, { now: nowMs });
      state.adopted += report.adopted;

      const alive = ["skip"]; // для совместимости: состояние слота берём из dumpsys ниже
      const { due, missed } = dueTasks(q, nowMs, o.maxAgeMs);
      report.due = due.length;
      report.missed = missed.map((t) => t.id);

      const executeEnabled = o.execute === true || process.env.DSH_SCHEDULE_EXECUTE === "1";
      state.execution = executeEnabled ? "вкл" : "выкл: нет allowlist и подтверждения (умный будильник)";
      const ex = executeEnabled ? executor() : { name: null };
      if (executeEnabled) { state.services = census(); state.executor = ex.name || "нет сервиса сессий"; }
      for (const t of due) {
        if (!executeEnabled) {
          // Время наступило, но автоисполнение выключено: помечаем notified (не pending и не delivered),
          // повторы пересчитываются, в списке это видно как «напоминание сработало, автоисполнение выключено».
          markNotified(q, t.id, nowMs);
          report.notified = (report.notified || []).concat(t.id);
          continue;
        }
        if (await appAlreadyDelivered(t.text)) {
          markDelivered(q, t.id, nowMs, null);
          report.delivered.push({ id: t.id, by: "app" });
          continue;
        }
        if (!ex.name) { report.errors.push({ id: t.id, error: "нет сервиса сессий ядра" }); continue; }
        try {
          const created = await ex.create({});
          const sessionId = created && (created.sessionId || created.id);
          if (!sessionId) throw new Error("создание сессии не вернуло id");
          const res = await ex.prompt({ sessionId, requestId: "sched-" + t.id + "-" + t.when, content: [{ type: "text", text: t.text }] });
          markDelivered(q, t.id, nowMs, sessionId);
          report.delivered.push({ id: t.id, sessionId, accepted: res && res.accepted });
          state.delivered++;
          try { if (notify) await notify("Отложенная задача запущена", t.text.slice(0, 120)); } catch { /* не критично */ }
        } catch (e) {
          const msg = (e && e.message) || String(e);
          report.errors.push({ id: t.id, error: msg });
          state.lastError = "доставка " + t.id + ": " + msg;
          log("[agent-kit] schedule-runner: " + state.lastError);
        }
      }
      prune(q, nowMs);
      await armNearest(q, state, nowMs);
      q.armed = state.armed;
      await writeText(queueFile, JSON.stringify(q));
      state.ticks++;
      state.lastTick = nowMs;
    } catch (e) {
      state.lastError = (e && e.message) || String(e);
      log("[agent-kit] schedule-runner: сбой проверки: " + state.lastError);
    } finally {
      try { await writeText(stateFile, JSON.stringify(state)); } catch { /* не критично */ }
      running = false;
      if (pendingTick) { pendingTick = false; const t2 = setTimeout(() => { void tick(); }, 0); t2.unref?.(); }
    }
    return report;
  }

  // Мгновенный захват: как только журнал изменился (наш инструмент ИЛИ прямой /schedule) — тик сразу,
  // не ждём 30 с. Иначе задача ближе 30 с могла сработать, пока слот занят её «сырой» версией.
  let watchHandle;
  try {
    let debounce;
    watchHandle = watch(journal, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { void tick(); }, 300);
      debounce.unref?.();
    });
    watchHandle.unref?.();
  } catch { /* журнала ещё нет или watch недоступен — остаётся обычный тик */ }

  const timer = setTimeout(() => { void tick(); }, o.startupDelayMs);
  timer.unref?.();
  const interval = setInterval(() => { void tick(); }, o.intervalMs);
  interval.unref?.();
  return { tick, interval, timer, stateFile, queueFile, journal, armNearest, stop: () => { try { watchHandle?.close(); } catch { /* уже закрыт */ } clearInterval(interval); clearTimeout(timer); } };
}

const fmt = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
};
