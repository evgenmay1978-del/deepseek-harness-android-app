import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog, catalogPrompt, matchTriggers, installSkillCatalog } from "../lib/skill-catalog.js";

const FILES = {
  "/skills/diagnosing-bugs/SKILL.md": "---\nname: diagnosing-bugs\ndescription: Диагностика сложных багов\ntriggers: [баг, не работает, diagnose]\n---\nПОЛНЫЙ ТЕКСТ ПРО ДИАГНОСТИКУ",
  "/skills/tdd.md": "---\nname: tdd\ndescription: Разработка через тесты\ntriggers: [тест, tdd]\n---\nПОЛНЫЙ ТЕКСТ ПРО TDD",
};
const deps = {
  list: (d) => (d === "/skills" ? ["diagnosing-bugs", "tdd.md"] : []),
  isDir: (p) => p === "/skills/diagnosing-bugs",
  read: (p) => FILES[p] ?? (() => { throw new Error("нет файла " + p); })(),
};

test("каталог собирается и содержит только имя с описанием", () => {
  const c = buildCatalog(["/skills"], deps);
  assert.equal(c.length, 2);
  const p = catalogPrompt(c);
  assert.match(p, /diagnosing-bugs/);
  assert.ok(!p.includes("ПОЛНЫЙ ТЕКСТ"), "полный текст в контекст не попадает");
});

test("триггеры находят нужный навык", () => {
  const c = buildCatalog(["/skills"], deps);
  const hits = matchTriggers(c, "у меня не работает маршрутизация, помоги");
  assert.equal(hits[0].name, "diagnosing-bugs");
});

test("skill_load отдаёт полный текст и пишет факт загрузки", () => {
  const sc = installSkillCatalog(null, { dirs: ["/skills"], deps, registerTool: false });
  const r = sc.load("tdd");
  assert.equal(r.ok, true);
  assert.match(r.text, /ПОЛНЫЙ ТЕКСТ ПРО TDD/);
  assert.equal(sc.loaded()[0].name, "tdd");
});

test("неизвестный навык даёт ошибку, а не пустоту", () => {
  const sc = installSkillCatalog(null, { dirs: ["/skills"], deps, registerTool: false });
  const r = sc.load("нет-такого");
  assert.equal(r.ok, false);
  assert.match(r.error, /не найден/);
});
