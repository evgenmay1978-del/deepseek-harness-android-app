/**
 * Защита хода агента: бюджет шагов + детектор зацикливания + серия ошибок подряд.
 *
 * В README цикла прямо сказано: «No built-in turn budget» — ход может крутиться бесконечно,
 * а на телефоне это ещё и деньги за токены и батарея.
 *
 * Механика (всё опирается на то, что видно в 01/03):
 *   - бюджет: agent/pre-step получает {agent, turn, step, signal}; ответ {kind:'reject'} завершает ход как "blocked"
 *   - наблюдение: session/event отдаёт tool/call и tool/result (data.name/arguments/…)
 *   - предупреждение: user-сообщение в decision.messages (как modelSwitchNotice в 03)
 */

export const DEFAULTS = {
  // Длинная задача (реализация, разбор, рефакторинг) спокойно переходит 60 шагов — при прежнем значении ход
  // обрывался на середине работы. Бюджет теперь мягкий: предупреждения и очень дальний жёсткий предел,
  // который при нужде сужается через DSH_MAX_STEPS / DSH_GUARD_OVERRUN.
  maxSteps: 200,         // мягкий потолок шагов в одном ходе
  warnAtRatio: 0.75,     // предупредить на 75% бюджета
  hardOverrun: 100,      // после maxSteps даём ещё столько шагов на завершение, потом reject
  loopThreshold: 3,      // одинаковый вызов подряд N раз → предупреждение
  loopStop: 6,           // …а столько раз → остановка
  errorStreak: 5         // столько ошибок инструментов подряд → предупреждение/остановка
};

const canon = (v) => {
  try {
    if (typeof v === "string") { try { v = JSON.parse(v); } catch { return v; } }
    return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
  } catch { return String(v); }
};

export class TurnGuard {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.state = new WeakMap(); // session -> состояние текущего хода
  }

  #st(session) {
    let s = this.state.get(session);
    if (!s) { s = { turn: -1, calls: [], errStreak: 0, warned: new Set() }; this.state.set(session, s); }
    return s;
  }

  /** Подаётся из session/event. */
  observe(session, event) {
    if (!session || !event) return;
    const s = this.#st(session);
    const d = event.data || {};
    if (event.type === "turn/start") {
      s.turn = d.turn; s.calls = []; s.errStreak = 0; s.warned = new Set();
    } else if (event.type === "tool/call") {
      s.calls.push(`${d.name}:${canon(d.arguments)}`);
      if (s.calls.length > 50) s.calls.shift();
    } else if (event.type === "tool/result") {
      const failed = d.error !== undefined || d.message?.isError === true;
      s.errStreak = failed ? s.errStreak + 1 : 0;
    }
  }

  /** Сколько раз подряд повторён последний вызов. */
  repeatCount(session) {
    const { calls } = this.#st(session);
    if (calls.length === 0) return 0;
    const last = calls[calls.length - 1];
    let n = 0;
    for (let i = calls.length - 1; i >= 0 && calls[i] === last; i--) n++;
    return n;
  }

  /** Повтор пары A,B,A,B,A,B — типичная «пинг-понг» петля. */
  pingPong(session) {
    const { calls } = this.#st(session);
    if (calls.length < 6) return false;
    const t = calls.slice(-6);
    return t[0] !== t[1] && t[0] === t[2] && t[2] === t[4] && t[1] === t[3] && t[3] === t[5];
  }

  /**
   * @returns {{kind:'ok'}|{kind:'warn',id:string,text:string}|{kind:'stop',reason:string}}
   */
  verdict(session, turn, step) {
    const s = this.#st(session);
    const o = this.o;
    const warnAt = Math.max(1, Math.floor(o.maxSteps * o.warnAtRatio));

    if (step > o.maxSteps + o.hardOverrun) return { kind: "stop", reason: `превышен бюджет шагов (${o.maxSteps})` };
    const rep = this.repeatCount(session);
    if (rep >= o.loopStop) return { kind: "stop", reason: `один и тот же вызов повторён ${rep} раз подряд` };
    if (s.errStreak >= o.errorStreak * 2) return { kind: "stop", reason: `${s.errStreak} ошибок инструментов подряд` };

    const warn = (id, text) => {
      if (s.warned.has(id)) return { kind: "ok" };
      s.warned.add(id);
      return { kind: "warn", id, text };
    };
    if (step > o.maxSteps)
      return warn("over", `[guard] Бюджет шагов исчерпан (${step - 1}/${o.maxSteps}). Больше не вызывай инструменты: коротко подведи итог — что сделано, что не удалось, что нужно от пользователя.`);
    if (rep >= o.loopThreshold)
      return warn(`rep${rep >= o.loopThreshold * 2 ? 2 : 1}`, `[guard] Ты ${rep} раза подряд вызвал один и тот же инструмент с теми же аргументами. Повтор не даст нового результата: смени подход, проверь предпосылки или сообщи пользователю, что застрял.`);
    if (this.pingPong(session))
      return warn("pingpong", "[guard] Обнаружено чередование двух одинаковых вызовов (A→B→A→B). Остановись и выбери другую стратегию.");
    if (s.errStreak >= o.errorStreak)
      return warn("errs", `[guard] ${s.errStreak} вызовов инструментов подряд завершились ошибкой. Прочитай тексты ошибок, исправь причину; если не получается — объясни пользователю.`);
    if (step >= warnAt)
      return warn("budget", `[guard] Использовано ${step - 1} из ${o.maxSteps} шагов хода. Планируй завершение: приоритет — довести главное до результата.`);
    return { kind: "ok" };
  }
}

