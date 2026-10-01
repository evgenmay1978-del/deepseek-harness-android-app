/**
 * Восстановление службы спец. возможностей после перезапуска приложения.
 *
 * Факт (замер 30.09.2026): когда процесс приложения умирает, Android вычищает наш компонент
 * из enabled_accessibility_services. После каждого перезапуска служба выключена, и все экранные
 * инструменты (штатные и этого плагина) мертвы, пока её не включат руками.
 *
 * Здесь это делает сам плагин при старте движка: читает настройку через привилегированный канал
 * App (/shell, Shizuku uid 2000), при отсутствии компонента ставит его обратно и проверяет,
 * что служба реально отвечает. Всё best-effort: ошибка не должна ронять загрузку плагина.
 * Выключить: DSH_A11Y_BOOT=off. Другой компонент: DSH_A11Y_COMPONENT=<pkg>/<cls>.
 */
import { call } from "./a11y.js";

const COMPONENT = process.env.DSH_A11Y_COMPONENT || "com.deepseek.harness/com.deepseek.harness.AccessibilityService";

/** Одинарные кавычки для shell (значение уходит в settings put). */
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

/** Привилегированная команда через App-процесс: POST 127.0.0.1:<APP_NOTIFY_PORT>/shell. */
export function appShell(command, timeoutMs = 15000) {
  const port = Number(process.env.APP_NOTIFY_PORT) || 3081;
  const token = process.env.APP_LOCAL_TOKEN || "";
  const timeout = Math.max(1000, Math.min(timeoutMs, 60000));
  const body = JSON.stringify({ command, timeout_ms: timeout, token });
  return new Promise((resolve) => {
    import("node:http").then((http) => {
      const req = http.request({
        host: "127.0.0.1", port, path: "/shell", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
      }, (res) => {
        let d = "";
        res.on("data", (c) => d += c);
        res.on("end", () => {
          try { resolve(JSON.parse(d || "{}")); }
          catch { resolve({ ok: false, error: "ответ App /shell не разобран: " + String(d).slice(0, 160) }); }
        });
      });
      req.setTimeout(timeout + 10000, () => { req.destroy(); resolve({ ok: false, transport: true, error: "App /shell: таймаут" }); });
      req.on("error", (e) => resolve({ ok: false, transport: true, error: "App /shell недоступен: " + String(e && e.message || e) }));
      req.write(body);
      req.end();
    }).catch((e) => resolve({ ok: false, error: String(e && e.message || e) }));
  });
}

/** Отвечает ли служба (по факту, а не по записи в настройках). */
async function alive() {
  const v = await call("/dump", { timeoutMs: 4000 });
  return v && v.ok === true;
}

export async function ensureAccessibility(ctx, opts = {}) {
  const log = (m) => (ctx && ctx.logger && ctx.logger.warn ? ctx.logger.warn(m) : console.warn(m));
  if (process.env.DSH_A11Y_BOOT === "off") return { skipped: true };
  const attempts = Math.max(1, opts.attempts || 3);
  const delayMs = Math.max(500, opts.delayMs || 4000);
  try {
    const cur = await appShell("settings get secure enabled_accessibility_services");
    if (typeof cur.exit_code !== "number") {
      log("[agent-kit] a11y-boot: привилегированный канал недоступен (" + (cur.error || "?") + ")");
      return { ok: false, error: cur.error };
    }
    const list = String(cur.stdout || "").trim();
    if (list.indexOf(COMPONENT) === -1) {
      const next = list ? list + ":" + COMPONENT : COMPONENT;
      const w = await appShell("settings put secure enabled_accessibility_services " + shq(next) + "; settings put secure accessibility_enabled 1");
      log("[agent-kit] a11y-служба была выключена системой — включаю заново (exit=" + w.exit_code +
          (w.stderr ? ", " + String(w.stderr).trim().slice(0, 120) : "") + ")");
    }
    for (let i = 1; i <= attempts; i++) {
      if (await alive()) return { ok: true, attempts: i };
      await new Promise((res) => setTimeout(res, delayMs));
    }
    log("[agent-kit] a11y-boot: служба прописана, но не отвечает — нужно разрешение в системных настройках");
    return { ok: false, error: "служба не отвечает" };
  } catch (e) {
    log("[agent-kit] a11y-boot: " + (e && e.message || e));
    return { ok: false, error: String(e && e.message || e) };
  }
}
