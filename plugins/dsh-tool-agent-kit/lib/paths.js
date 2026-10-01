/**
 * Каталог files/ приложения (там живут dshhome/dshroot и наши данные).
 * Порядок: DSH_FILES_DIR → ближайший предок process.execPath, где есть dshhome/ или dshroot/ → константа.
 * (взято из dsh-tool-agent-kit v0.3 lib/busy.js, чтобы не тянуть весь busy-модуль: wake lock без патча APK не работает)
 */
import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

export const FALLBACK_FILES_DIR = "/data/user/0/com.deepseek.harness/files";

export function detectFilesDir(env = process.env, execPath = process.execPath, exists = existsSync) {
  if (env.DSH_FILES_DIR) return env.DSH_FILES_DIR;
  try {
    let dir = dirname(execPath);
    const root = parse(dir).root;
    let nested = null; // <files>/payload — там лежат dshhome/dshroot, но это НЕ каталог приложения
    for (let i = 0; i < 8 && dir && dir !== root; i++, dir = dirname(dir)) {
      // Каталог приложения files/ — тот, внутри которого лежит payload/ (совпадает с Java getFilesDir()).
      if (exists(join(dir, "payload"))) return dir;
      if (nested === null && (exists(join(dir, "dshhome")) || exists(join(dir, "dshroot")))) nested = dir;
    }
    if (nested !== null) return nested;
  } catch { /* к константе */ }
  return FALLBACK_FILES_DIR;
}