/**
 * Подключение к рантайму DSH. Всё в try/catch: если сигнатуры хуков в вашей сборке отличаются,
 * движок не должен падать — защита просто не включится (и это будет видно в логе).
 */
export function installGuard(ctx, opts = {}, deps = {}) {
  const log = (m) => (ctx.logger?.warn ? ctx.logger.warn(m) : console.warn(m));
  try {
    const envSteps = Number.parseInt(process.env.DSH_MAX_STEPS ?? "", 10);
    const envOverrun = Number.parseInt(process.env.DSH_GUARD_OVERRUN ?? "", 10);
    const guard = new TurnGuard({
      ...(Number.isFinite(envSteps) && envSteps > 0 ? { maxSteps: envSteps } : {}),
      ...(Number.isFinite(envOverrun) && envOverrun >= 0 ? { hardOverrun: envOverrun } : {}),
      ...opts
    });
    let llmPromise;
    const getLlm = () => (llmPromise ??= deps.llm ? Promise.resolve(deps.llm) : import("@deepseek-ai/dsh-llm"));

    ctx.on("session/event", (session, event) => {
      try { guard.observe(session, event); } catch (e) { log(`[agent-kit] guard.observe: ${e}`); }
    });

    ctx.on("agent/pre-step", async (payload, next) => {
      const decision = await next();
      try {
        const { agent, turn, step, signal } = payload;
        if (decision.kind === "reject" || signal?.aborted) return decision;
        if (decision.messages.length === 0 && step === 1) return decision; // как в installModelSelection (03)
        const v = guard.verdict(agent.session, turn, step);
        if (v.kind === "stop") {
          log(`[agent-kit] ход остановлен: ${v.reason}`);
          notifyApp("Агент остановлен", v.reason);
          return { kind: "reject", reason: v.reason };
        }
        if (v.kind === "warn") {
          const llm = await getLlm();
          const msg = llm.createUserMessage({
            content: [{ type: "text", text: v.text }],
            source: { kind: "agent-kit-guard", form: "notice", summary: llm.boundContextSummary(v.id) }
          });
          return { ...decision, messages: [...decision.messages, msg] };
        }
      } catch (e) {
        log(`[agent-kit] guard pre-step: ${e && e.message || e}`); // защита не должна ронять ход
      }
      return decision;
    });
    return guard;
  } catch (e) {
    log(`[agent-kit] guard не установлен: ${e && e.message || e}`);
    return undefined;
  }
}

/** Best-effort системное уведомление через локальный сервер приложения (/notify, как в android_notify). */
export async function notifyApp(title, text) {
  try {
    const { request } = await import("node:http");
    const body = JSON.stringify({ title, text });
    await new Promise((resolve) => {
      const req = request({
        host: "127.0.0.1", port: Number(process.env.APP_NOTIFY_PORT) || 3081, path: "/notify", method: "POST",
        timeout: 3000, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
      }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", resolve);
      req.on("timeout", () => { req.destroy(); resolve(); });
      req.end(body);
    });
  } catch { /* уведомление — не критично */ }
}
