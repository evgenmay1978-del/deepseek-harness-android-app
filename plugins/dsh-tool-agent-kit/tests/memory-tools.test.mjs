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

test("контракт хука: на шаге 1 ввод из payload.messages даёт инъекцию", async () => {
  const { MemoryStore } = await import("../lib/store.js");
  const { installMemoryInjection, readInjectionLog } = await import("../lib/memory.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "hook-")), "notes.json"));
  store.add({ text: "роутер s4owner клиент" });
  let handler = null;
  const ctx = { on: (ev, fn) => { if (ev === "agent/pre-step") handler = fn; }, logger: { warn() {} } };
  const llm = { createUserMessage: (m) => m, boundContextSummary: (k) => k };
  installMemoryInjection(ctx, store, {}, { llm });
  assert.ok(handler, "хук agent/pre-step зарегистрирован");
  const session = { id: "s1" };
  // content — массив блоков, как в реальном журнале (tests/support/journal-fixture.mjs), а не строка.
  const payload = { agent: { session }, step: 1, signal: { aborted: false }, messages: [{ role: "user", content: [{ type: "text", text: "что по роутеру s4owner?" }] }] };
  const decision = { kind: "enter", messages: [] };
  const out = await handler(payload, async () => decision);
  assert.equal(out.messages.length, 1, "хук добавил сообщение памяти");
  assert.ok(JSON.stringify(out.messages[0]).includes("роутер"), "в сообщении есть заметка");
  const st = readInjectionLog(join(dirname(store.file), "injection-log.json"));
  assert.equal(st.length, 1, "состояние инъекции записано");
  assert.equal(st[0].branch, "standard", "ветка — штатная");
  assert.equal(st[0].via, "query", "via — запрос дал совпадения");
  assert.equal(st[0].qlen, "что по роутеру s4owner?".length, "длина запроса в символах записана");
  assert.ok(String(st[0].keys[0]).startsWith("m1:"), "ключ id:updated");
  assert.ok(st[0].size > 0 && st[0].cap > 0, "размер и кап записаны");
});

test("реальная фикстура журнала: несовпавший запрос без закреплённых — НЕ дампим память", async () => {
  const { MemoryStore } = await import("../lib/store.js");
  const { installMemoryInjection, readInjectionLog, userTextOf } = await import("../lib/memory.js");
  const { REAL_TURN1_WITH_FILE, REAL_TURN34 } = await import("./support/journal-fixture.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  // Блоки не-text (file) в запрос не попадают; берётся только текст
  assert.equal(userTextOf(REAL_TURN34), "Перезагрузил", "текстовый блок прочитан");
  assert.equal(userTextOf(REAL_TURN1_WITH_FILE), "Добавить этот апи можно?", "file-блок проигнорирован");
  const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "real-")), "notes.json"));
  store.add({ text: "роутер s4owner клиент" }); // не закреплена
  let handler = null;
  const ctx = { on: (ev, fn) => { if (ev === "agent/pre-step") handler = fn; }, logger: { warn() {} } };
  const llm = { createUserMessage: (m) => m, boundContextSummary: (k) => k };
  installMemoryInjection(ctx, store, {}, { llm });
  const payload = { agent: { session: { id: "real" } }, turn: 34, step: 1, signal: { aborted: false }, messages: [REAL_TURN34] };
  const out = await handler(payload, async () => ({ kind: "enter", messages: [] }));
  assert.equal(out.messages.length, 0, "несовпавший запрос больше не дампит всю память");
  assert.equal(readInjectionLog(join(dirname(store.file), "injection-log.json")).length, 0, "и не пишет состояние");
});

