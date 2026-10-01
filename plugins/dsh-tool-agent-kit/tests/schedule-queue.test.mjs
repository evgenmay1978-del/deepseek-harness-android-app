import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyQueue, adopt, nearest, dueTasks, markDelivered, markNotified, cancelTask, prune, rearmRepeat,
  splitMarker, markedText, queueId, summary, NOOP_TEXT,
} from "../lib/schedule-queue.js";

const rec = (taskId, at, text, repeat = "once", intervalMin = 0) => ({ taskId, triggerAt: at, text, repeat, intervalMin });
const H = 3600e3;

test("захват берёт задачи журнала", () => {
  const q = emptyQueue();
  const n = adopt(q, [rec("task-1", 1000, "A"), rec("task-2", 2000, "B")], { now: 1 });
  assert.equal(n, 2);
  assert.equal(summary(q).pending, 2);
});

test("захват НЕ берёт свои строки взведения и заглушки", () => {
  const q = emptyQueue();
  const n = adopt(q, [rec("task-1", 1000, markedText("q-task-1", "A")), rec("task-2", 2000, NOOP_TEXT + " cleanup")], { now: 1 });
  assert.equal(n, 0);
  assert.equal(summary(q).total, 0);
});

test("отмена не воскресает при следующем захвате (надгробие)", () => {
  const q = emptyQueue();
  adopt(q, [rec("task-1", 5000, "A")], { now: 1 });
  const id = queueId("task-1");
  cancelTask(q, id, 2);
  const again = adopt(q, [rec("task-1", 5000, "A")], { now: 3 });
  assert.equal(again, 0, "отменённая задача не должна вернуться в очередь");
  assert.equal(q.tasks[id].status, "cancelled");
});

test("ближайшее: сначала по времени, при равенстве — по createdAt, затем по id", () => {
  const q = emptyQueue();
  adopt(q, [rec("task-c", 3000, "ближе всех")], { now: 3 });
  assert.equal(nearest(q, 0).text, "ближе всех");
  cancelTask(q, queueId("task-c"), 4);
  // равное время: побеждает тот, кто раньше попал в очередь (createdAt)
  adopt(q, [rec("task-b", 9000, "раньше попал")], { now: 5 });
  adopt(q, [rec("task-a", 9000, "позже попал")], { now: 6 });
  assert.equal(nearest(q, 0).originJournalId, "task-b", "при равном времени решает createdAt");
});

test("равное время и равный createdAt: решает id", () => {
  const q = emptyQueue();
  adopt(q, [rec("task-z", 7000, "z")], { now: 10 });
  adopt(q, [rec("task-a", 7000, "a")], { now: 10 });
  assert.equal(nearest(q, 0).originJournalId, "task-a");
});

test("просроченные в пределах maxAge исполняются, старше — missed без залпа", () => {
  const q = emptyQueue();
  adopt(q, [rec("t-old", 1000, "старая"), rec("t-new", 10 * H, "свежая")], { now: 0 });
  const { due, missed } = dueTasks(q, 10 * H + 1000, 5 * H);
  assert.deepEqual(due.map((t) => t.originJournalId), ["t-new"]);
  assert.deepEqual(missed.map((t) => t.originJournalId), ["t-old"]);
  assert.equal(q.tasks[queueId("t-old")].status, "missed");
});

test("повторы: daily = прежнее + 24 ч, interval = now + interval", () => {
  const q = emptyQueue();
  adopt(q, [rec("t-d", 0, "ежедневно", "daily")], { now: 0 });
  const d = markDelivered(q, queueId("t-d"), 24 * H + 5);
  assert.equal(d.status, "pending");
  assert.equal(d.when, 48 * H);
  adopt(q, [rec("t-i", 0, "каждые 30 мин", "interval", 30)], { now: 0 });
  const i = markDelivered(q, queueId("t-i"), 5 * H);
  assert.equal(i.when, 5 * H + 30 * 60e3);
});

test("once после исполнения — delivered, и повторный захват не воскрешает", () => {
  const q = emptyQueue();
  adopt(q, [rec("t-1", 100, "разово")], { now: 0 });
  assert.equal(markDelivered(q, queueId("t-1"), 200).status, "delivered");
  assert.equal(adopt(q, [rec("t-1", 100, "разово")], { now: 300 }), 0);
});

test("чистка надгробий по времени, ожидающие не трогаются", () => {
  const q = emptyQueue();
  adopt(q, [rec("t-1", 1e6, "живая")], { now: 0 });
  cancelTask(q, queueId("t-1"), 0);
  adopt(q, [rec("t-2", 1e6, "тоже живая")], { now: 0 });
  const removed = prune(q, 8 * 24 * H);
  assert.equal(removed, 1);
  assert.equal(summary(q).pending, 1);
});

test("автоисполнение выключено: наступившая задача → notified, повторы пересчитаны", () => {
  const q = emptyQueue();
  adopt(q, [rec("t-1", 100, "разово"), rec("t-2", 100, "каждый день", "daily")], { now: 0 });
  const a = markNotified(q, queueId("t-1"), 200);
  assert.equal(a.status, "notified", "разовая уходит в notified, а не pending и не delivered");
  const b = markNotified(q, queueId("t-2"), 200);
  assert.equal(b.status, "pending", "повтор остаётся живым");
  assert.ok(b.when > 200, "и получает новое будущее время");
  assert.equal(summary(q).pending, 1);
});

test("маркер [q:id] разбирается и не течёт в текст", () => {
  assert.deepEqual(splitMarker(markedText("q-1", "привет")), { id: "q-1", text: "привет" });
  assert.deepEqual(splitMarker("обычный текст"), { id: null, text: "обычный текст" });
});
