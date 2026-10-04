import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSelfCheck } from "../lib/self-check.js";
import { readInjectionLog } from "../lib/memory.js";

/**
 * Прогон самопроверки без таймера: run() — это ровно то, что выполняется через delayMs после старта.
 * delayMs намеренно большой, чтобы setTimeout не дописал вторую строку поверх проверяемой.
 */
function runSelfCheck(makeInjectionLog) {
  const files = mkdtempSync(join(tmpdir(), "sc-"));
  mkdirSync(join(files, "agent-memory"), { recursive: true });
  const lines = [];
  const opts = {
    filesDir: files, log: (m) => lines.push(m), logFile: true,
    tools: ["agent_memory"], memoryCount: () => 0, delayMs: 600000
  };
  if (makeInjectionLog) opts.injectionLog = makeInjectionLog(files);
  const sc = installSelfCheck({ tools: { get: () => ({}) }, logger: { warn() {} } }, opts);
  assert.ok(sc && typeof sc.run === "function", "installSelfCheck вернул run()");
  sc.run();
  return { files, lines };
}

test("self-check: журнала нет — «инъекций до старта не было», строка всё равно пишется", () => {
  const { files, lines } = runSelfCheck((f) => () => readInjectionLog(join(f, "agent-memory", "injection-log.json")));
  assert.equal(lines.length, 1, "ровно одна строка самопроверки");
  assert.match(lines[0], /самопроверка/);
  assert.match(lines[0], /инструменты 1\/1/, "секция инструментов на месте");
  assert.match(lines[0], /скиллов на диске/, "секция скиллов на месте");
  assert.match(lines[0], /инъекций ДО СТАРТА не было/, "отсутствие журнала — не ошибка");
  const logFile = join(files, "agent-memory", "self-check.log");
  assert.ok(existsSync(logFile), "строка записана в self-check.log");
  assert.match(readFileSync(logFile, "utf8"), /инъекций ДО СТАРТА не было/);
});

test("self-check: битый JSON журнала — «инъекций до старта не было», не исключение", () => {
  const { lines } = runSelfCheck((f) => () => {
    writeFileSync(join(f, "agent-memory", "injection-log.json"), "{ это не json", "utf8");
    return readInjectionLog(join(f, "agent-memory", "injection-log.json"));
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /инъекций ДО СТАРТА не было/);
});

test("self-check: падение чтения журнала не съедает остальные секции (регресс 04.10.2026)", () => {
  // Причина пропажи всей строки: arrow ссылалась на block-scoped store → ReferenceError.
  const { lines } = runSelfCheck(() => () => { throw new ReferenceError("store is not defined"); });
  assert.equal(lines.length, 1, "строка всё равно одна");
  assert.match(lines[0], /инъекция: НЕ УДАЛОСЬ \(store is not defined\)/, "сломанная секция подписана");
  assert.match(lines[0], /инструменты 1\/1/, "инструменты не потеряны");
  assert.match(lines[0], /скиллов на диске/, "скиллы не потеряны");
});

test("self-check: запись журнала показывается как «последняя инъекция ДО СТАРТА» с via/qlen", () => {
  const rec = { at: "2026-10-04T18:23:15.725Z", turn: 34, step: 1, branch: "standard", via: "fallback", qlen: 12, keys: ["m1:1"], size: 975, cap: 1800 };
  const { lines } = runSelfCheck((f) => () => {
    writeFileSync(join(f, "agent-memory", "injection-log.json"), JSON.stringify([rec]), "utf8");
    return readInjectionLog(join(f, "agent-memory", "injection-log.json"));
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /последняя инъекция ДО СТАРТА: 2026-10-04T18:23:15\.725Z standard via fallback \(запрос 12 симв\) 1 шт, 975\/1800/);
});
