/**
 * schedule-queue — очередь планировщика: ЕДИНСТВЕННЫЙ источник правды.
 *
 * Зачем: приложение ставит будильники в один слот (requestCode 0), поэтому каждое новое задание
 * затирало предыдущее, а отмена была лишь меткой. Здесь мы держим ВСЕ задания сами и всегда
 * взводим в слот только ближайшее.
 *
 * Инварианты:
 *  - задание, однажды попавшее в очередь, узнаётся по originJournalId в ЛЮБОМ статусе:
 *    отменённое/исполненное не «воскресает» при следующем захвате журнала (надгробия);
 *  - строки, которые мы сами пишем при взведении (маркер [q:<id>]), и заглушки noop не захватываются;
 *  - порядок при равном времени: createdAt, затем id (детерминированно).
 *
 * Модуль чистый: время и ввод-вывод передаются снаружи, поэтому тестируется офлайн.
 */
export const QUEUE_VERSION = 1;
export const MARKER_PREFIX = "[q:";
export const NOOP_TEXT = "noop (cancelled)";
export const TOMBSTONE_TTL_MS = 7 * 24 * 3600e3;

export const emptyQueue = () => ({ version: QUEUE_VERSION, tasks: {}, updatedAt: 0 });

export const queueId = (journalId) => "q-" + String(journalId);

/** "…[q:q-task-123] текст" → { id: "q-task-123", text: "текст" }; без маркера — id=null. */
export function splitMarker(text) {
  const s = String(text ?? "");
  if (!s.startsWith(MARKER_PREFIX)) return { id: null, text: s };
  const end = s.indexOf("]");
  if (end < 0) return { id: null, text: s };
  return { id: s.slice(MARKER_PREFIX.length, end), text: s.slice(end + 1).trim() };
}

export const markedText = (id, text) => MARKER_PREFIX + id + "] " + String(text ?? "");

/**
 * Захват записей журнала приложения в очередь.
 * Возвращает число добавленных. Ничего не воскрешает (см. инвариант 1) и не берёт свои же строки.
 */
export function adopt(q, records, { now = 0 } = {}) {
  let added = 0;
  for (const r of records || []) {
    if (!r || !r.taskId) continue;
    const text = String(r.text ?? "");
    if (splitMarker(text).id) continue;          // наша строка взведения — не захватываем
    if (text.startsWith(NOOP_TEXT)) continue;    // служебная заглушка
    const id = queueId(r.taskId);
    if (q.tasks[id]) continue;                   // знаем в любом статусе: надгробие держит
    q.tasks[id] = {
      id,
      originJournalId: r.taskId,
      text,
      when: Number(r.triggerAt) || 0,
      repeat: r.repeat || "once",
      intervalMin: Number(r.intervalMin) || 0,
      createdAt: now,
      status: "pending",
    };
    added++;
  }
  q.updatedAt = now;
  return added;
}

const pending = (q) => Object.values(q.tasks).filter((t) => t.status === "pending");

/** Ближайшее ожидающее задание (порядок: when, createdAt, id). */
export function nearest(q, now = 0) {
  const list = pending(q)
    .filter((t) => t.when >= now)
    .sort((a, b) => a.when - b.when || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  return list[0];
}

/**
 * Задания к исполнению: срок наступил и опоздание в пределах maxAge.
 * Просроченные сильнее maxAge не исполняются «залпом»: помечаются missed и пересчитываются на будущее.
 */
export function dueTasks(q, now = 0, maxAgeMs = 24 * 3600e3) {
  const due = [];
  const missed = [];
  for (const t of pending(q).sort((a, b) => a.when - b.when || a.createdAt - b.createdAt)) {
    if (t.when > now) continue;
    if (now - t.when > maxAgeMs) { missed.push(t); continue; }
    due.push(t);
  }
  for (const t of missed) {
    t.status = "missed";
    t.missedAt = now;
    rearmRepeat(t, now);
  }
  return { due, missed };
}

/** Следующее время для повторов: daily = прежнее + 24 ч (подтянуть до будущего), interval = now + interval. */
export function rearmRepeat(task, now = 0) {
  if (!task || task.repeat === "once" || task.status === "cancelled") return task;
  if (task.repeat === "daily") {
    let next = task.when + 24 * 3600e3;
    while (next <= now) next += 24 * 3600e3;
    task.when = next;
  } else if (task.repeat === "interval" && task.intervalMin > 0) {
    task.when = now + task.intervalMin * 60e3;
  }
  task.status = "pending";
  return task;
}

/**
 * Наступило время, но автоисполнение выключено: отдельный статус, а не pending и не delivered.
 * Иначе слот перевзводится на прошедшую задачу, а список врёт. Повторы пересчитываются.
 */
export function markNotified(q, id, now = 0) {
  const t = q.tasks[id];
  if (!t) return null;
  t.notifiedAt = now;
  if (t.repeat === "once") t.status = "notified";
  else rearmRepeat(t, now);
  q.updatedAt = now;
  return t;
}

/** Исполнено: once → delivered, повторы → снова pending с новым временем. */
export function markDelivered(q, id, now = 0, sessionId = null) {
  const t = q.tasks[id];
  if (!t) return null;
  t.deliveredAt = now;
  t.sessionId = sessionId || t.sessionId || null;
  if (t.repeat === "once") t.status = "delivered";
  else rearmRepeat(t, now);
  q.updatedAt = now;
  return t;
}

/** Настоящая отмена: снять из очереди и оставить надгробие, чтобы захват не вернул задание. */
export function cancelTask(q, id, now = 0) {
  const t = q.tasks[id] || Object.values(q.tasks).find((x) => x.originJournalId === id);
  if (!t) return null;
  t.status = "cancelled";
  t.cancelledAt = now;
  q.updatedAt = now;
  if (q.armed === t.id) q.armed = null;
  return t;
}

/** Чистка старых надгробий (cancelled/missed/delivered) — журнал очереди не должен расти вечно. */
export function prune(q, now = 0, ttl = TOMBSTONE_TTL_MS) {
  let removed = 0;
  for (const [id, t] of Object.entries(q.tasks)) {
    if (t.status === "pending") continue;
    const at = t.cancelledAt || t.missedAt || t.deliveredAt || t.createdAt || 0;
    if (now - at > ttl) { delete q.tasks[id]; removed++; }
  }
  if (removed) q.updatedAt = now;
  return removed;
}

export const summary = (q) => {
  const all = Object.values(q.tasks);
  return {
    total: all.length,
    pending: all.filter((t) => t.status === "pending").length,
    cancelled: all.filter((t) => t.status === "cancelled").length,
    delivered: all.filter((t) => t.status === "delivered").length,
    missed: all.filter((t) => t.status === "missed").length,
    armed: q.armed || null,
  };
};
