import { test } from "node:test";
import assert from "node:assert/strict";
import { installScheduleRunner } from "../lib/schedule-runner.js";

const mkFs = (files) => {
  const mem = new Map(Object.entries(files));
  return {
    mem,
    readFile: async (p) => { if (mem.has(p)) return mem.get(p); throw new Error("нет файла: " + p); },
    writeFile: async (p, s) => { mem.set(p, s); },
  };
};

test("выключатель: при execute:false исполнитель НЕ вызывается, задача → notified", async () => {
  const fs = mkFs({ "/app/scheduled-tasks.json": "task-1|1000|once|0|напоминание\n" });
  let created = 0, prompted = 0, armed = 0;
  const ctx = {
    logger: { warn() {} },
    get: (name) => (name === "agents" ? { create: async () => { created++; return { sessionId: "s1" }; }, prompt: async () => { prompted++; return { accepted: true }; } } : undefined),
  };
  const h = installScheduleRunner(ctx, { execute: false, intervalMs: 3600e3, startupDelayMs: 3600e3 }, {
    filesDir: "/app",
    now: () => 2000,
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    appPost: async () => { armed++; return { ok: true }; },
    notify: async () => {},
  });
  const rep = await h.tick();
  clearInterval(h.interval); clearTimeout(h.timer);
  assert.equal(created, 0, "сервис сессий не должен дёргаться при выключенном исполнении");
  assert.equal(prompted, 0, "промпт не должен отправляться");
  assert.deepEqual(rep.notified, ["q-task-1"], "задача помечена как уведомлённая");
  const q = JSON.parse(fs.mem.get("/app/agent-memory/schedule-queue.json"));
  assert.equal(Object.values(q.tasks)[0].status, "notified");
  assert.ok(armed > 0, "слот при этом взводится — режим «умный будильник»");
  const st = JSON.parse(fs.mem.get("/app/agent-memory/schedule-runner.json"));
  assert.match(String(st.execution), /выкл/, "в heartbeat видно, что исполнение выключено");
});

test("выключатель: при execute:true исполнитель вызывается (для будущего этапа)", async () => {
  const fs = mkFs({ "/app/scheduled-tasks.json": "task-1|1000|once|0|задача\n" });
  let prompted = 0;
  const ctx = {
    logger: { warn() {} },
    get: (name) => (name === "agents" ? { create: async () => ({ sessionId: "s1" }), prompt: async () => { prompted++; return { accepted: true }; } } : undefined),
  };
  const h = installScheduleRunner(ctx, { execute: true, intervalMs: 3600e3, startupDelayMs: 3600e3 }, {
    filesDir: "/app", now: () => 2000, readFile: fs.readFile, writeFile: fs.writeFile,
    appPost: async () => ({ ok: true }), notify: async () => {},
  });
  await h.tick();
  clearInterval(h.interval); clearTimeout(h.timer);
  assert.equal(prompted, 1, "с включённым флагом исполнитель работает");
});

test("пустая очередь: заглушка в слот ставится ОДИН раз, а не каждый тик (регресс 02.10.2026)", async () => {
  // Причина: при пустой очереди state.armed сбрасывался в null и armNearest постил /schedule каждый тик;
  // приложение на каждый вызов показывает уведомление → «noop (cancelled)» каждые 30 с в ленте владельца.
  const fs = mkFs({});
  let armed = 0;
  const h = installScheduleRunner({ logger: { warn() {} }, get: () => undefined },
    { execute: false, intervalMs: 3600e3, startupDelayMs: 3600e3 },
    { filesDir: "/app", now: () => 2000, readFile: fs.readFile, writeFile: fs.writeFile,
      appPost: async () => { armed++; return { ok: true }; }, notify: async () => {} });
  await h.tick();
  await h.tick();
  h.stop();
  assert.equal(armed, 1, "заглушка должна ставиться один раз: иначе уведомление каждые 30 секунд");
  const st = JSON.parse(fs.mem.get("/app/agent-memory/schedule-runner.json"));
  assert.deepEqual(st.armed, { id: null, when: null }, "состояние «заглушка взведена» сохраняется в heartbeat");
});

test("цепочка повторов (тот же taskId, новое время) не даёт дубль в очереди", async () => {
  const fs = mkFs({ "/app/scheduled-tasks.json": "task-9|1000|daily|0|цепочка\n" });
  const h = installScheduleRunner({ logger: { warn() {} }, get: () => undefined },
    { execute: false, intervalMs: 3600e3, startupDelayMs: 3600e3 },
    { filesDir: "/app", now: () => 2000, readFile: fs.readFile, writeFile: fs.writeFile, appPost: async () => ({ ok: true }), notify: async () => {} });
  await h.tick();
  // AlarmReceiver переписал ту же задачу с новым временем — это НЕ новая задача
  fs.mem.set("/app/scheduled-tasks.json", "task-9|1000|daily|0|цепочка\ntask-9|9000000|daily|0|цепочка\n");
  await h.tick();
  h.stop();
  const q = JSON.parse(fs.mem.get("/app/agent-memory/schedule-queue.json"));
  assert.equal(Object.keys(q.tasks).length, 1, "дубль цепочки не должен появиться в очереди");
});

