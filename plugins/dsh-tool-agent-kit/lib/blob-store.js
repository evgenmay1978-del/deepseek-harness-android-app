// blob-store — усечение результатов инструментов с сохранением полного текста.
// Пункт 2 плана: дёшево и самый заметный выигрыш по контексту — длинные результаты не летят в модель целиком.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const REF_RE = /^[a-f0-9]{16,64}$/;   // ссылка обязана быть хешем: это отсекает «../» и любые пути

export function makeBlobStore(dir, { indexFile = null } = {}) {
  const ensure = () => { try { mkdirSync(dir, { recursive: true }); } catch { /* уже есть */ } };
  const idxPath = indexFile || join(dir, "_index.json");
  const readIndex = () => { try { return JSON.parse(readFileSync(idxPath, "utf8")); } catch { return {}; } };
  const writeIndex = (idx) => { try { writeFileSync(idxPath, JSON.stringify(idx), "utf8"); } catch { /* не критично */ } };
  return {
    dir,
    /** owner — сессия-владелец: чужой не сможет прочитать блоб даже зная ссылку. */
    put(text, { owner = "default" } = {}) {
      ensure();
      const body = String(text ?? "");
      const ref = createHash("sha256").update(owner + "\n" + body).digest("hex");
      try {
        writeFileSync(join(dir, ref + ".txt"), body, "utf8");
        const idx = readIndex(); idx[ref] = { owner, bytes: body.length, at: Date.now() }; writeIndex(idx);
      } catch { return { ref: null, bytes: body.length, error: "запись не удалась" }; }
      return { ref, bytes: body.length, path: join(dir, ref + ".txt") };
    },
    get(ref, { owner = null } = {}) {
      const r = String(ref || "");
      if (!REF_RE.test(r)) return { ok: false, code: "ref_invalid" };
      const idx = readIndex();
      const meta = idx[r];
      if (owner !== null && meta && meta.owner !== owner) return { ok: false, code: "ref_foreign" };
      try { return { ok: true, text: readFileSync(join(dir, r + ".txt"), "utf8"), owner: meta ? meta.owner : null }; }
      catch { return { ok: false, code: "ref_missing" }; }
    },
  };
}

/** Усекает результат для контекста, полный текст (если есть хранилище) кладёт в блоб. */
export function trimResult(value, { max = 4000, store = null, keepHead = 0.7, owner = "default" } = {}) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= max) return { text, truncated: false, bytes: text.length };
  const tail = Math.max(0, Math.floor(max * (1 - keepHead)) - 120);
  const head = max - tail - 120;
  const saved = store ? store.put(text, { owner }) : { ref: null, bytes: text.length };
  const marker = "\n[... усечено " + (text.length - head - tail) + " символов"
    + (saved.ref ? "; полный текст: blob:" + saved.ref : "") + " ...]\n";
  return { text: text.slice(0, head) + marker + text.slice(text.length - tail), truncated: true, bytes: text.length, ref: saved.ref };
}
