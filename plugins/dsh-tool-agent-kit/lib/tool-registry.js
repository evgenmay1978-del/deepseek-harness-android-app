/**
 * tool-registry — реестр инструментов + диспетчер + allowlist (шаг 1 плана).
 *
 * Принципы (из разбора Claude и требований ревью):
 *  - инструмент по умолчанию ВЫКЛЮЧЕН (enabled=false): новый инструмент ядра или плагина не появляется «открытым»;
 *  - решение принимает ДИСПЕТЧЕР на исполнении, а не промпт: модель не последняя линия защиты;
 *  - профиль прав: readonly (безопасные чтения) и full (только после подтверждения человеком);
 *  - bash/shell в readonly не попадает никогда; инструменты планирования запрещены в сессиях по расписанию,
 *    иначе цепочка задач самовоспроизводится.
 */
export const PROFILES = {
  readonly: {
    allow: ["memory_search", "fs_read", "android_notify", "screen_look", "skill_load"],
    denyAlways: ["bash", "shell", "run_code", "fs_write"],
    metadataRule: true, // главное правило: side_effect === "none", имена — лишь уточнение
  },
  full: { allow: ["*"], denyAlways: [], metadataRule: false },
};

/** Автоисполнение задач по расписанию: только записи, подписанные человеком (origin=human). */
export function mayAutoExecute(task, { hasHumanSignature = false } = {}) {
  if (!task) return { ok: false, code: "no_task" };
  if (task.origin !== "human") return { ok: false, code: "origin_not_human" };
  if (!hasHumanSignature) return { ok: false, code: "signature_missing" };
  return { ok: true };
}

const SCHEDULE_TOOLS = ["android_schedule", "android_schedule_cancel", "android_schedule_list", "schedule_add"];

import { createHash, randomBytes } from "node:crypto";
import { requiresApproval, taint, makeLimits, maskSecrets, UNTRUSTED_SOURCES } from "./trust-guard.js";

/** Канонический вид аргументов: порядок ключей не влияет на хеш (иначе подмена порядка обходила бы проверку). */
export function canonicalArgs(args) {
  const norm = (v) => Array.isArray(v) ? v.map(norm)
    : v && typeof v === "object" ? Object.keys(v).sort().reduce((a, k) => { a[k] = norm(v[k]); return a; }, {})
    : v;
  return JSON.stringify(norm(args ?? {}));
}

/**
 * Подтверждения человека: одноразовые токены с TTL, привязанные к содержимому вызова.
 * Правка по ревью Claude: булев флаг approved не защищает — после одобрения аргументы можно подменить.
 * Токен привязан к hash(инструмент, канонические аргументы, сессия, профиль), одноразовый и с истечением.
 */
export function makeApprovals({ ttlMs = 120000 } = {}) {
  const store = new Map();
  const digest = (tool, args, sessionId, profile) =>
    createHash("sha256").update([tool, canonicalArgs(args), sessionId || "", profile || ""].join("\n")).digest("hex");
  return {
    issue({ tool, args = {}, sessionId = "", profile = "full", now = Date.now() }) {
      const token = randomBytes(16).toString("hex");
      store.set(token, { h: digest(tool, args, sessionId, profile), exp: now + ttlMs, used: false });
      return { token, expiresAt: now + ttlMs };
    },
    verify({ token, tool, args = {}, sessionId = "", profile = "full", now = Date.now() }) {
      const rec = store.get(token);
      if (!rec) return { ok: false, code: "approval_unknown" };
      if (rec.used) return { ok: false, code: "approval_used" };
      if (now > rec.exp) return { ok: false, code: "approval_expired" };
      if (rec.h !== digest(tool, args, sessionId, profile)) return { ok: false, code: "approval_mismatch" };
      rec.used = true;
      return { ok: true };
    },
    size: () => store.size,
  };
}