test("при execute:false сервисы ядра вообще не опрашиваются", async () => {
  const fs = mkFs({ "/app/scheduled-tasks.json": "task-1|1000|once|0|задача\n" });
  let gets = 0;
  const h = installScheduleRunner({ logger: { warn() {} }, get: () => { gets++; return undefined; } },
    { execute: false, intervalMs: 3600e3, startupDelayMs: 3600e3 },
    { filesDir: "/app", now: () => 2000, readFile: fs.readFile, writeFile: fs.writeFile, appPost: async () => ({ ok: true }), notify: async () => {} });
  await h.tick();
  h.stop();
  assert.equal(gets, 0, "ctx.get не должен вызываться при выключенном исполнении");
});

test("нет самозацикливания: после взведения повторный тик не дёргает /schedule", async () => {
  const fs2 = mkFs({ "/app/scheduled-tasks.json": "task-1|9000000|once|0|задача\n" });
  let arms = 0;
  const h = installScheduleRunner({ logger: { warn() {} }, get: () => undefined },
    { execute: false, intervalMs: 3600e3, startupDelayMs: 3600e3 },
    { filesDir: "/app", now: () => 2000, readFile: fs2.readFile, writeFile: fs2.writeFile,
      appPost: async () => { arms++; return { ok: true }; }, notify: async () => {} });
  await h.tick();
  const afterFirst = arms;
  await h.tick();
  h.stop();
  assert.ok(afterFirst > 0, "первый тик взводит слот");
  assert.equal(arms, afterFirst, "второй тик не должен перевзводить то же самое");
});

test("тики сериализованы: одновременный запуск не взводит дважды", async () => {
  const fs3 = mkFs({ "/app/scheduled-tasks.json": "task-1|9000000|once|0|задача\n" });
  let arms = 0;
  const h = installScheduleRunner({ logger: { warn() {} }, get: () => undefined },
    { execute: false, intervalMs: 3600e3, startupDelayMs: 3600e3 },
    { filesDir: "/app", now: () => 2000, readFile: fs3.readFile, writeFile: fs3.writeFile,
      appPost: async () => { arms++; return { ok: true }; }, notify: async () => {} });
  const [r1, r2] = await Promise.all([h.tick(), h.tick()]);
  h.stop();
  assert.ok(r1.skipped || r2.skipped, "второй одновременный тик должен быть пропущен");
  assert.equal(arms, 1, "взведение должно быть ровно одно");
});

test("пустое чтение журнала не считается «задачи исчезли» — чтение повторяется", async () => {
  const mem = new Map([["/app/agent-memory/schedule-queue.json", JSON.stringify({ version: 1, tasks: {}, updatedAt: 0 })]]);
  let reads = 0;
  const readFile = async (f) => {
    if (f === "/app/scheduled-tasks.json") { reads++; return reads === 1 ? "" : "task-7|9000000|once|0|поздняя\n"; }
    if (mem.has(f)) return mem.get(f);
    throw new Error("нет файла: " + f);
  };
  const h = installScheduleRunner({ logger: { warn() {} }, get: () => undefined },
    { execute: false, intervalMs: 3600e3, startupDelayMs: 3600e3 },
    { filesDir: "/app", now: () => 2000, readFile, writeFile: async (f, s) => { mem.set(f, s); },
      appPost: async () => ({ ok: true }), notify: async () => {} });
  await h.tick();
  h.stop();
  assert.ok(reads >= 2, "при пустом чтении должен быть повтор");
  const q = JSON.parse(mem.get("/app/agent-memory/schedule-queue.json"));
  assert.equal(Object.keys(q.tasks).length, 1, "задача не потеряна из-за обрезки файла");
});

test("armNearest форматирует «when» (путь fmt — раньше стоял ниже объявления)", async () => {
  // Будущая задача остаётся pending → nearest вернёт её, и when пойдёт через fmt (а не NEUTRAL_WHEN).
  const fs = mkFs({ "/app/scheduled-tasks.json": "task-1|9999999999999|once|0|напоминание\n" });
  let posted = null;
  const ctx = { logger: { warn() {} }, get: () => undefined };
  const h = installScheduleRunner(ctx, { execute: false, intervalMs: 3600e3, startupDelayMs: 3600e3 }, {
    filesDir: "/app", now: () => 2000, readFile: fs.readFile, writeFile: fs.writeFile,
    appPost: async (_p, body) => { posted = body; return { ok: true }; }, notify: async () => {},
  });
  await h.tick();
  clearInterval(h.interval); clearTimeout(h.timer);
  assert.ok(posted, "слот взведён через armNearest");
  assert.match(String(posted.when), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "when в формате fmt: " + posted.when);
});
