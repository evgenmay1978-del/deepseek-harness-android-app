/**
 * Общий резолвер dsh-llm (createUserMessage / boundContextSummary) для guard и памяти.
 * Из профильного бандла import "@deepseek-ai/dsh-llm" РЕЗОЛВИТСЯ (проверено 30.09.2026 на устройстве),
 * но цепочка deps → import → ctx.get("llm") оставлена как страховка на случай смены раскладки ядра.
 * (взято из dsh-tool-agent-kit v0.3)
 */
const usable = (m) => m && typeof m.createUserMessage === "function" && typeof m.boundContextSummary === "function";

export function makeLlmGetter(ctx, deps = {}) {
  let promise;
  return () => (promise ??= (async () => {
    if (usable(deps.llm)) return deps.llm;
    try { const m = await import("@deepseek-ai/dsh-llm"); if (usable(m)) return m; } catch { /* пробуем дальше */ }
    try { const svc = ctx.get?.("llm"); if (usable(svc)) return svc; } catch { /* пробуем дальше */ }
    return undefined;
  })());
}

/** Уведомление-«заметка» в контекст агента (как modelSwitchNotice в ядре). */
export function noticeMessage(llm, kind, text, summaryKey) {
  return llm.createUserMessage({
    content: [{ type: "text", text }],
    source: { kind, form: "notice", summary: llm.boundContextSummary(summaryKey) }
  });
}
