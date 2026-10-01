import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAudit } from "../lib/audit-log.js";

test("записи добавляются и цепочка цела", () => {
  const p = join(mkdtempSync(join(tmpdir(), "aud-")), "audit.jsonl");
  const a = makeAudit(p, { now: () => 1 });
  a.append({ tool: "memory_search", ok: true, code: "allowed" });
  a.append({ tool: "bash", ok: false, code: "denied_profile" });
  assert.equal(a.rows().length, 2);
  assert.equal(a.verify().ok, true);
});

test("подмена записи обнаруживается", () => {
  const p = join(mkdtempSync(join(tmpdir(), "aud-")), "audit.jsonl");
  const a = makeAudit(p, { now: () => 1 });
  a.append({ tool: "bash", ok: false, code: "denied_profile" });
  a.append({ tool: "fs_read", ok: true, code: "allowed" });
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  const rec = JSON.parse(lines[0]);
  rec.ok = true; rec.code = "allowed";               // подделка: «разрешили bash»
  lines[0] = JSON.stringify(rec);
  writeFileSync(p, lines.join("\n") + "\n");
  const v = makeAudit(p).verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 0);
});

test("удаление записи из середины ломает цепочку", () => {
  const p = join(mkdtempSync(join(tmpdir(), "aud-")), "audit.jsonl");
  const a = makeAudit(p, { now: () => 1 });
  a.append({ n: 1 }); a.append({ n: 2 }); a.append({ n: 3 });
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  writeFileSync(p, [lines[0], lines[2]].join("\n") + "\n");
  const v = makeAudit(p).verify();
  assert.equal(v.ok, false);
});
