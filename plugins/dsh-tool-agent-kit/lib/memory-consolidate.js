/**
 * memory-consolidate — ночная консолидация памяти (шаг 6 плана).
 *
 * Задача: не дать памяти зарастать дублями. Записи группируются по ключу факта (frontmatter key);
 * если по ключу несколько записей, самая свежая остаётся актуальной, а у неё проставляется
 * supersedes: [остальные id] — тогда поиск (FTS5) показывает только её. Операция идемпотентна:
 * повторный прогон ничего не меняет. Есть dryRun — сначала отчёт, потом запись.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseNote } from "./memory-index.js";

const stamp = (meta) => {
  const t = Date.parse(String(meta.updated || ""));
  return Number.isFinite(t) ? t : 0;
};

/** Разбор каталога: [{file, meta, body}] */
export function scan(dir, deps = {}) {
  const list = deps.list || ((d) => { try { return readdirSync(d).filter((f) => f.endsWith(".md")); } catch { return []; } });
  const read = deps.read || ((p) => readFileSync(p, "utf8"));
  const out = [];
  for (const f of list(dir)) {
    try { const { meta, body } = parseNote(read(join(dir, f))); out.push({ file: f, path: join(dir, f), meta, body }); } catch { /* пропускаем */ }
  }
  return out;
}

/** План консолидации: по каждому ключу — актуальная запись и те, кого она заменяет. */
export function plan(notes) {
  const byKey = new Map();
  for (const n of notes) {
    const key = String(n.meta.key || "").trim();
    if (!key) continue;
    const arr = byKey.get(key) || [];
    arr.push(n);
    byKey.set(key, arr);
  }
  const groups = [];
  for (const [key, arr] of byKey) {
    if (arr.length < 2) continue;
    const sorted = [...arr].sort((a, b) => stamp(b.meta) - stamp(a.meta) || String(a.meta.id).localeCompare(String(b.meta.id)));
    const winner = sorted[0];
    const losers = sorted.slice(1).map((n) => String(n.meta.id || n.file.replace(/\.md$/, "")));
    const already = new Set((Array.isArray(winner.meta.supersedes) ? winner.meta.supersedes : String(winner.meta.supersedes || "").split(/[,\s]+/)).filter(Boolean));
    const need = losers.filter((id) => !already.has(id));
    groups.push({ key, winner: winner.file, winnerId: String(winner.meta.id || winner.file.replace(/\.md$/, "")), losers, need });
  }
  return groups;
}

/** Применение: дописывает supersedes в frontmatter актуальной записи. Возвращает отчёт. */
export function consolidate(dir, { deps = {}, dryRun = true } = {}) {
  const notes = scan(dir, deps);
  const groups = plan(notes);
  const changed = [];
  const write = deps.write || ((p, s) => writeFileSync(p, s, "utf8"));
  for (const g of groups) {
    if (!g.need.length) continue;
    if (dryRun) { changed.push({ ...g, applied: false }); continue; }
    const note = notes.find((n) => n.file === g.winner);
    if (!note) continue;
    const raw = deps.read ? deps.read(note.path) : readFileSync(note.path, "utf8");
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!m) continue;
    const fm = m[1];
    const merged = [...new Set([...(String(fm.match(/^supersedes:\s*(.*)$/m)?.[1] || "").replace(/[\[\]]/g, "").split(/[,\s]+/).filter(Boolean)), ...g.need])];
    const fmNew = /^supersedes:/m.test(fm)
      ? fm.replace(/^supersedes:.*$/m, "supersedes: [" + merged.join(", ") + "]")
      : fm + "\nsupersedes: [" + merged.join(", ") + "]";
    write(note.path, raw.replace(m[1], fmNew));
    changed.push({ ...g, applied: true });
  }
  return { scanned: notes.length, groups: groups.length, changed, dryRun };
}
