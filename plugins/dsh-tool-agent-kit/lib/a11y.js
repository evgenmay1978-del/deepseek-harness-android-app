/**
 * Клиент к AccessibilityService (локальный HTTP, APP_A11Y_PORT).
 *
 * Отличие от 05-tools-accessibility.js: различает ТРАНСПОРТНЫЕ ошибки
 * (сервис недоступен — тогда уместно «включите службу») и ПРИКЛАДНЫЕ
 * (сервис жив, но действие не удалось — эту ошибку нельзя подменять гайдом).
 */
import { request as httpRequest } from "node:http";

export const MAX_BODY = 1024 * 1024; // 1 МБ: большие деревья не должны маскироваться под «сервис недоступен»

export const GUIDE_TEXT =
  "Служба спец. возможностей недоступна: Настройки → Спец. возможности → включите «DeepSeek Harness 屏幕助手», затем откройте приложение и повторите.";

const port = () => parseInt(process.env.APP_A11Y_PORT || "3181", 10);

/**
 * @param {string} path
 * @param {{params?:Record<string,string>, body?:unknown, timeoutMs?:number, signal?:AbortSignal}} [opt]
 * @returns {Promise<{ok:boolean, transport?:boolean, error?:string, [k:string]:any}>}
 */
export function call(path, opt = {}) {
  const { params, body, timeoutMs = 8000, signal } = opt;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    if (signal?.aborted) return finish({ ok: false, transport: false, error: "отменено" });

    const qs = params && Object.keys(params).length
      ? "?" + Object.entries(params).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&")
      : "";
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      host: "127.0.0.1",
      port: port(),
      path: path + qs,
      method: payload === undefined ? "GET" : "POST",
      timeout: timeoutMs,
      headers: payload === undefined ? {} : {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = "";
      let size = 0;
      res.setEncoding("utf8");
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          finish({ ok: false, transport: false, error: `ответ службы больше ${MAX_BODY} байт (экран слишком сложный)` });
          req.destroy();
          return;
        }
        data += c;
      });
      res.on("end", () => {
        if (!data) return finish({ ok: false, transport: true, error: "пустой ответ" });
        try { finish(JSON.parse(data)); }
        catch { finish({ ok: false, transport: false, error: "не удалось разобрать ответ: " + data.slice(0, 120) }); }
      });
      res.on("error", () => finish({ ok: false, transport: true, error: "обрыв соединения" }));
    });
    req.on("error", () => finish({ ok: false, transport: true, error: "локальный сервис недоступен" }));
    req.on("timeout", () => { req.destroy(); finish({ ok: false, transport: true, error: "локальный сервис не ответил вовремя" }); });
    signal?.addEventListener("abort", () => { req.destroy(); finish({ ok: false, transport: false, error: "отменено" }); }, { once: true });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Транспортная ошибка → человекочитаемый гайд; прикладную оставляем как есть. */
export function explain(v) {
  if (v && v.ok === false && v.transport) return { ...v, error: GUIDE_TEXT + " (" + v.error + ")" };
  return v;
}

/** Прерываемый sleep. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
