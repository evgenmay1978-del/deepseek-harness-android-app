import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consolidate, plan, scan } from "../lib/memory-consolidate.js";

const setup = (files) => {
  const d = mkdtempSync(join(tmpdir(), "cons-"));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  return d;
};

test("дубли по ключу: побеждает свежая запись", () => {
  const d = setup({
    "old.md": "---\nid: old\nkey: proj.build\nupdated: 2026-01-01\n---\nстарый способ",
    "new.md": "---\nid: new\nkey: proj.build\nupdated: 2026-10-01\n---\nновый способ",
  });
  const g = plan(scan(d));
  assert.equal(g.length, 1);
  assert.equal(g[0].winnerId, "new");
  assert.deepEqual(g[0].lesers ?? g[0].losers, ["old"]);
});

test("dryRun даёт отчёт и не трогает файлы", () => {
  const d = setup({
    "old.md": "---\nid: old\nkey: k\nupdated: 2026-01-01\n---\nстарое",
    "new.md": "---\nid: new\nkey: k\nupdated: 2026-10-01\n---\nновое",
  });
  const before = readFileSync(join(d, "new.md"), "utf8");
  const rep = consolidate(d, { dryRun: true });
  assert.equal(rep.groups, 1);
  assert.equal(rep.changed[0].applied, false);
  assert.equal(readFileSync(join(d, "new.md"), "utf8"), before, "файл не изменён");
});

test("применение проставляет supersedes и идемпотентно", () => {
  const d = setup({
    "old.md": "---\nid: old\nkey: k\nupdated: 2026-01-01\n---\nстарое",
    "new.md": "---\nid: new\nkey: k\nupdated: 2026-10-01\n---\nновое",
  });
  const r1 = consolidate(d, { dryRun: false });
  assert.equal(r1.changed[0].applied, true);
  assert.match(readFileSync(join(d, "new.md"), "utf8"), /supersedes: \[old\]/);
  const r2 = consolidate(d, { dryRun: false });
  assert.equal(r2.changed.length, 0, "повторный прогон ничего не меняет");
});

test("одиночные записи не трогаются", () => {
  const d = setup({ "one.md": "---\nid: one\nkey: solo\nupdated: 2026-10-01\n---\nединственная" });
  const r = consolidate(d, { dryRun: false });
  assert.equal(r.groups, 0);
  assert.equal(r.changed.length, 0);
});
