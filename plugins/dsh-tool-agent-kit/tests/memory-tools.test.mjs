import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMemoryIndex } from "../lib/memory-tools.js";

test("индекс собирается из каталога и отдаёт результаты поиска", () => {
  const d = mkdtempSync(join(tmpdir(), "mem-"));
  writeFileSync(join(d, "a.md"), "---\nid: n1\nkey: proj.build\nupdated: 2026-10-01\n---\nсборка проекта через pnpm");
  const mi = installMemoryIndex(null, { dirs: [d], registerTool: false });
  assert.equal(mi.count, 1, "запись проиндексирована");
  const hits = mi.search("сборка", { limit: 3 });
  assert.equal(hits[0].id, "n1");
  mi.stop();
});

test("заменённый факт не выдаётся, актуальный — выдаётся", () => {
  const d = mkdtempSync(join(tmpdir(), "mem-"));
  writeFileSync(join(d, "old.md"), "---\nid: old\nkey: k\nupdated: 2026-01-01\n---\nстарый способ сборки");
  writeFileSync(join(d, "new.md"), "---\nid: new\nkey: k\nsupersedes: [old]\nupdated: 2026-10-01\n---\nновый способ сборки");
  const mi = installMemoryIndex(null, { dirs: [d], registerTool: false });
  const ids = mi.search("сборки", { limit: 5 }).map((h) => h.id);
  assert.ok(ids.includes("new"));
  assert.ok(!ids.includes("old"));
  mi.stop();
});

test("пустой каталог не ломает установку", () => {
  const mi = installMemoryIndex(null, { dirs: ["/nope/nope"], registerTool: false });
  assert.equal(mi.count, 0);
  mi.stop();
});

test("сквозной тест через installMemoryIndex: поиск находит кириллицу и паритет с индексом", async () => {
  const { installMemoryIndex } = await import("../lib/memory-tools.js");
  const { openIndex, rebuild, search } = await import("../lib/memory-index.js");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "mem-e2e-"));
  const notes = join(root, "notes"); const empty = join(root, "empty");
  mkdirSync(notes); mkdirSync(empty);                       // пустой каталог — именно он раньше стирал индекс
  writeFileSync(join(notes, "a.md"), "---\nid: n1\nkey: build\nupdated: 2026-10-01\n---\nсборка через pnpm");
  writeFileSync(join(notes, "b.md"), "---\nid: n2\nkey: build\nsupersedes: [n1]\nupdated: 2026-10-02\n---\nновая сборка через gradle");
  writeFileSync(join(notes, "c.md"), "заметка про роутер и VPN без frontmatter");
  const mi = installMemoryIndex(null, { dirs: [notes, empty], registerTool: false });
  assert.equal(mi.count, 3, "индекс собран из первого каталога и не стёрт пустым");
  assert.equal(mi.db.prepare("SELECT count(*) AS c FROM notes").get().c, 3, "строки реально лежат в базе обёртки");
  const viaWrapper = mi.search("роутер", { limit: 5 }).map((x) => x.id).sort();
  const ref = openIndex(); rebuild(ref, notes);
  const viaIndex = search(ref, "роутер", { now: Date.now(), limit: 5 }).map((x) => x.id).sort();
  assert.ok(viaWrapper.length >= 1, "обёртка находит кириллический запрос");
  assert.deepEqual(viaWrapper, viaIndex, "паритет: обёртка и индекс дают одно и то же");
  assert.ok(mi.search("сборка", { limit: 5 }).every((x) => x.id !== "n1"), "заменённая заметка скрыта");
  mi.stop();
});

test("в результатах поиска видно происхождение записи", async () => {
  const { installMemoryIndex } = await import("../lib/memory-tools.js");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const h = join(mkdtempSync(join(tmpdir(), "ho-")), "human"), a = join(mkdtempSync(join(tmpdir(), "ao-")), "agent");
  mkdirSync(h); mkdirSync(a);
  writeFileSync(join(h, "h.md"), "человеческая заметка про роутер");
  writeFileSync(join(a, "a.md"), "агентская заметка про роутер");
  const mi = installMemoryIndex(null, { dirs: [h, a], registerTool: false, humanDirs: [h], verifySignature: () => true });
  const hits = mi.search("роутер", { limit: 5 });
  const origins = hits.map((x) => x.origin).sort();
  assert.deepEqual(origins, ["agent", "human"], "каждая запись помечена своим происхождением");
  mi.stop();
});

