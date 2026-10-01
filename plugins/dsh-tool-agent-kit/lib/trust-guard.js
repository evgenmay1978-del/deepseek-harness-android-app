/**
 * trust-guard — работа с недоверенным содержимым и сопутствующие предохранители (правки по ревью Claude).
 *
 * Идея: экран, результаты инструментов, память, handoff.json и скиллы — это ДАННЫЕ, которые мог написать
 * посторонний или сам агент. После чтения такого источника сессия помечается taint, и опасные инструменты
 * требуют подтверждения человека даже в доверенном профиле.
 */
import { createHash } from "node:crypto";

/** Отметка недоверия: какие источники её ставят. */
export const UNTRUSTED_SOURCES = ["screen", "tool_result", "memory", "handoff", "skill", "web", "external"];

export function taint(state, source) {
  const s = state || {};
  s.tainted = true;
  s.taintedBy = [...new Set([...(s.taintedBy || []), String(source)])];
  return s;
}

/** Липкая метка: taint можно только ПОВЫСИТЬ. Сжатие контекста и handoff не должны её снимать. */
export function mergeTaint(state, incoming) {
  const s = state || {};
  if (incoming?.tainted) s.tainted = true;
  s.taintedBy = [...new Set([...(s.taintedBy || []), ...(incoming?.taintedBy || [])])];
  return s;
}

/** Нужно ли подтверждение: опасные побочные эффекты при работе с недоверенными данными — всегда. */
export function requiresApproval(tool, { tainted = false } = {}) {
  const effect = String(tool?.side_effect || "unknown");
  const external = (tool?.capabilities || []).includes("external");
  if (effect === "none" && !external) return { needed: false };
  if (tainted) return { needed: true, why: "в сессии есть недоверенные данные" };
  if (effect === "destructive" || external) return { needed: true, why: "опасный побочный эффект" };
  return { needed: false };
}

/** Хеш-фиксация скиллов: каталог пинит содержимое при установке, skill_load сверяет. */
export function pin(deps, catalog) {
  const read = deps.read;
  return (catalog || []).map((s) => {
    let hash = null;
    try { hash = createHash("sha256").update(read(s.path)).digest("hex").slice(0, 16); } catch { /* нет файла */ }
    return { ...s, hash };
  });
}

export function verifyPinned(deps, catalog, name) {
  const entry = (catalog || []).find((s) => s.name === name);
  if (!entry) return { ok: false, code: "skill_unknown" };
  if (!entry.hash) return { ok: false, code: "skill_unpinned" };
  try {
    const now = createHash("sha256").update(deps.read(entry.path)).digest("hex").slice(0, 16);
    if (now !== entry.hash) return { ok: false, code: "skill_modified" };
    return { ok: true };
  } catch { return { ok: false, code: "skill_unreadable" }; }
}

const HANDOFF_FIELDS = ["version", "at", "task", "done", "open", "keys", "next", "tainted", "taintedBy"];
/** handoff.json: берём только известные поля — profile/approved/allowlist оттуда не читаются никогда. */
export function sanitizeHandoff(state) {
  if (!state || typeof state !== "object") return null;
  const out = {};
  for (const k of HANDOFF_FIELDS) if (k in state) out[k] = state[k];
  // taint из файла можно только поднять: "tainted: false" в handoff не снимает метку
  if (out.tainted !== true) delete out.tainted;
  if (!Array.isArray(out.taintedBy)) delete out.taintedBy;
  return out;
}

/** Экранирование запроса для FTS5 MATCH: кавычки и служебные символы не должны ломать/расширять запрос. */
export function escapeFtsQuery(q) {
  return '"' + String(q || "").replace(/"/g, '""').replace(/[\x00-\x1f]/g, " ").trim() + '"';
}

/** Лимиты вызовов: за сессию, в минуту и по глубине вложенности. */
export function makeLimits({ maxPerSession = 500, maxPerMinute = 60, maxDepth = 2 } = {}) {
  const perSession = new Map();
  const perMinute = new Map();
  return {
    check({ sessionId = "default", depth = 0, now = Date.now() } = {}) {
      if (depth > maxDepth) return { ok: false, code: "depth_exceeded" };
      const total = (perSession.get(sessionId) || 0) + 1;
      if (total > maxPerSession) return { ok: false, code: "session_limit" };
      const bucket = Math.floor(now / 60000);
      const key = sessionId + ":" + bucket;
      const inMinute = (perMinute.get(key) || 0) + 1;
      if (inMinute > maxPerMinute) return { ok: false, code: "rate_limited" };
      perSession.set(sessionId, total);
      perMinute.set(key, inMinute);
      return { ok: true, total, inMinute };
    },
  };
}

/** Маскирование секретов в аргументах перед записью в аудит. */
export function maskSecrets(args) {
  const keys = /token|secret|password|passwd|key|authorization|cookie/i;
  const walk = (v) => Array.isArray(v) ? v.map(walk)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keys.test(k) ? "<скрыто>" : walk(x)]))
    : v;
  return walk(args ?? {});
}
