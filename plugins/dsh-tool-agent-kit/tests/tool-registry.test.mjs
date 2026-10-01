import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry, authorize } from "../lib/tool-registry.js";

const mk = () => {
  const r = createRegistry();
  r.register({ name: "memory_search", handler: async () => "нашли", side_effect: "none" });
  r.register({ name: "fs_read", handler: async () => "файл", side_effect: "none" });
  r.register({ name: "bash", handler: async () => "шелл", side_effect: "destructive" });
  r.register({ name: "android_schedule", handler: async () => "задача", side_effect: "write", capabilities: ["schedules"] });
  return r;
};

test("новый инструмент по умолчанию выключен и не вызывается", async () => {
  const r = mk();
  const res = await r.dispatch("memory_search", {}, { profile: "readonly" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "disabled", "закрыт по умолчанию, пока не включили");
});

test("после включения readonly-инструмент работает", async () => {
  const r = mk(); r.enable("memory_search");
  const res = await r.dispatch("memory_search", {}, { profile: "readonly" });
  assert.equal(res.ok, true);
  assert.equal(res.result, "нашли");
});

test("bash запрещён в readonly даже если включён", async () => {
  const r = mk(); r.enable("bash");
  const res = await r.dispatch("bash", {}, { profile: "readonly" });
  assert.equal(res.ok, false, "bash обязан быть отклонён в readonly");
});

test("неизвестный инструмент запрещён", async () => {
  const r = mk();
  const v = authorize(r, "нет_такого", { profile: "readonly" });
  assert.equal(v.ok, false);
  assert.equal(v.code, "unknown");
});

test("планирование из сессии по расписанию запрещено", async () => {
  const r = mk(); r.enable("android_schedule");
  const v = authorize(r, "android_schedule", { profile: "full", approved: true, scheduled: true });
  assert.equal(v.ok, false);
  assert.equal(v.code, "denied_scheduled");
});

test("профиль full требует подтверждения человека", async () => {
  const r = mk(); r.enable("bash");
  const no = authorize(r, "bash", { profile: "full", approved: false });
  assert.equal(no.code, "needs_approval");
  const yes = authorize(r, "bash", { profile: "full", approved: true });
  assert.equal(yes.ok, true);
});

test("решения диспетчера попадают в аудит", async () => {
  const r = mk(); r.enable("fs_read");
  await r.dispatch("fs_read", {}, { profile: "readonly" });
  await r.dispatch("bash", {}, { profile: "readonly" });
  const a = r.audit().filter((x) => x.phase !== "post" || x.code === "done");
  assert.ok(a.length >= 2, "решения пишутся в аудит");
  assert.ok(a.some((x) => x.ok === true) && a.some((x) => x.ok === false), "видны и разрешение, и отказ");
});

test("подтверждение: без токена отказ, с токеном разрешено и он одноразовый", async () => {
  const { makeApprovals, authorize } = await import("../lib/tool-registry.js");
  const r = mk(); r.enable("bash");
  const ap = makeApprovals({ ttlMs: 1000 });
  const noTok = authorize(r, "bash", { profile: "full", approvals: ap, args: { cmd: "ls" }, sessionId: "s1" });
  assert.equal(noTok.code, "approval_unknown");
  const { token } = ap.issue({ tool: "bash", args: { cmd: "ls" }, sessionId: "s1" });
  const ok = authorize(r, "bash", { profile: "full", approvals: ap, token, args: { cmd: "ls" }, sessionId: "s1", now: 10 });
  assert.equal(ok.ok, true);
  const again = authorize(r, "bash", { profile: "full", approvals: ap, token, args: { cmd: "ls" }, sessionId: "s1", now: 20 });
  assert.equal(again.code, "approval_used", "повторное использование запрещено");
});

test("подтверждение привязано к аргументам и сессии", async () => {
  const { makeApprovals, authorize, canonicalArgs } = await import("../lib/tool-registry.js");
  const r = mk(); r.enable("bash");
  const ap = makeApprovals();
  const { token } = ap.issue({ tool: "bash", args: { cmd: "ls" }, sessionId: "s1" });
  assert.equal(authorize(r, "bash", { profile: "full", approvals: ap, token, args: { cmd: "rm -rf /" }, sessionId: "s1" }).code, "approval_mismatch");
  const t2 = ap.issue({ tool: "bash", args: { cmd: "ls" }, sessionId: "s1" }).token;
  assert.equal(authorize(r, "bash", { profile: "full", approvals: ap, token: t2, args: { cmd: "ls" }, sessionId: "s2" }).code, "approval_mismatch");
  assert.equal(canonicalArgs({ a: 1, b: 2 }), canonicalArgs({ b: 2, a: 1 }), "порядок ключей не влияет");
});

test("подтверждение истекает по TTL", async () => {
  const { makeApprovals, authorize } = await import("../lib/tool-registry.js");
  const r = mk(); r.enable("bash");
  const ap = makeApprovals({ ttlMs: 100 });
  const { token } = ap.issue({ tool: "bash", args: {}, sessionId: "s1", now: 0 });
  assert.equal(authorize(r, "bash", { profile: "full", approvals: ap, token, args: {}, sessionId: "s1", now: 500 }).code, "approval_expired");
});

test("allowlist проверяется ДО подтверждения: человека не спрашивают о запрещённом", async () => {
  const { authorize, canonicalToolName, guardPath, mayAutoExecute, createRegistry } = await import("../lib/tool-registry.js");
  const r = createRegistry();
  r.register({ name: "bash", handler: async () => 1, side_effect: "destructive" });
  r.enable("bash");
  const v = authorize(r, "bash", { profile: "readonly" });
  assert.equal(v.ok, false, "отказ без запроса подтверждения");
});

test("алиас старой версии не обходит политику", async () => {
  const { authorize, canonicalToolName, createRegistry } = await import("../lib/tool-registry.js");
  const r = createRegistry();
  r.register({ name: "bash", handler: async () => 1 });
  r.enable("bash");
  assert.equal(canonicalToolName("Shell@2"), "bash");
  const v = authorize(r, "shell@2", { profile: "readonly" });
  assert.equal(v.ok, false);
});

test("readonly по метаданным: пишущее отклоняется даже под безобидным именем", async () => {
  const { authorize, createRegistry } = await import("../lib/tool-registry.js");
  const r = createRegistry();
  r.register({ name: "memory_search", handler: async () => 1, side_effect: "none" });
  r.register({ name: "secret_writer", handler: async () => 1, side_effect: "write" });
  r.enable("memory_search"); r.enable("secret_writer");
  assert.equal(authorize(r, "memory_search", { profile: "readonly" }).ok, true);
  assert.equal(authorize(r, "secret_writer", { profile: "readonly" }).code, "denied_side_effect");
});

test("capability вместо имени: сессия без schedules не планирует", async () => {
  const { authorize, createRegistry } = await import("../lib/tool-registry.js");
  const r = createRegistry();
  r.register({ name: "queue_add", handler: async () => 1, capabilities: ["schedules", "writes_engine_state"], side_effect: "write" });
  r.enable("queue_add");
  const v = authorize(r, "queue_add", { profile: "full", approvals: null, approved: true, sessionCaps: [] });
  assert.equal(v.code, "denied_capability");
});

test("запись в каталог движка отклоняется (.., симлинк, чужой корень)", async () => {
  const { guardPath } = await import("../lib/tool-registry.js");
  const roots = ["/data/app/agent-memory/notes"];
  assert.equal(guardPath("/data/app/agent-memory/notes/a.md", { allowedRoots: roots }).ok, true);
  assert.equal(guardPath("/data/app/agent-memory/notes/../../queue.json", { allowedRoots: roots }).code, "path_forbidden");
  assert.equal(guardPath("/data/app/queue.json", { allowedRoots: roots }).code, "path_forbidden");
  assert.equal(guardPath("/data/app/agent-memory/notes/link", { allowedRoots: roots, realpath: () => "/data/app/queue.json" }).code, "path_forbidden");
});

test("задача с origin=agent не автоисполняется", async () => {
  const { mayAutoExecute } = await import("../lib/tool-registry.js");
  assert.equal(mayAutoExecute({ origin: "agent" }, { hasHumanSignature: true }).code, "origin_not_human");
  assert.equal(mayAutoExecute({ origin: "human" }, { hasHumanSignature: false }).code, "signature_missing");
  assert.equal(mayAutoExecute({ origin: "human" }, { hasHumanSignature: true }).ok, true);
});

test("замороженный реестр не принимает новые инструменты", async () => {
  const { createRegistry } = await import("../lib/tool-registry.js");
  const r = createRegistry();
  r.register({ name: "a" });
  r.freeze();
  assert.throws(() => r.register({ name: "b" }), /заморожен/);
});

test("диспетчер: аудит до и после, секреты маскируются, taint ставится", async () => {
  const { createRegistry } = await import("../lib/tool-registry.js");
  const r = createRegistry();
  r.register({ name: "web_fetch", handler: async () => "данные", side_effect: "read", capabilities: ["external"] });
  r.enable("web_fetch");
  const state = {};
  const res = await r.dispatch("web_fetch", { url: "x", token: "секрет" }, { profile: "full", approved: true, sessionState: state, now: 1 });
  assert.equal(res.ok, true);
  const a = r.audit();
  assert.equal(a.length, 2, "запись до и после выполнения");
  assert.equal(a[0].phase, "pre");
  assert.equal(a[1].phase, "post");
  assert.equal(a[0].args.token, "<скрыто>", "секрет не попадает в аудит");
  assert.equal(state.tainted, true, "чтение внешнего источника помечает сессию");
});

test("лимит вызовов отклоняет и это видно в аудите", async () => {
  const { createRegistry } = await import("../lib/tool-registry.js");
  const { makeLimits } = await import("../lib/trust-guard.js");
  const r = createRegistry({ limits: makeLimits({ maxPerSession: 1 }) });
  r.register({ name: "memory_search", handler: async () => "ок", side_effect: "none" });
  r.enable("memory_search");
  assert.equal((await r.dispatch("memory_search", {}, { profile: "readonly" })).ok, true);
  const second = await r.dispatch("memory_search", {}, { profile: "readonly" });
  assert.equal(second.code, "session_limit");
  assert.ok(r.audit().some((x) => x.code === "session_limit"));
});

test("недоверенная сессия + опасный инструмент = отказ без подтверждения", async () => {
  const { createRegistry } = await import("../lib/tool-registry.js");
  const r = createRegistry();
  r.register({ name: "fs_write", handler: async () => "записал", side_effect: "write" });
  r.enable("fs_write");
  const res = await r.dispatch("fs_write", { path: "/x" }, { profile: "full", sessionState: { tainted: true } });
  assert.equal(res.ok, false);
  assert.equal(res.code, "needs_approval");
});

test("ошибка обработчика фиксируется в аудите", async () => {
  const { createRegistry } = await import("../lib/tool-registry.js");
  const r = createRegistry();
  r.register({ name: "memory_search", handler: async () => { throw new Error("сбой чтения"); }, side_effect: "none" });
  r.enable("memory_search");
  const res = await r.dispatch("memory_search", {}, { profile: "readonly" });
  assert.equal(res.code, "handler_error");
  assert.ok(r.audit().some((x) => x.code === "handler_error"));
});
