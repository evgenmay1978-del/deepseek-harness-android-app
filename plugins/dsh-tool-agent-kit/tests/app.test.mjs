import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, requireDep } from "../lib/app.js";   // чистая фабрика: кэша нет, сброс не нужен

const ctx = { logger: { warn() {} }, tools: { register() {} }, get: () => undefined };

test("createApp падает на отсутствующей зависимости и говорит, какой именно", () => {
  assert.throws(() => createApp(ctx, { memoryDirs: ["/m"], skillDirs: ["/s"] }), /filesDir/);
  assert.throws(() => createApp(ctx, { filesDir: "/f", skillDirs: ["/s"] }), /memoryDirs/);
  assert.throws(() => createApp(ctx, { filesDir: "/f", memoryDirs: ["/m"] }), /skillDirs/);
  assert.throws(() => createApp(ctx, { filesDir: "/f", memoryDirs: [], skillDirs: ["/s"] }), /memoryDirs.*непуст/);
});

test("requireDep возвращает значение и объясняет пропуск", () => {
  assert.equal(requireDep({ a: 1 }, "a"), 1);
  assert.throws(() => requireDep({}, "a"), /'a'/);
});

test("createApp собирает все три подсистемы, когда зависимости на месте", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "app-"));
  const mem = join(root, "mem"), sk = join(root, "sk");
  mkdirSync(mem); mkdirSync(sk);
  writeFileSync(join(mem, "n.md"), "заметка про роутер");
  writeFileSync(join(sk, "s.md"), "---\nname: tdd\ndescription: тесты\ntriggers: [тест]\n---\nтекст навыка");
  const app = createApp(ctx, { filesDir: root, memoryDirs: [mem], skillDirs: [sk], humanDirs: [], allowNoHumanDirs: true, registerTools: false, consolidateIntervalMs: 3600e3, schedule: { intervalMs: 3600e3, startupDelayMs: 3600e3 } });
  assert.deepEqual(app.checks, ["schedule", "memory", "skills", "consolidate", "registry"], "реестр и консолидация — часть сборки");
  assert.ok(app.memory.count >= 1, "индекс памяти собрался");
  assert.ok(app.skills.catalog.length >= 1, "каталог скиллов собран");
  app.memory.stop(); app.skills && app.skills.catalog && null; try { app.schedule.stop?.(); } catch {}
});

test("fail-closed: при ошибке сборки не собирается ничего и статус помечен как деградация", async () => {
  const { assembleSafely } = await import("../lib/app.js");
  const { writeFileSync, readFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fc-"));
  const status = join(dir, "plugin-status.json");
  let registered = 0;
  const ctx = { logger: { warn() {} }, tools: { register() { registered++; } }, get: () => undefined };
  const bad = assembleSafely(ctx, { memoryDirs: ["/m"], skillDirs: ["/s"] }, { statusPath: status, writeFile: (p, s) => writeFileSync(p, s) });
  assert.equal(bad.ok, false, "сборка обязана провалиться");
  const st = JSON.parse(readFileSync(status, "utf8"));
  assert.equal(st.ok, false);
  assert.match(st.tools, /fail-closed/);
  assert.equal(registered, 0, "ни один инструмент не зарегистрирован при провале");

  const good = assembleSafely(ctx, { filesDir: dir, memoryDirs: ["/m2"], skillDirs: ["/s2"], humanDirs: [], allowNoHumanDirs: true, registerTools: false, schedule: { intervalMs: 3600e3, startupDelayMs: 3600e3 } }, { statusPath: status, writeFile: (p, s) => writeFileSync(p, s) });
  assert.equal(good.ok, true);
  assert.equal(JSON.parse(readFileSync(status, "utf8")).ok, true, "статус вернулся в норму");
});

test("W1: humanDirs доходит до индекса и человеческая запись получает origin human", async () => {
  const { assembleSafely } = await import("../lib/app.js");
  const { installMemoryIndex } = await import("../lib/memory-tools.js");
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "w1-"));
  const human = join(root, "human"), agent = join(root, "agent");
  mkdirSync(human); mkdirSync(agent);
  writeFileSync(join(human, "h.md"), "человеческий факт про роутер");
  writeFileSync(join(agent, "a.md"), "агентская заметка про роутер");
  const status = join(root, "plugin-status.json");
  const res = assembleSafely(ctx, {
    filesDir: root, memoryDirs: [human, agent], skillDirs: [agent], humanDirs: [human], verifySignature: () => true,
    registerTools: false, statusPath: status, schedule: { intervalMs: 3600e3, startupDelayMs: 3600e3 },
  }, { statusPath: status, writeFile: (f, t) => writeFileSync(f, t) });
  assert.equal(res.ok, true, "сборка проходит с человеческим каталогом");
  const origins = res.app.memory.search("роутер", { limit: 5 }).map((x) => x.origin).sort();
  assert.deepEqual(origins, ["agent", "human"], "происхождение доехало до индекса через assembleSafely");
  const st = JSON.parse(readFileSync(status, "utf8"));
  assert.equal(st.origin_protection, "вкл", "статус сообщает, что защита происхождения включена");
  assert.ok(st.protected_paths.includes(human) && st.protected_paths.includes(status), "защищённые пути перечислены");
  res.app.memory.stop();
});

test("W1: пустой humanDirs без явного флага падает", async () => {
  const { createApp } = await import("../lib/app.js");
  assert.throws(() => createApp(ctx, { filesDir: "/f", memoryDirs: ["/m"], skillDirs: ["/s"], humanDirs: [] }), /humanDirs/);
  assert.throws(() => createApp(ctx, { filesDir: "/f", memoryDirs: ["/m"], skillDirs: ["/s"] }), /humanDirs/);
  assert.throws(() => createApp(ctx, { filesDir: "/f", memoryDirs: ["/m"], skillDirs: ["/s"], humanDirs: ["относительный"], allowNoHumanDirs: true }), /абсолютный/);
});

test("W1: статус плагина лежит вне agent-memory", async () => {
  const { defaultStatusPath } = await import("../lib/app.js");
  const p = defaultStatusPath("/files");
  assert.equal(p, "/files/plugin-status.json");
  assert.ok(!p.includes("/agent-memory/"), "статус не в агентской зоне");
});

test("W1: агентская запись в защищённые пути отклоняется", async () => {
  const { checkWrite } = await import("../lib/human-dirs.js");
  const { defaultStatusPath } = await import("../lib/app.js");
  const status = defaultStatusPath("/files");
  const human = "/files/maestro/env/memory-repo";
  assert.equal(checkWrite(human + "/note.md", { humanDirs: [human] }).ok, false, "человеческий каталог защищён");
  assert.equal(checkWrite("/files/agent-memory/x.md", { humanDirs: [human] }).ok, true, "агентский каталог пишется свободно");
});

test("валидация реестра: пустой реестр не даёт ложных срабатываний", async () => {
  const { validateRegistry } = await import("../lib/app.js");
  const { createRegistry } = await import("../lib/tool-registry.js");
  const reg = createRegistry();
  assert.deepEqual(validateRegistry(reg), [], "на пустом реестре проверок нет — инструменты регистрируются позже");
  reg.register({ name: "known_tool", side_effect: "none" });
  const problems = validateRegistry(reg);
  assert.ok(problems.some((x) => x.includes("memory_search")), "на непустом реестре опечатки в allowlist видны");
});