export function authorize(reg, rawName, { profile = "readonly", scheduled = false, approved = false, approvals = null, token = null, args = {}, sessionId = "", sessionCaps = [], now = Date.now() } = {}) {
  const name = canonicalToolName(rawName);
  const tool = reg.get(name);
  if (!tool) return { ok: false, reason: "неизвестный инструмент", code: "unknown" };
  if (tool.enabled !== true) return { ok: false, reason: "инструмент выключен по умолчанию", code: "disabled" };
  const p = PROFILES[profile] || PROFILES.readonly;
  // 1) правило по метаданным: в readonly разрешено только явно безвредное (side_effect="none"), независимо от имени.
  if (p.metadataRule && tool.side_effect !== "none") {
    return { ok: false, reason: "профиль readonly допускает только side_effect=none", code: "denied_side_effect" };
  }
  // 2) allowlist — ДО подтверждения: не спрашиваем человека о том, что всё равно запрещено.
  const listed = p.allow.includes("*") || p.allow.includes(name);
  if (!listed) return { ok: false, reason: "нет в allowlist профиля " + profile, code: "denied_allowlist" };
  if ((p.denyAlways || []).includes(name)) return { ok: false, reason: "запрещён профилем " + profile, code: "denied_profile" };
  // 3) сессии по расписанию: инструменты планирования запрещены и по имени (дополнительный барьер к capability).
  if (scheduled && SCHEDULE_TOOLS.includes(name)) return { ok: false, reason: "планирование из сессии по расписанию запрещено", code: "denied_scheduled" };
  // 3) capability вместо имени: сессия по расписанию не получает планирование и запись состояния движка.
  const need = ["schedules", "writes_engine_state"].filter((c) => (tool.capabilities || []).includes(c));
  if (need.length && !need.every((c) => sessionCaps.includes(c))) {
    return { ok: false, reason: "нет capability: " + need.join(", "), code: "denied_capability" };
  }
  if (tool.capabilities?.includes("schedules") && !sessionCaps.includes("schedules")) {
    return { ok: false, reason: "планирование недоступно этой сессии", code: "denied_schedules" };
  }
  // Подтверждение нужно только там, где есть последствия: безвредные инструменты не должны спрашивать человека
  // даже в профиле full, иначе люди начнут одобрять не глядя.
  const needsConfirm = tool.side_effect !== "none" || (tool.capabilities || []).includes("external") || tool.confirm === true;
  if (profile === "full" && needsConfirm) {
    // Приоритет — токен подтверждения (привязан к вызову). Булев флаг оставлен только для обратной совместимости тестов
    // и НЕ считается достаточным там, где есть хранилище подтверждений.
    if (approvals) {
      const v = approvals.verify({ token, tool: name, args, sessionId, profile, now });
      if (!v.ok) return { ok: false, reason: "подтверждение недействительно (" + v.code + ")", code: v.code };
    } else if (!approved) {
      return { ok: false, reason: "профиль full требует подтверждения человека", code: "needs_approval" };
    }
  }
  const allowed = p.allow.includes("*") || p.allow.includes(name);
  if (!allowed) return { ok: false, reason: "нет в allowlist профиля " + profile, code: "denied_allowlist" };
  return { ok: true, code: "allowed" };
}

/** Каноническое имя: версия отбрасывается, регистр и юникод приводятся; алиасы наследуют политику цели. */
export const ALIASES = { shell: "bash", run: "run_code", fs_write: "fs_write" };
export function canonicalToolName(name) {
  const base = String(name || "").trim().toLowerCase().split("@")[0];
  return ALIASES[base] || base;
}

