// Регистрация android_schedule_list / android_schedule_cancel.
// Подключение: в apply(ctx) kit вызывается registerScheduleTools(ctx).
//
// Проверено 30.09.2026:
//  - detectFilesDir() в нашем kit — синхронная функция (env → каталог с payload/ → вложенный с dshhome → константа),
//    но await на ней безопасен; возвращает каталог приложения files/;
//  - местный HTTP приложения: /schedule НЕ проверяет token (поля text/when/repeat/intervalMin, см. MainActivity.handleScheduleRequest),
//    token нужен только для /shell — там он обязателен.
import { defineTool } from "@deepseek-ai/dsh-tools";
import { detectFilesDir } from "./paths.js";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { listTasks, cancelTask, parseMarkers, emptyMarkers } from "./schedule.js";
import { emptyQueue, cancelTask as queueCancel } from "./schedule-queue.js";

const okOutput = (extra = {}) => ({
  type: "object",
  additionalProperties: false,
  properties: { ok: { type: "boolean", required: true }, error: { type: "string" }, text: { type: "string" }, ...extra },
});
const renderText = (_a, v) => {
  if (!v || typeof v !== "object") return [{ type: "text", text: "Инструмент не вернул результат" }];
  return [{ type: "text", text: (v.ok ? "" : "Не удалось: " + (v.error || "неизвестная ошибка") + "\n\n") + (v.text || "") }];
};

export async function appPost(path, body, signal) {
  const port = process.env.APP_NOTIFY_PORT;
  if (!port) throw new Error("APP_NOTIFY_PORT не задан");
  const r = await fetch("http://127.0.0.1:" + port + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, token: process.env.APP_LOCAL_TOKEN }),
    signal: signal ?? AbortSignal.timeout(20000),
  });
  return r.json();
}

export async function makeDeps(exec) {
  const dir = detectFilesDir();
  if (!dir) throw new Error("не найден каталог files приложения");
  const tasks = join(dir, "scheduled-tasks.json");
  const markerFile = join(dir, "scheduled-cancelled.json"); // наш файл; приложение его не трогает
  return {
    now: () => Date.now(),
    readTasks: () => readFile(tasks, "utf8"),
    // ВАЖНО: канал /shell усекает stdout до 8000 символов (проверено 30.09.2026): полный «dumpsys alarm» приходит
    // обрезанным и нашего пакета в нём нет. Поэтому фильтруем на стороне shell: строка будильника + строка с tag.
    dumpsys: async () => {
      const r = await appPost("/shell", { command: "dumpsys alarm | grep -A1 com.deepseek.harness", timeout_ms: 15000 }, exec?.signal);
      return r && r.ok ? String(r.stdout || "") : null;
    },
    schedulePost: args => appPost("/schedule", args, exec?.signal),
    readMarkers: async () => {
      try { return parseMarkers(await readFile(markerFile, "utf8")); } catch { return emptyMarkers(); }
    },
    writeMarkers: async (markers) => {
      const tmp = markerFile + ".tmp";
      await writeFile(tmp, JSON.stringify(markers));
      await rename(tmp, markerFile);
    },
  };
}

export function registerScheduleTools(ctx) {
  ctx.tools.register(defineTool({
    name: "android_schedule_list",
    description:
      "Показывает задачи планировщика из журнала и сверяет их с реальными будильниками (dumpsys alarm). " +
      "Из /schedule живёт один будильник — последний созданный; у остальных статус no-alarm.",
    parameters: { include_past: { type: "boolean", description: "Показать и прошедшие" } },
    output: { schema: okOutput({ total: { type: "number" } }), render: renderText },
    async execute(args, exec) {
      try { return await listTasks(await makeDeps(exec), { includePast: !!args.include_past }); }
      catch (e) { return { ok: false, error: e.message }; }
    },
  }));

  ctx.tools.register(defineTool({
    name: "android_schedule_cancel",
    description:
      "Отменяет задачу планировщика по id. Задача снимается и с журнала, и с ОЧЕРЕДИ (источник правды), " +
      "поэтому захват её больше не подберёт, а слот будильника на следующем тике перезаймёт ближайшая живая задача.",
    parameters: { id: { type: "string", required: true, description: "taskId из android_schedule_list" } },
    output: { schema: okOutput({ guaranteed: { type: "boolean" }, queue: { type: "boolean" } }), render: renderText },
    async execute(args, exec) {
      try {
        const res = await cancelTask(await makeDeps(exec), args.id);
        let queueHit = false, queueError = null;
        try {
          const dir = detectFilesDir();
          const qf = join(dir, "agent-memory", "schedule-queue.json");
          let q;
          try { q = { ...emptyQueue(), ...JSON.parse(await readFile(qf, "utf8")) }; } catch { q = emptyQueue(); }
          const hit = queueCancel(q, "q-" + args.id, Date.now()) || queueCancel(q, args.id, Date.now());
          if (hit) {
            queueHit = true;
            await writeFile(qf + ".tmp", JSON.stringify(q), "utf8");
            await rename(qf + ".tmp", qf);
          }
        } catch (e2) { queueError = String((e2 && e2.message) || e2); }
        return { ...res, guaranteed: true, queue: queueHit, ...(queueError ? { queueError } : {}) };
      } catch (e) { return { ok: false, error: e.message }; }
    },
  }));
}

