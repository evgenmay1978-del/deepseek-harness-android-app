import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, slide, writeHandoff, readHandoff, handoffPreamble } from "../lib/context-handoff.js";

test("выжимка раскладывает строки по категориям", () => {
  const d = digest(["решили: используем FTS5", "факт: индекс пересобирается", "ошибка: тест падал на deps", "осталось: шаг 5 и 6"]);
  assert.equal(d.decisions.length, 1);
  assert.equal(d.facts.length, 1);
  assert.equal(d.errors.length, 1);
  assert.equal(d.open.length, 1);
});

test("скользящее окно: хвост дословно, голова свёрнута", () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({ text: (i < 14 ? "решили: шаг " + i : "ход " + i) }));
  const s = slide(turns, { keepTail: 6, maxChars: 4000 });
  assert.equal(s.tail.length, 6);
  assert.equal(s.collapsed, 14);
  assert.match(s.text, /сводка предыдущих 14 ходов/);
  assert.match(s.text, /ход 19/, "последние ходы остаются дословно");
  assert.ok(!s.text.includes("ход 3"), "старые ходы в текст не попадают");
});

test("handoff пишется и читается, вводная собирается", () => {
  const dir = mkdtempSync(join(tmpdir(), "ho-"));
  writeHandoff(dir, { task: "память и контекст", done: ["индекс FTS5"], open: ["шаг 5"], keys: ["proj.build_cmd"], next: "сводка + handoff" });
  const st = readHandoff(dir);
  assert.equal(st.task, "память и контекст");
  const pre = handoffPreamble(st);
  assert.match(pre, /Сделано: индекс FTS5/);
  assert.match(pre, /Следующий шаг: сводка \+ handoff/);
});

test("нет handoff — пустая вводная, без падения", () => {
  const dir = mkdtempSync(join(tmpdir(), "ho-"));
  assert.equal(readHandoff(dir), null);
  assert.equal(handoffPreamble(null), "");
});