/** Путь разрешён к записи, только если он внутри разрешённого корня и без симлинков/«..» наружу. */
export function guardPath(p, { allowedRoots = [], realpath = (x) => x } = {}) {
  const raw = String(p || "");
  if (!raw || raw.includes("\0")) return { ok: false, code: "path_invalid" };
  const norm = raw.split("/").reduce((acc, part) => {
    if (part === "" || part === ".") return acc;
    if (part === "..") { acc.pop(); return acc; }
    acc.push(part); return acc;
  }, []);
  const resolved = "/" + norm.join("/");
  let real = resolved;
  try { real = realpath(resolved); } catch { /* файла может ещё не быть */ }
  const ok = allowedRoots.some((root) => {
    const r = String(root).replace(/\/+$/, "");
    return real === r || real.startsWith(r + "/");
  });
  if (!ok) return { ok: false, code: "path_forbidden", resolved: real };
  if (String(real).includes("/../")) return { ok: false, code: "path_traversal", resolved: real };
  return { ok: true, resolved: real };
}

export function createRegistry({ limits = makeLimits(), auditLog = null } = {}) {
  const tools = new Map();
  const audit = [];
  let frozen = false;
  const reg = {
    freeze() { frozen = true; return reg; },
    isFrozen: () => frozen,
    register(def) {
      if (frozen) throw new Error("реестр заморожен: изменения только подписанным конфигом и перезапуском");
      if (!def || !def.name) throw new Error("инструменту нужно имя");
      const name = canonicalToolName(def.name);
      // side_effect по умолчанию "unknown" — то есть опасный: инструмент обязан ЯВНО объявить "none", чтобы попасть в readonly.
      tools.set(name, { enabled: false, handler: null, group: "misc", side_effect: "unknown", capabilities: [], ...def, name, enabled: def.enabled === true });
      return reg;
    },
    enable(name) { const t = tools.get(name); if (t) t.enabled = true; return reg; },
    disable(name) { const t = tools.get(name); if (t) t.enabled = false; return reg; },
    get: (name) => tools.get(name),
    list: () => [...tools.values()].map((t) => ({ name: t.name, group: t.group, enabled: t.enabled })),
    audit: () => audit.slice(),
    /** Диспетчер: единственное место, где решается, можно ли вызвать инструмент. */
    async dispatch(rawName, args, opts = {}) {
      const name = canonicalToolName(rawName);
      const tool = tools.get(name);
      const now = opts.now || Date.now();
      const record = (phase, ok, code, extra = {}) => {
        const row = { at: now, name, phase, ok, code, args: maskSecrets(args), ...extra };
        audit.push(row);
        try { auditLog?.append(row); } catch { /* аудит не должен ломать работу */ }
      };
      // 1) лимиты: сессия, минута, глубина — до всякой авторизации.
      const lim = limits.check({ sessionId: opts.sessionId || "default", depth: opts.depth || 0, now });
      if (!lim.ok) { record("pre", false, lim.code); return { ok: false, error: "лимит: " + lim.code, code: lim.code }; }
      // 2) подтверждение: опасные инструменты при недоверенных данных требуют человека.
      const appr = requiresApproval(tool, { tainted: !!opts.sessionState?.tainted });
      const verdict = authorize(reg, name, { ...opts, approvalRequired: appr.needed });
      record("pre", verdict.ok, verdict.code, { taint: !!opts.sessionState?.tainted, approval: appr.needed ? appr.why : null });
      if (!verdict.ok) return { ok: false, error: verdict.reason, code: verdict.code };
      if (typeof tool?.handler !== "function") { record("pre", false, "no_handler"); return { ok: false, error: "у инструмента нет обработчика", code: "no_handler" }; }
      try {
        const result = await tool.handler(args, opts);
        record("post", true, "done");
        // 3) taint: чтение недоверенного источника помечает сессию.
        const src = (tool.capabilities || []).find((c) => UNTRUSTED_SOURCES.includes(c));
        if (src && opts.sessionState) taint(opts.sessionState, src);
        return { ok: true, result };
      } catch (e) {
        record("post", false, "handler_error", { error: String(e?.message || e).slice(0, 200) });
        return { ok: false, error: String(e?.message || e), code: "handler_error" };
      }
    },
  };
  return reg;
}
