import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNote, openIndex, rebuild, search, supersededIds, walkMd } from "../lib/memory-index.js";

const NOTES = {
  "a.md": "---\nid: m1\nkey: proj.build_cmd\ntags: [build]\nupdated: 2026-09-01\n---\nсборка проекта делается командой gradle assemble",
  "b.md": "---\nid: m2\nkey: proj.build_cmd\nsupersedes: [m1]\nupdated: 2026-10-01\n---\nсборка теперь через pnpm run build",
  "c.md": "---\nid: m3\nupdated: 2026-08-01\n---\nзаметки про кофе и перерывы",
};

test("frontmatter разбирается: id, key, supersedes, tags", () => {
  const { meta, body } = parseNote(NOTES["b.md"]);
  assert.equal(meta.id, "m2");
  assert.equal(meta.key, "proj.build_cmd");
  assert.deepEqual(meta.supersedes, ["m1"]);
  assert.match(body, /pnpm run build/);
});

test("индекс пересобирается из файлов и ищет по телу", () => {
  const db = openIndex();
  const n = rebuild(db, "/notes", { list: () => Object.keys(NOTES), read: (p) => NOTES[p.split("/").pop()] });
  assert.equal(n, 3);
  const hits = search(db, "сборка", { now: Date.parse("2026-10-01") });
  assert.ok(hits.length >= 1);
});

test("заменённый факт не показывается, актуальный — показывается", () => {
  const db = openIndex();
  rebuild(db, "/notes", { list: () => Object.keys(NOTES), read: (p) => NOTES[p.split("/").pop()] });
  assert.ok(supersededIds(db).has("m1"), "m1 помечен заменённым");
  const hits = search(db, "сборка", { now: Date.parse("2026-10-01"), limit: 5 });
  const ids = hits.map((h) => h.id);
  assert.ok(ids.includes("m2"), "актуальная версия найдена");
  assert.ok(!ids.includes("m1"), "заменённая версия скрыта");
});

test("свежесть влияет на порядок", () => {
  const db = openIndex();
  rebuild(db, "/notes", { list: () => Object.keys(NOTES), read: (p) => NOTES[p.split("/").pop()] });
  const hits = search(db, "сборка", { now: Date.parse("2026-10-01"), limit: 5, includeSuperseded: true });
  assert.equal(hits[0].id, "m2", "более свежая запись выше при близкой релевантности");
});

test("вложенные каталоги индексируются (archive/ раньше был невидим)", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "rec-"));
  mkdirSync(join(root, "archive"));
  writeFileSync(join(root, "top.md"), "верхняя заметка про роутер");
  writeFileSync(join(root, "archive", "deep.md"), "архивная заметка про роутер");
  assert.deepEqual(walkMd(root).sort(), ["archive/deep.md", "top.md"]);
  const { rebuildAll } = await import("../lib/memory-index.js");
  const db = openIndex();
  const r = rebuildAll(db, [root]);
  assert.equal(r.inserted, 2, "обе заметки в индексе");
  assert.equal(search(db, "роутер", { now: Date.now(), limit: 5 }).length, 2, "обе находятся поиском");
});

test("обвал индекса: пустая сборка не стирает рабочий индекс без явного разрешения", async () => {
  const { openIndex, rebuild, rebuildAll } = await import("../lib/memory-index.js");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "idx-")), empty = mkdtempSync(join(tmpdir(), "idx-empty-"));
  writeFileSync(join(dir, "a.md"), "про роутер и VPN");
  const db = openIndex(); rebuild(db, dir);
  assert.equal(db.prepare("SELECT count(*) AS c FROM notes").get().c, 1);
  const logs = [];
  const r = rebuildAll(db, [empty], {}, { log: (m) => logs.push(m) });
  assert.equal(r.swapped, false);
  assert.equal(r.reason, "shrink");
  assert.equal(db.prepare("SELECT count(*) AS c FROM notes").get().c, 1, "рабочий индекс цел");
  assert.ok(logs.some((m) => m.includes("подозрительно мала")), "есть предупреждение в лог");
  const r2 = rebuildAll(db, [empty], {}, { allowEmpty: true });
  assert.equal(r2.swapped, true);
  assert.equal(db.prepare("SELECT count(*) AS c FROM notes").get().c, 0, "явная очистка работает");
});

