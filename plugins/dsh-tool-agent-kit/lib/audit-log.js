/**
 * audit-log — журнал решений и действий с цепочкой хешей (tamper-evident).
 *
 * Зачем: файлы в каталоге приложения доступны агенту, поэтому обычный лог можно переписать.
 * Здесь каждая запись содержит хеш предыдущей: правка любой строки ломает цепочку, и это видно проверкой.
 * Журнал — доказательство, а не граница безопасности; границей остаётся подтверждение человеком.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const sha = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 32);
const GENESIS = "0".repeat(32);

export function makeAudit(path, { now = () => Date.now() } = {}) {
  const read = () => {
    try {
      return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  };
  return {
    path,
    append(entry) {
      const rows = read();
      const prev = rows.length ? rows[rows.length - 1].hash : GENESIS;
      const base = { at: now(), prev, ...entry };
      const rec = { ...base, hash: sha(JSON.stringify(base)) };
      try { appendFileSync(path, JSON.stringify(rec) + "\n", "utf8"); } catch { /* нет прав — не роняем работу */ }
      return rec;
    },
    rows: read,
    /** Проверка целостности: true — цепочка цела, иначе номер первой сломанной записи. */
    verify() {
      const rows = read();
      let prev = GENESIS;
      for (let i = 0; i < rows.length; i++) {
        const { hash, ...base } = rows[i];
        if (base.prev !== prev) return { ok: false, brokenAt: i, why: "разрыв цепочки" };
        if (sha(JSON.stringify(base)) !== hash) return { ok: false, brokenAt: i, why: "запись изменена" };
        prev = hash;
      }
      return { ok: true, rows: rows.length };
    },
  };
}
