import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Постоянный сквозной тест: РЕАЛЬНЫЙ index.js + РЕАЛЬНЫЙ self-check.js, заглушки только ядра.
 * Ловит класс «тихих» дефектов сборки, которые детальные тесты не видят
 * (04.10.2026: ReferenceError на block-scoped store → строка self-check исчезала целиком).
 */
test("e2e: реальный index.js собирается и пишет полную строку self-check", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const r = spawnSync(process.execPath, ["--experimental-vm-modules", join(here, "support", "load-index.mjs")], { encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 0, "загрузчик упал: " + ((r.stderr || r.stdout || "").slice(-600)));
  assert.match(r.stdout, /E2E_LINE .*инструменты/);
  assert.match(r.stdout, /скиллов на диске/);
  assert.match(r.stdout, /память/);
  assert.match(r.stdout, /последняя инъекция ДО СТАРТА/);
});
