/**
 * skill-catalog — каталог навыков и загрузка по требованию (шаг 3 плана).
 *
 * Принцип: в контексте постоянно живёт только КАТАЛОГ (имя + одна строка описания + триггеры),
 * а полный текст навыка подгружается вызовом skill_load, когда он действительно нужен.
 * Это и есть экономия контекста: 17 навыков не занимают место, пока не понадобились.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseNote } from "./memory-index.js";
import { trimResult } from "./blob-store.js";

const oneLine = (s, n = 160) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

/** Собирает каталог: [{name, path, description, triggers}] из каталогов навыков. */
export function buildCatalog(dirs, deps = {}) {
  const list = deps.list || ((d) => { try { return readdirSync(d); } catch { return []; } });
  const read = deps.read || ((p) => readFileSync(p, "utf8"));
  const isDir = deps.isDir || ((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  const out = [];
  for (const dir of dirs || []) {
    for (const entry of list(dir)) {
      let file = null;
      if (isDir(join(dir, entry))) { try { file = join(dir, entry, "SKILL.md"); read(file); } catch { file = null; } }
      if (!file) { try { file = join(dir, entry); read(file); } catch { continue; } }
      if (!/\.md$/i.test(file)) continue;
      try {
        const { meta, body } = parseNote(read(file));
        const name = String(meta.name || entry.replace(/^SKILL\.md$/i, "").replace(/\.md$/i, ""));
        const triggers = Array.isArray(meta.triggers) ? meta.triggers : String(meta.triggers || "").split(",").map((s) => s.trim()).filter(Boolean);
        out.push({ name, path: file, description: oneLine(meta.description || body), triggers });
      } catch { /* нечитаемый навык пропускаем */ }
    }
  }
  const seen = new Set();
  return out.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}

/** Компактный список для контекста: имя + описание (без полного текста). */
export function catalogPrompt(catalog, { max = 40 } = {}) {
  return catalog.slice(0, max).map((s) => "- " + s.name + ": " + s.description).join("\n");
}

/** Навыки, чьи триггеры встречаются во входящем тексте (регистронезависимо). */
export function matchTriggers(catalog, text, { limit = 3 } = {}) {
  const t = String(text || "").toLowerCase();
  if (!t) return [];
  const hits = [];
  for (const s of catalog) {
    for (const trigger of s.triggers) {
      const v = String(trigger).toLowerCase().trim();
      if (v && t.includes(v)) { hits.push(s); break; }
    }
  }
  return hits.slice(0, limit);
}

export function installSkillCatalog(ctx, opts = {}) {
  const catalog = buildCatalog(opts.dirs || [], opts.deps || {});
  const loaded = [];
  const load = (name, { max = 12000, store = null } = {}) => {
    const s = catalog.find((x) => x.name === name);
    if (!s) return { ok: false, error: "навык не найден: " + name };
    const raw = String(opts.deps?.read ? opts.deps.read(s.path) : readFileSync(s.path, "utf8"));
    const trimmed = trimResult(raw, { max, store });
    loaded.push({ name, at: Date.now(), bytes: raw.length });
    return { ok: true, name: s.name, text: trimmed.text, truncated: trimmed.truncated, ref: trimmed.ref || null };
  };
  if (ctx?.tools?.register && opts.registerTool !== false) {
    try {
      ctx.tools.register({
        name: "skill_load",
        description: "Загружает полный текст навыка по имени из каталога (в контексте постоянно живёт только каталог).",
        parameters: { name: { type: "string", required: true } },
        async execute(args) { return load(String(args?.name || ""), { store: opts.store }); },
      });
    } catch { /* уже зарегистрирован */ }
  }
  return { catalog, prompt: () => catalogPrompt(catalog), match: (t) => matchTriggers(catalog, t), load, loaded: () => loaded.slice() };
}
