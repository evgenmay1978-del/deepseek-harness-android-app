/**
 * Долговременная память агента: небольшой JSON-файл, атомарная запись (tmp → rename).
 *
 * Принципы:
 *  - никакого молчаливого искажения: слишком длинный текст отклоняется с ошибкой, а не обрезается;
 *  - битый файл не теряется: переименовывается в *.corrupt-<ts>, работа продолжается с пустой памятью;
 *  - version растёт при каждом изменении — по нему решаем, пора ли снова показать заметки модели.
 * (взято из dsh-tool-agent-kit v0.3, 30.09.2026)
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export const LIMITS = { maxItems: 200, maxText: 500, maxTagsLen: 80 };

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
const tokens = (s) => norm(s).split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length >= 2);

export class MemoryStore {
  constructor(file, opts = {}) {
    this.file = file;
    this.now = opts.now ?? Date.now;
    this.data = undefined;
  }

  #load() {
    if (this.data) return this.data;
    let data = { version: 0, next: 1, items: [] };
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8"));
        if (raw && Array.isArray(raw.items)) {
          data = { version: Number(raw.version) || 0, next: Number(raw.next) || raw.items.length + 1, items: raw.items };
        } else throw new Error("неожиданная структура");
      } catch {
        try { renameSync(this.file, this.file + ".corrupt-" + this.now()); } catch { /* не критично */ }
      }
    }
    return (this.data = data);
  }

  #save() {
    const d = this.#load();
    d.version += 1;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(d), "utf8");
    renameSync(tmp, this.file);
    this.#mirror();
  }

  /** Зеркало markdown: заметки agent_memory видны memory_search (walkMd индексирует подкаталоги). */
  #mirror() {
    const dir = join(dirname(this.file), "notes");
    try {
      mkdirSync(dir, { recursive: true });
      const seen = new Set();
      for (const it of this.#load().items) {
        seen.add(it.id + ".md");
        const fm = "---\nid: " + it.id + "\ntags: " + (it.tags || "") + "\nupdated: " + new Date(it.updated).toISOString().slice(0, 10) + "\n---\n" + it.text;
        writeFileSync(join(dir, it.id + ".md"), fm, "utf8");
      }
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".md") && !seen.has(f)) { try { rmSync(join(dir, f), { force: true }); } catch { /* не критично */ } }
      }
    } catch { /* зеркало не критично */ }
  }

  version() { return this.#load().version; }
  count() { return this.#load().items.length; }

  add({ text, tags = "", pinned = false }) {
    const t = String(text ?? "").trim();
    if (!t) return { ok: false, error: "text пустой" };
    if (t.length > LIMITS.maxText) return { ok: false, error: "text длиннее " + LIMITS.maxText + " символов (сейчас " + t.length + ") — сократите или разбейте на несколько заметок" };
    const tg = String(tags ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).join(",");
    if (tg.length > LIMITS.maxTagsLen) return { ok: false, error: "tags длиннее " + LIMITS.maxTagsLen + " символов" };
    const d = this.#load();
    const dup = d.items.find((i) => norm(i.text) === norm(t));
    if (dup) {
      dup.updated = this.now();
      if (pinned) dup.pinned = true;
      if (tg) dup.tags = tg;
      this.#save();
      return { ok: true, id: dup.id, duplicate: true };
    }
    if (d.items.length >= LIMITS.maxItems) {
      const victim = [...d.items].filter((i) => !i.pinned).sort((a, b) => a.updated - b.updated)[0];
      if (!victim) return { ok: false, error: "память заполнена (" + LIMITS.maxItems + "), все заметки закреплены — удалите лишние" };
      d.items.splice(d.items.indexOf(victim), 1);
    }
    const id = "m" + d.next++;
    const ts = this.now();
    d.items.push({ id, text: t, tags: tg, pinned: pinned === true, created: ts, updated: ts });
    this.#save();
    return { ok: true, id };
  }

  remove(id) {
    const d = this.#load();
    const i = d.items.findIndex((x) => x.id === String(id));
    if (i < 0) return false;
    d.items.splice(i, 1);
    this.#save();
    return true;
  }

  pin(id, pinned) {
    const it = this.#load().items.find((x) => x.id === String(id));
    if (!it) return false;
    it.pinned = pinned === true;
    it.updated = this.now();
    this.#save();
    return true;
  }

  #ordered() {
    return [...this.#load().items].sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
  }

  list(limit = 30) { return this.#ordered().slice(0, Math.max(1, limit)); }

  search(query, limit = 10) {
    const q = tokens(query);
    if (q.length === 0) return [];
    const scored = [];
    for (const it of this.#load().items) {
      const hay = norm(it.text + " " + it.tags);
      const score = q.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      if (score > 0) scored.push({ it, score });
    }
    scored.sort((a, b) => (b.score - a.score) || (b.it.pinned - a.it.pinned) || (b.it.updated - a.it.updated));
    return scored.slice(0, Math.max(1, limit)).map((x) => x.it);
  }

  render(maxItems = 15, maxChars = 1800) {
    const lines = [];
    let chars = 0;
    for (const it of this.#ordered()) {
      if (lines.length >= maxItems) break;
      const l = "- [" + it.id + "]" + (it.pinned ? " 📌" : "") + " " + it.text + (it.tags ? " #" + it.tags.split(",").join(" #") : "");
      if (chars + l.length > maxChars) break;
      lines.push(l);
      chars += l.length + 1;
    }
    const total = this.count();
    if (lines.length === 0) return "";
    if (lines.length < total) lines.push("… ещё " + (total - lines.length) + ": agent_memory(action=search|list)");
    return lines.join("\n");
  }
}

export const formatItem = (it) => "[" + it.id + "]" + (it.pinned ? " 📌" : "") + " " + it.text + (it.tags ? "  #" + it.tags.split(",").join(" #") : "");