test("несовпавший запрос показывает ТОЛЬКО закреплённые + версию схемы", async () => {
  const { MemoryStore } = await import("../lib/store.js");
  const { installMemoryInjection, readInjectionLog } = await import("../lib/memory.js");
  const { REAL_TURN34 } = await import("./support/journal-fixture.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "pin-")), "notes.json"));
  store.add({ text: "обычная заметка про роутер" });
  store.add({ text: "закреплённый факт", pinned: true });
  let handler = null;
  const ctx = { on: (ev, fn) => { if (ev === "agent/pre-step") handler = fn; }, logger: { warn() {} } };
  installMemoryInjection(ctx, store, {}, { llm: { createUserMessage: (m) => m, boundContextSummary: (k) => k } });
  const payload = { agent: { session: { id: "pin" } }, turn: 34, step: 1, signal: { aborted: false }, messages: [REAL_TURN34] };
  const out = await handler(payload, async () => ({ kind: "enter", messages: [] }));
  const txt = JSON.stringify(out.messages[0]);
  assert.ok(txt.includes("закреплённый факт"), "закреплённая показана");
  assert.ok(!txt.includes("обычная заметка"), "незакреплённая не дампится");
  const st = readInjectionLog(join(dirname(store.file), "injection-log.json"));
  assert.equal(st[0].via, "fallback", "запрос был, совпадений нет — fallback");
  assert.equal(st[0].v, 1, "версия схемы файла записана");
  assert.equal(st[0].qlen, "Перезагрузил".length, "qlen показывает, что запрос НЕ пустой");
});

test("короткая реплика после содержательного запроса берёт тему из истории реплик", async () => {
  const { MemoryStore } = await import("../lib/store.js");
  const { installMemoryInjection, readInjectionLog } = await import("../lib/memory.js");
  const { REAL_TURN34 } = await import("./support/journal-fixture.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "ctx-")), "notes.json"));
  store.add({ text: "роутер s4owner клиент" });
  let pre = null, onEvent = null;
  const ctx = { on: (ev, fn) => { if (ev === "agent/pre-step") pre = fn; else if (ev === "session/event") onEvent = fn; }, logger: { warn() {} } };
  installMemoryInjection(ctx, store, {}, { llm: { createUserMessage: (m) => m, boundContextSummary: (k) => k } });
  const session = { id: "ctx" };
  // Предыдущая содержательная реплика — ровно та форма, что у реальных user/message (source.kind="user")
  onEvent(session, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "что по роутеру s4owner?" }] } });
  // Наш собственный notice в историю запроса попадать не должен
  onEvent(session, { type: "user/message", data: { source: { kind: "agent-kit-memory", form: "notice" }, content: [{ type: "text", text: "МУСОР-ИЗ-NOTICE" }] } });
  const payload = { agent: { session }, step: 1, signal: { aborted: false }, messages: [REAL_TURN34] };
  const out = await pre(payload, async () => ({ kind: "enter", messages: [] }));
  const txt = JSON.stringify(out.messages[0]);
  assert.ok(txt.includes("роутер s4owner"), "тема предыдущей реплики подхвачена");
  assert.ok(!txt.includes("МУСОР-ИЗ-NOTICE"), "notice не попал в запрос");
  const st = readInjectionLog(join(dirname(store.file), "injection-log.json"));
  assert.equal(st[0].via, "query", "контекстный запрос нашёл тему");
  assert.ok(st[0].qlen > "Перезагрузил".length, "qlen — длина составного запроса");
});

test("agent_memory(status) читает журнал инъекций на момент вызова", async () => {
  const { MemoryStore } = await import("../lib/store.js");
  const { memoryTool, injectionLogPath, recordInjection } = await import("../lib/memory.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "st-")), "notes.json"));
  store.add({ text: "СЕКРЕТ-ТЕКСТ-ЗАМЕТКИ" });
  const tool = memoryTool((x) => x, store);
  let res = await tool.execute({ action: "status" });
  assert.equal(res.ok, true);
  assert.ok(res.text.includes("инъекций не было"), "пока журнала нет — так и говорит");
  assert.ok(!res.text.includes("СЕКРЕТ-ТЕКСТ-ЗАМЕТКИ"), "status не отдаёт текст заметок — только счётчики и поля");
  await recordInjection(injectionLogPath(store), { at: "2026-10-04T18:23:15.725Z", turn: 34, step: 1, branch: "standard", via: "fallback", qlen: 12, keys: ["m1:1"], size: 975, cap: 1800 });
  res = await tool.execute({ action: "status" });
  assert.ok(res.text.includes("последняя инъекция: 2026-10-04T18:23:15.725Z"), "видно время последней инъекции");
  assert.ok(res.text.includes("via fallback") && res.text.includes("запрос 12 симв"), "видно via и длину запроса");
});

test("контракт хука: середина хода молчит, после компакции показывает заново", async () => {
  const { MemoryStore } = await import("../lib/store.js");
  const { installMemoryInjection } = await import("../lib/memory.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "hook2-")), "notes.json"));
  store.add({ text: "роутер s4owner клиент" });
  let pre = null, onEvent = null;
  const ctx = { on: (ev, fn) => { if (ev === "agent/pre-step") pre = fn; else if (ev === "session/event") onEvent = fn; }, logger: { warn() {} } };
  const llm = { createUserMessage: (m) => m, boundContextSummary: (k) => k };
  installMemoryInjection(ctx, store, {}, { llm });
  const session = { id: "s2" };
  const mk = (step) => ({ agent: { session }, step, signal: { aborted: false }, messages: [{ role: "user", content: "роутер" }] });
  const next = async () => ({ kind: "enter", messages: [] });
  assert.equal((await pre(mk(1), next)).messages.length, 1, "шаг 1 инжектит");
  assert.equal((await pre(mk(2), next)).messages.length, 0, "середина хода не дублирует");
  onEvent(session, { type: "compaction/end" });
  assert.equal((await pre(mk(2), next)).messages.length, 1, "после компакции показываем заново");
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
  const has = (set, id) => [...set].some((k) => k.startsWith(id + ":"));
  assert.ok(has(a.ids, "m1"), "по запросу про роутер пришла m1");
  const b = selectInjection(store, { query: "polza", shown: new Set([...a.ids]), capChars: 4000 });
  assert.ok(has(b.ids, "m2"), "по запросу про polza пришла m2");
  assert.ok(!has(b.ids, "m1"), "уже показанная m1 не повторяется");
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

