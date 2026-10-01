/**
 * human-dirs — защита «человеческих» каталогов памяти от записи агентскими инструментами.
 *
 * Допущение, на котором держался приоритет origin по каталогу: «агент не может писать в humanDirs».
 * Здесь оно проверяется, а не предполагается: реальный путь (realpath), симлинки, «..», переименование
 * между каталогами и жёсткие ссылки. Список humanDirs приходит из подписанного конфига или кода.
 */
import { realpathSync, lstatSync, statSync } from "node:fs";

const inside = (p, roots) => roots.some((r) => p === r || p.startsWith(r.replace(/\/+$/, "") + "/"));

export function checkWrite(target, opts = {}) {
  const roots = (opts.humanDirs || []).map((r) => String(r).replace(/\/+$/, ""));
  const realpath = opts.realpath || ((p) => { try { return realpathSync(p); } catch { return null; } });
  const lstat = opts.lstat || ((p) => { try { return lstatSync(p); } catch { return null; } });
  const raw = String(target || "");
  if (!raw || raw.includes("\0")) return { ok: false, code: "path_invalid" };
  if (raw.split("/").includes("..")) return { ok: false, code: "path_traversal" };

  const real = realpath(raw) || raw;
  if (inside(real, roots)) return { ok: false, code: "human_dir_write", resolved: real };

  // Симлинк, ведущий в человеческий каталог (в том числе через промежуточные звенья).
  const st = lstat(raw);
  if (st && st.isSymbolicLink && st.isSymbolicLink()) {
    const linkReal = realpath(raw);
    if (linkReal && inside(linkReal, roots)) return { ok: false, code: "symlink_to_human", resolved: linkReal };
  }
  // Жёсткая ссылка на файл внутри человеческого каталога: у файла больше одной ссылки, и он лежит в humanDirs.
  if (st && typeof st.nlink === "number" && st.nlink > 1) {
    const parentReal = realpath(raw.replace(/\/[^/]+$/, "")) || raw.replace(/\/[^/]+$/, "");
    if (inside(parentReal, roots)) return { ok: false, code: "hardlink_risk" };
  }
  return { ok: true, resolved: real };
}

/** Переименование/перемещение: проверяем И источник, И цель. */
export function checkMove(from, to, opts = {}) {
  const a = checkWrite(from, opts);
  if (!a.ok) return a;
  const b = checkWrite(to, opts);
  if (!b.ok) return b;
  return { ok: true, resolved: b.resolved };
}

/** humanDirs берём из подписанного конфига или из кода, но не из файла, который может править агент. */
export function humanDirsFrom(config = {}) {
  if (Array.isArray(config.humanDirs) && config.signed === true) return config.humanDirs.map(String);
  return config.defaults || [];
}
