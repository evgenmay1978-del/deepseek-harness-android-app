import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMemoryConsolidate } from "../lib/memory-consolidate-runner.js";

const note = (id, key, updated, body) => ["---", "id: " + id, "key: " + key, "updated: " + updated, "---", body].join(String.fromCharCode(10));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cons-"));
  writeFileSync(join(dir, "old.md"), note("n1", "build", "2026-09-01", "старая сборка"));
  writeFileSync(join(dir, "new.md"), note("n2", "build", "2026-10-01", "новая сборка"));
  return dir;
}

test("по умолчанию только отчёт: файлы не меняются", () => {
  const dir = setup();
  const before = readFileSync(join(dir, "new.md"), "utf8");
  const r = installMemoryConsolidate(null, { dirs: [dir], reportPath: join(dir, "report.json") });
  const rep = r.runOnce({ apply: true });          // даже с apply: dryRun по умолчанию запрещает запись
  assert.equal(rep.dryRun, true);
  assert.ok(rep.dirs[0].groups >= 1, "дубли по ключу найдены");
  assert.equal(rep.dirs[0].applied, 0, "ничего не применено");
  assert.equal(readFileSync(join(dir, "new.md"), "utf8"), before, "файл не изменён");
  r.stop();
});

test("человеческий каталог не трогается даже в режиме применения", () => {
  const dir = setup();
  const before = readFileSync(join(dir, "new.md"), "utf8");
  const r = installMemoryConsolidate(null, { dirs: [dir], humanDirs: [dir], dryRun: false });
  const rep = r.runOnce({ apply: true });
  assert.equal(rep.dirs[0].human, true);
  assert.match(rep.dirs[0].mode, /человеческий/);
  assert.equal(readFileSync(join(dir, "new.md"), "utf8"), before, "человеческий каталог не изменён");
  r.stop();
});

test("агентский каталог консолидируется при dryRun=false", () => {
  const dir = setup();
  const r = installMemoryConsolidate(null, { dirs: [dir], dryRun: false, reportPath: join(dir, "report.json") });
  const rep = r.runOnce({ apply: true });
  assert.equal(rep.dirs[0].applied, 1, "одна группа применена");
  const after = readFileSync(join(dir, "new.md"), "utf8");
  assert.match(after, /supersedes/, "актуальная запись получила supersedes");
  assert.ok(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")).dirs.length === 1, "отчёт записан");
  r.stop();
});

test("каталог отчёта создаётся, отчёт не теряется", () => {
  const dir = setup();
  const nested = join(dir, "logs", "sub", "report.json");
  const r = installMemoryConsolidate(null, { dirs: [dir], reportPath: nested });
  r.runOnce();
  assert.ok(readFileSync(nested, "utf8").includes("dryRun"), "отчёт записан в созданный каталог");
  r.stop();
});

test("консолидация запускается таймером движка и корректно останавливается", () => {
  const dir = setup();
  const r = installMemoryConsolidate(null, { dirs: [dir], intervalMs: 50 });
  assert.equal(typeof r.stop, "function");
  assert.equal(r.last, null, "до первого прохода отчёта нет");
  r.runOnce();
  assert.ok(r.last && r.last.dirs.length === 1, "проход отработал");
  r.stop();
});
