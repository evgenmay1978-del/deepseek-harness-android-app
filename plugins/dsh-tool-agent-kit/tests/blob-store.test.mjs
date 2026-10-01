import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBlobStore, trimResult } from "../lib/blob-store.js";

test("короткий результат не трогаем", () => {
  const r = trimResult("короткий ответ", { max: 100 });
  assert.equal(r.truncated, false);
  assert.equal(r.text, "короткий ответ");
});

test("длинный результат усекается, полный доступен по ссылке", () => {
  const store = makeBlobStore(mkdtempSync(join(tmpdir(), "blob-")));
  const long = "начало-" + "x".repeat(9000) + "-хвост";
  const r = trimResult(long, { max: 1000, store });
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 1100, "в контекст уходит усечённое");
  assert.ok(r.text.includes("усечено"), "есть пометка");
  assert.equal(store.get(r.ref, { owner: "default" }).text, long, "полный текст сохранён и читается владельцем");
});

test("без хранилища усечение тоже работает", () => {
  const r = trimResult("y".repeat(5000), { max: 500 });
  assert.ok(r.truncated && r.text.length <= 600 && !r.ref);
});

test("блоб доступен владельцу и недоступен чужой сессии", async () => {
  const { makeBlobStore } = await import("../lib/blob-store.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const st = makeBlobStore(mkdtempSync(join(tmpdir(), "blob-")));
  const { ref } = st.put("секретный текст", { owner: "s1" });
  assert.equal(st.get(ref, { owner: "s1" }).text, "секретный текст");
  assert.equal(st.get(ref, { owner: "s2" }).code, "ref_foreign");
  assert.equal(st.get("../etc/passwd").code, "ref_invalid");
  assert.equal(st.get("a".repeat(16)).code, "ref_missing");
});

test("усечение кладёт блоб владельцу сессии", async () => {
  const { makeBlobStore, trimResult } = await import("../lib/blob-store.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const st = makeBlobStore(mkdtempSync(join(tmpdir(), "blob-")));
  const r = trimResult("x".repeat(5000), { max: 500, store: st, owner: "s7" });
  assert.equal(st.get(r.ref, { owner: "s7" }).ok, true);
  assert.equal(st.get(r.ref, { owner: "s8" }).code, "ref_foreign");
});
