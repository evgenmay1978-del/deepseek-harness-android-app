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

test("русская морфология: «роутера» находится по «роутер»", async () => {
  const { MemoryStore } = await import("../lib/store.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "morph-")), "notes.json"));
  store.add({ text: "пароль от роутера s4owner" });
  assert.ok(store.search("роутер", 5).length > 0, "«роутер» находит «роутера»");
  assert.ok(store.search("роутеров", 5).length > 0, "«роутеров» тоже");
});

test("origin: недоверенный источник помечается в выводе", async () => {
  const { MemoryStore, formatItem } = await import("../lib/store.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "origin-")), "notes.json"));
  store.add({ text: "факт из веба", origin: "web" });
  store.add({ text: "факт от пользователя", origin: "user" });
  const web = store.list(10).find(i => i.origin === "web");
  const user = store.list(10).find(i => i.origin === "user");
  assert.ok(formatItem(web).includes("⚠web"), "веб-заметка помечена");
  assert.ok(!formatItem(user).includes("⚠"), "пользовательская не помечена");
});

test("архив не вытесняет свежие заметки", async () => {
  const { installMemoryIndex } = await import("../lib/memory-tools.js");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "arch-"));
  mkdirSync(join(root, "archive"), { recursive: true });
  writeFileSync(join(root, "archive", "old.md"), "---\nupdated: 2026-01-01\n---\nуникальное слово zzarchword", "utf8");
  writeFileSync(join(root, "fresh.md"), "---\nupdated: 2026-10-04\n---\nуникальное слово zzarchword", "utf8");
  const mi = installMemoryIndex(null, { dirs: [root], registerTool: false });
  const hits = mi.search("zzarchword", { limit: 5 });
  assert.ok(hits.length >= 2, "оба файла найдены");
  assert.ok(!hits[0].id.startsWith("archive/"), "свежая выше архивной");
  mi.stop();
});

test("дельта-инъекция: разные запросы дают разные наборы, показанное не повторяется", async () => {
  const { MemoryStore } = await import("../lib/store.js");
  const { selectInjection } = await import("../lib/memory.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "delta-")), "notes.json"));
  store.add({ text: "роутер s4owner клиент" });
  store.add({ text: "polza ключ api провайдер" });
  store.add({ text: "закреплённая важная заметка", pinned: true });
  const a = selectInjection(store, { query: "роутер", capChars: 4000 });
  assert.ok(a.ids.has("m1"), "по запросу про роутер пришла m1");
  const b = selectInjection(store, { query: "polza", shown: new Set([...a.ids]), capChars: 4000 });
  assert.ok(b.ids.has("m2"), "по запросу про polza пришла m2");
  assert.ok(!b.ids.has("m1"), "уже показанная m1 не повторяется");
});

test("IDF-ранжирование: редкий термин выше общего", async () => {
  const { MemoryStore } = await import("../lib/store.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "idf-")), "notes.json"));
  store.add({ text: "роутер VPN работает" });
  store.add({ text: "роутер wifi настроен" });
  store.add({ text: "роутер s4owner клиент" });
  const hits = store.search("s4owner роутер", 3);
  assert.equal(hits[0].text, "роутер s4owner клиент", "редкий термин s4owner выше общего роутер");
});

test("евикция по использованию: использованная заметка живёт дольше", async () => {
  const { MemoryStore, LIMITS } = await import("../lib/store.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "evic-")), "notes.json"));
  for (let i = 0; i < LIMITS.maxItems; i++) store.add({ text: "note " + i });
  store.markUsed(["m1", "m2"]);
  store.add({ text: "new note" });
  const ids = store.list(200).map(i => i.id);
  assert.ok(ids.includes("m1"), "использованная заметка выжила");
  assert.ok(ids.includes("m2"), "вторая использованная выжила");
});

test("markUsed: счётчик сохраняется без смены версии", async () => {
  const { MemoryStore } = await import("../lib/store.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const f = join(mkdtempSync(join(tmpdir(), "mu-")), "notes.json");
  const store = new MemoryStore(f);
  store.add({ text: "note 1" });
  const v = store.version();
  store.markUsed(["m1"]);
  assert.equal(store.version(), v, "версия не изменилась");
  const store2 = new MemoryStore(f);
  assert.equal(store2.list(10)[0].used, 1, "счётчик сохранён на диске");
});

test("заметки agent_memory видны в memory_search (зеркало markdown)", async () => {
  const { MemoryStore } = await import("../lib/store.js");
  const { installMemoryIndex } = await import("../lib/memory-tools.js");
  const { mkdtempSync, existsSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "mem-uni-"));
  const store = new MemoryStore(join(root, "agent-memory", "notes.json"));
  store.add({ text: "DSH: polza настроен, ключ в .credentials.yaml", tags: "dsh,polza" });
  store.add({ text: "запомни про router s4owner", tags: "vpn" });
  assert.ok(existsSync(join(root, "agent-memory", "notes", "m1.md")), "зеркало m1 создано");
  assert.equal(readdirSync(join(root, "agent-memory", "notes")).filter(f => f.endsWith(".md")).length, 2, "зеркала обеих заметок");
  const mi = installMemoryIndex(null, { dirs: [join(root, "agent-memory")], registerTool: false });
  const hits = mi.search("polza", { limit: 5 });
  assert.ok(hits.some(h => h.body.includes("polza")), "заметка agent_memory находится через memory_search");
  assert.ok(mi.search("s4owner", { limit: 5 }).some(h => h.body.includes("router")), "вторая заметка тоже видна");
  store.remove("m1");
  assert.ok(!existsSync(join(root, "agent-memory", "notes", "m1.md")), "зеркало удалено вместе с заметкой");
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