test("отсутствующий каталог пишет предупреждение, а не молчит", async () => {
  const { openIndex, rebuildAll } = await import("../lib/memory-index.js");
  const logs = [];
  const db = openIndex();
  rebuildAll(db, ["/нет/такого/каталога"], {}, { log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => m.includes("каталог отсутствует")), "пропуск каталога виден в логе");
});

test("успешная сборка подменяет индекс целиком и возвращает статистику", async () => {
  const { openIndex, rebuildAll } = await import("../lib/memory-index.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const d1 = mkdtempSync(join(tmpdir(), "i1-")), d2 = mkdtempSync(join(tmpdir(), "i2-"));
  writeFileSync(join(d1, "a.md"), "старое про роутер");
  const db = openIndex(); rebuildAll(db, [d1]);
  writeFileSync(join(d1, "a.md"), "новое про роутер и VPN");
  writeFileSync(join(d2, "b.md"), "вторая заметка про планировщик");
  const r = rebuildAll(db, [d1, d2]);
  assert.equal(r.swapped, true);
  assert.equal(r.inserted, 2);
  assert.equal(db.prepare("SELECT count(*) AS c FROM notes").get().c, 2);
  const { search } = await import("../lib/memory-index.js");
  assert.ok(search(db, "планировщик", { now: Date.now(), limit: 5 }).length >= 1);
});

test("ошибка доступа к каталогу прерывает сборку и не трогает индекс", async () => {
  const { openIndex, rebuildAll, rebuild } = await import("../lib/memory-index.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const ok = mkdtempSync(join(tmpdir(), "ok-"));
  writeFileSync(join(ok, "a.md"), "заметка про роутер");
  const db = openIndex(); rebuild(db, ok);
  const before = db.prepare("SELECT count(*) AS c FROM notes").get().c;
  const logs = [];
  const r = rebuildAll(db, [ok, "/нет/доступа"], { list: (d) => { if (d === "/нет/доступа") { const e = new Error("нет доступа"); e.code = "EACCES"; throw e; } return ["a.md"]; },
    read: () => "заметка про роутер" }, { log: (m) => logs.push(m) });
  assert.equal(r.swapped, false);
  assert.equal(r.reason, "io_error", "ошибка ввода-вывода прерывает сборку, а не пропускается молча");
  assert.equal(db.prepare("SELECT count(*) AS c FROM notes").get().c, before, "рабочий индекс не тронут");
  assert.ok(logs.some((m) => m.includes("СБОРКА ПРЕРВАНА")));
});

test("дубли id: побеждает первый по порядку каталогов, остальные логируются", async () => {
  const { openIndex, rebuildAll, search } = await import("../lib/memory-index.js");
  const db = openIndex();
  const deps = {
    list: (d) => (d === "/d1" ? ["a.md"] : ["b.md"]),
    read: (p) => (p.startsWith("/d1") ? "---\nid: same\n---\nпервая версия про роутер" : "---\nid: same\n---\nвторая версия про роутер"),
  };
  const logs = [];
  const r = rebuildAll(db, ["/d1", "/d2"], deps, { log: (m) => logs.push(m) });
  assert.equal(r.inserted, 1);
  assert.ok(logs.some((m) => m.includes("дубль id пропущен")));
  assert.equal(search(db, "роутер", { now: Date.now(), limit: 5 }).length, 1);
});

test("дубль: человеческая запись вытесняет агентскую независимо от порядка каталогов", async () => {
  const { openIndex, rebuildAll } = await import("../lib/memory-index.js");
  const db = openIndex();
  const deps = { verifySignature: () => true, 
    list: (d) => (d === "/agent" ? ["a.md"] : ["h.md"]),
    read: (p) => (p.startsWith("/agent") ? "---\nid: same\norigin: agent\n---\nверсия агента" : "---\nid: same\norigin: human\n---\nверсия человека"),
  };
  const logs = [];
  const r = rebuildAll(db, ["/agent", "/human"], deps, { log: (m) => logs.push(m), humanDirs: ["/human"] });
  assert.equal(r.inserted, 1);
  assert.ok(logs.some((m) => m.includes("конфликт памяти") && m.includes("human_over_agent")), "вытеснение пишется в аудит");
  const body = db.prepare("SELECT body FROM notes").get().body;
  assert.match(body, /человека/, "победила человеческая запись, хотя её каталог шёл вторым");
});

test("низкая доля разобранных файлов прерывает сборку", async () => {
  const { openIndex, rebuildAll, rebuild } = await import("../lib/memory-index.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const d = mkdtempSync(join(tmpdir(), "p-"));
  writeFileSync(join(d, "a.md"), "про роутер");
  const db = openIndex(); rebuild(db, d);
  const before = db.prepare("SELECT count(*) AS c FROM notes").get().c;
  const logs = [];
  const deps = { verifySignature: () => true, list: () => ["a.md", "b.md", "c.md", "d.md"], read: (p) => (p.endsWith("a.md") ? "ок" : (() => { throw new Error("битый файл"); })()) };
  const r = rebuildAll(db, ["/d"], deps, { log: (m) => logs.push(m) });
  assert.equal(r.swapped, false);
  assert.equal(r.reason, "parse_ratio");
  assert.equal(db.prepare("SELECT count(*) AS c FROM notes").get().c, before, "индекс не подменён");
  assert.ok(logs.some((m) => m.includes("СБОРКА ПРЕРВАНА")));
});

test("в профиле full безвредный инструмент не требует подтверждения", async () => {
  const { createRegistry, authorize } = await import("../lib/tool-registry.js");
  const r = createRegistry();
  r.register({ name: "memory_search", handler: async () => 1, side_effect: "none" });
  r.register({ name: "fs_write", handler: async () => 1, side_effect: "write" });
  r.enable("memory_search"); r.enable("fs_write");
  assert.equal(authorize(r, "memory_search", { profile: "full" }).ok, true, "безвредный — без подтверждения");
  assert.equal(authorize(r, "fs_write", { profile: "full" }).code, "needs_approval", "пишущий — требует подтверждения");
});

test("подделка origin: human в агентском каталоге НЕ вытесняет настоящую человеческую запись", async () => {
  const { openIndex, rebuildAll } = await import("../lib/memory-index.js");
  const db = openIndex();
  const human = ["---", "id: same", "---", "НАСТОЯЩИЙ человеческий факт"].join(String.fromCharCode(10));
  const fake = ["---", "id: same", "origin: human", "---", "подделка агента"].join(String.fromCharCode(10));
  const deps = { verifySignature: () => true, 
    list: (d) => (d === "/human" ? ["h.md"] : ["fake.md"]),
    read: (f) => (f.startsWith("/human") ? human : fake),
  };
  const logs = [];
  // агентский каталог идёт ПЕРВЫМ — раньше это давало ему победу
  const r = rebuildAll(db, ["/agent", "/human"], deps, { log: (m) => logs.push(m), humanDirs: ["/human"] });
  const body = db.prepare("SELECT body FROM notes").get().body;
  assert.match(body, /НАСТОЯЩИЙ человеческий факт/, "побеждает запись из человеческого каталога");
  assert.ok(!/подделка/.test(body), "подделка не попала в индекс");
  assert.ok(r.conflicts.some((c) => c.kind === "human_over_agent"), "вытеснение видно как конфликт памяти");
});

test("агент не может скрыть человеческий факт через supersedes", async () => {
  const { openIndex, rebuildAll, search } = await import("../lib/memory-index.js");
  const db = openIndex();
  const human = ["---", "id: h1", "key: fact", "---", "ЧЕЛОВЕЧЕСКИЙ факт про роутер"].join(String.fromCharCode(10));
  const agent = ["---", "id: a1", "key: fact", "supersedes: [h1]", "---", "агентская версия про роутер"].join(String.fromCharCode(10));
  const deps = { verifySignature: () => true, list: (d) => (d === "/h" ? ["h.md"] : ["a.md"]), read: (f) => (f.startsWith("/h") ? human : agent) };
  const r = rebuildAll(db, ["/h", "/a"], deps, { humanDirs: ["/h"] });
  const ids = search(db, "роутер", { now: Date.now(), limit: 5 }).map((x) => x.id);
  assert.ok(ids.includes("h1"), "человеческий факт остаётся видимым");
  assert.ok(r.conflicts.some((c) => c.kind === "agent_supersedes_human_blocked"), "попытка скрыть видна как конфликт");
});

test("человек может вытеснить агентский факт через supersedes", async () => {
  const { openIndex, rebuildAll, search } = await import("../lib/memory-index.js");
  const db = openIndex();
  const agent = ["---", "id: a9", "key: k2", "---", "агентский факт"].join(String.fromCharCode(10));
  const human = ["---", "id: h9", "key: k2", "supersedes: [a9]", "---", "человеческий факт"].join(String.fromCharCode(10));
  const deps = { verifySignature: () => true, list: (d) => (d === "/a" ? ["a.md"] : ["h.md"]), read: (f) => (f.startsWith("/a") ? agent : human) };
  rebuildAll(db, ["/a", "/h"], deps, { humanDirs: ["/h"] });
  const body = db.prepare("SELECT body FROM notes WHERE id = 'h9'").get().body;
  assert.match(body, /человеческий/);
  const sup = db.prepare("SELECT supersedes FROM notes WHERE id = 'h9'").get().supersedes;
  assert.match(String(sup), /a9/, "человеческая запись вправе вытеснять агентскую");
});

test("коллизия ключа с разными id пишется как предложение агенту-владельцу", async () => {
  const { openIndex, rebuildAll } = await import("../lib/memory-index.js");
  const db = openIndex();
  const human = ["---", "id: hk", "key: shared", "---", "человеческий факт с общим ключом"].join(String.fromCharCode(10));
  const agent = ["---", "id: ak", "key: shared", "---", "агентский факт с общим ключом"].join(String.fromCharCode(10));
  const deps = { verifySignature: () => true, list: (d) => (d === "/h" ? ["h.md"] : ["a.md"]), read: (f) => (f.startsWith("/h") ? human : agent) };
  const r = rebuildAll(db, ["/h", "/a"], deps, { humanDirs: ["/h"] });
  assert.ok(r.conflicts.some((c) => c.kind === "agent_key_collision"), "коллизия ключа видна как конфликт");
});

test("W4: без верификатора запись НЕ становится человеческой (fail-closed)", async () => {
  const { openIndex, rebuildAll } = await import("../lib/memory-index.js");
  const db = openIndex();
  const deps = { list: () => ["h.md"], read: () => "человеческий факт про роутер" };   // верификатора нет
  const r = rebuildAll(db, ["/human"], deps, { humanDirs: ["/human"] });
  assert.equal(r.swapped, true);
  assert.equal(db.prepare("SELECT origin FROM notes").get().origin, "agent", "без канала подписи — агентская запись");
});

test("W4: невалидная подпись — агентская запись, даже из человеческого каталога", async () => {
  const { openIndex, rebuildAll } = await import("../lib/memory-index.js");
  const db = openIndex();
  const body = "человеческий факт про роутер";
  const deps = { list: () => ["h.md"], read: () => body, verifySignature: () => false };   // подпись не подтвердилась
  rebuildAll(db, ["/human"], deps, { humanDirs: ["/human"] });
  assert.equal(db.prepare("SELECT origin FROM notes").get().origin, "agent");
});

test("W4: подпись привязана к телу записи (подмена тела делает её невалидной)", async () => {
  const { openIndex, rebuildAll, canonicalRecord } = await import("../lib/memory-index.js");
  const { createHash } = await import("node:crypto");
  const sig = "подпись-человека";
  const hashOf = (b) => createHash("sha256").update(b).digest("hex");
  // Верификатор видит только каноническую строку (id, key, origin, supersedes, ХЕШ тела) — как будет у Kotlin.
  const verifier = (canonical, s2) => s2 === sig && canonical.includes(hashOf("исходное тело"));

  const db = openIndex();
  rebuildAll(db, ["/human"], { list: () => ["h.md"], read: () => ["---", "id: h1", "key: k", "signature: " + sig, "---", "исходное тело"].join(String.fromCharCode(10)), verifySignature: verifier }, { humanDirs: ["/human"] });
  assert.equal(db.prepare("SELECT origin FROM notes").get().origin, "human", "подпись совпала с телом — человек");

  const db2 = openIndex();
  rebuildAll(db2, ["/human"], { list: () => ["h.md"], read: () => ["---", "id: h1", "key: k", "signature: " + sig, "---", "ПОДМЕНЁННОЕ тело"].join(String.fromCharCode(10)), verifySignature: verifier }, { humanDirs: ["/human"] });
  assert.equal(db2.prepare("SELECT origin FROM notes").get().origin, "agent", "тело изменилось — подпись невалидна");

  const canon = canonicalRecord({ id: "x", key: "k", origin: "human", supersedes: ["a"], body: "тело" });
  assert.equal(canon.split(String.fromCharCode(10)).length, 5, "id, key, origin, supersedes, хеш тела");
  assert.ok(canon.includes(hashOf("тело")) && !canon.includes("тело") , "в канонической форме тело заменено хешем");
});
