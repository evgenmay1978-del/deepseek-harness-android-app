/**
 * Инструменты виртуального экрана, которых не хватает в приложении.
 *
 * Живая проблема (30.09.2026): открыть URL на виртуальном экране можно было только вручную —
 * `android_intent` не прокидывает `--display`, а набор URL в адресную строку браузера уходит в поиск.
 * Здесь один инструмент, который делает это правильно: `am start --display <N> -a VIEW -d <url> <пакет>`
 * через привилегированный канал приложения (/shell, uid 2000) с повтором и понятной ошибкой.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { appPost } from "./schedule-tools.js";

const okOutput = (extra = {}) => ({
  type: "object",
  additionalProperties: false,
  properties: { ok: { type: "boolean", required: true }, error: { type: "string" }, text: { type: "string" }, ...extra }
});
const renderText = (_a, v) => [{
  type: "text",
  text: v && v.ok ? (v.text || "готово") : "Не удалось: " + ((v && v.error) || "неизвестная ошибка")
}];

export function registerVscreenTools(ctx) {
  ctx.tools.register(defineTool({
    name: "vscreen_open_url",
    description:
      "Открывает URL на выбранном дисплее (по умолчанию — на виртуальном экране приложения). " +
      "Надёжнее, чем android_intent: тот не прокидывает --display, а браузер уводит ручной ввод в поиск. " +
      "display — номер дисплея (у виртуального экрана его выдаёт android_vscreen_create).",
    parameters: {
      url: { type: "string", required: true, description: "Адрес (http/https)" },
      display: { type: "number", description: "Номер дисплея; без него откроется на основном" },
      package: { type: "string", description: "Пакет браузера (по умолчанию com.yandex.browser)" }
    },
    output: { schema: okOutput(), render: renderText },
    async execute(args, exec) {
      const url = String(args?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: "нужен http(s)-адрес" };
      const pkg = String(args?.package || "com.yandex.browser");
      const display = args?.display === undefined ? "" : " --display " + Math.trunc(Number(args.display));
      const cmd = "am start" + display + " -a android.intent.action.VIEW -d '" + url.replace(/'/g, "") + "' " + pkg;
      let last = "";
      for (let i = 1; i <= 2; i++) {
        try {
          const r = await appPost("/shell", { command: cmd, timeout_ms: 15000 }, exec?.signal);
          const out = String((r && (r.stdout || r.stderr)) || "");
          if (r && r.ok && /Starting: Intent/i.test(out)) {
            return { ok: true, text: "открыто на " + (display ? "дисплее " + Math.trunc(Number(args.display)) : "основном дисплее") + ": " + url };
          }
          last = out.slice(0, 200) || (r && r.error) || "нет ответа";
        } catch (e) { last = (e && e.message) || String(e); }
      }
      return { ok: false, error: last };
    }
  }));
}
