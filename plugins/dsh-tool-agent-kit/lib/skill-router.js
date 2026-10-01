/**
 * skill-router — напоминает агенту, какой скилл загрузить, прямо в начале хода.
 *
 * Зачем: скиллы, которые «просто лежат», не используются. AGENTS §8 описывает соответствие
 * «ситуация → скиллы», но модель может его не применить. Здесь то же соответствие, но машиной:
 * на первом шаге хода смотрим входящее сообщение, и если оно похоже на известную ситуацию,
 * добавляем в контекст одну короткую строку: какие скиллы загрузить (инструментом skill).
 *
 * Работает для ЛЮБОГО агента, включая субагентов: хук agent/pre-step общий, сессия своя —
 * поэтому и субагент получает напоминание в своей сессии.
 *
 * Правила не дублируются в голове модели: они здесь и совпадают с таблицей AGENTS §8.
 * Напоминание даётся один раз на сессию для каждого правила и только если нужные скиллы ещё
 * не загружались в этой сессии (факт загрузки видим по session/event → tool/call с именем skill).
 * Выключатель: DSH_SKILL_ROUTER=off.
 */
import { makeLlmGetter, noticeMessage } from "./llm.js";

export const RULES = [
  { id: "debug", why: "похоже на разбор поломки", skills: ["diagnosing-bugs", "superpower-systematic-debugging"],
    re: /(баг|не работает|не пашет|ошибк|падает|сломал|тормоз|зависа|отвал|debug|bug|fails?|failure|error|broken|crash|stack ?trace)/i },
  { id: "code", why: "правка или новый код", skills: ["karpathy-guidelines", "ponytail"],
    re: /(исправ|правк|перепиш|реализ|добавь|напиши|сделай|отрефактор|вынеси|почини|implement|refactor|rewrite|fix|write|patch|code)/i },
  { id: "tests", why: "тесты", skills: ["tdd"], re: /(тест|tdd|покрыти|unit|integration test|spec)/i },
  { id: "plan", why: "план или идея до реализации", skills: ["superpower-brainstorming"],
    re: /(план|иде(я|ю)|предложи|вариант|архитектур|спроектир|brainstorm|design|plan|approach)/i },
  { id: "finish", why: "перед словом «готово»", skills: ["superpower-verification-before-completion"],
    re: /(готово|закончил|заверш|проверь|проверить|убедись|докажи|verify|done|finished|confirm)/i },
  { id: "screen", why: "работа с экраном телефона", skills: ["vscreen-ui"],
    re: /(экран|скрин|нажми|тапни|интерфейс|кнопк|дисплей|screen|tap|ui\b)/i },
  { id: "vpn", why: "серверы и VPN-контур", skills: ["maestro-vpn-ops", "shell-safety"],
    re: /(\bS[1-4]\b|сервер|nginx|панел|подписк|rqlite|sing-box|xray|vpn|cdn|роутер)/i },
  { id: "shell", why: "команды в shell", skills: ["shell-safety"],
    re: /(bash|shell|команд|ssh|скрипт|терминал|command)/i },
  { id: "release", why: "релиз или выкатка", skills: ["ota-verify"], re: /(релиз|ota|выкат|деплой|release|deploy|publish)/i },
  { id: "secrets", why: "ключи и секреты", skills: ["security-review"],
    re: /(ключ|пароль|токен|секрет|api[- ]?key|password|token|secret|credential)/i },
  { id: "research", why: "исследование по источникам", skills: ["research"],
    re: /(исследуй|найди в интернете|первоисточник|документац|статья|research|look up|docs?)/i },
  { id: "agent-docs", why: "правка инструкций или скиллов", skills: ["writing-for-agents"],
    re: /(agents\.md|claude\.md|скилл|skill|инструкц|промпт|prompt)/i },
  { id: "tv", why: "ТВ-экран", skills: ["tv-sim"], re: /(\bтв\b|телевизор|tv\b)/i },
  { id: "third-party", why: "чужой код или плагин", skills: ["skill-security-guard"],
    re: /(плагин|чуж(ой|ая)|zip|архив|пакет|dependencies|npm install)/i }
];

const textOf = (m) => {
  if (!m) return "";
  if (typeof m === "string") return m;
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && b.type === "text" ? b.text : "")).join(" ");
  return "";
};
// Совпадение внутри отрицания не считается: «не про CDN» не должно звать maestro-vpn-ops (живой ложный случай 30.09.2026).
const NEG_BEFORE = /(?:^|[^а-яёa-z])(?:не|нет|без|not|no|don't|dont|never)\s+[^.!?;\n]{0,24}$/i;
export function countHits(re, text) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let n = 0, m;
  while ((m = g.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 28), m.index);
    if (!NEG_BEFORE.test(before)) n++;
    if (g.lastIndex === m.index) g.lastIndex++;
  }
  return n;
}

const argsName = (v) => {
  try { const o = typeof v === "string" ? JSON.parse(v) : v; return String(o?.name ?? o?.skill ?? ""); } catch { return ""; }
};

export function installSkillRouter(ctx, opts = {}, deps = {}) {
  if (process.env.DSH_SKILL_ROUTER === "off") return undefined;
  const log = deps.log || ((m) => (ctx.logger?.warn ? ctx.logger.warn(m) : console.warn(m)));
  const getLlm = makeLlmGetter(ctx, deps);
  const rules = opts.rules || RULES;
  const maxSkills = opts.maxSkills ?? 3;
  const reminded = new WeakMap(); // session -> Set(ruleId)
  const loaded = new WeakMap();   // session -> Set(skillName)
  let llmWarned = false;

  ctx.on("session/event", (session, event) => {
    try {
      if (!session || typeof session !== "object" || !event) return;
      if (event.type !== "tool/call") return;
      const name = String(event.data?.name ?? "");
      if (name !== "skill") return;
      const skill = argsName(event.data?.arguments);
      if (!skill) return;
      let set = loaded.get(session);
      if (!set) { set = new Set(); loaded.set(session, set); }
      set.add(skill);
    } catch { /* наблюдение не должно мешать */ }
  });

  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    try {
      const { agent, step, signal } = payload;
      if (decision.kind === "reject" || signal?.aborted) return decision;
      if (step !== 1) return decision;
      const incoming = (decision.messages || []).map(textOf).join("\n").trim();
      if (incoming.length < 12) return decision; // «ок», «да», «запускай» — ситуации не опознать
      if (!incoming) return decision;
      const session = agent.session;
      const already = loaded.get(session) || new Set();
      const done = reminded.get(session) || new Set();
      const hit = rules.find((r) => countHits(r.re, incoming) > 0 && !done.has(r.id) && r.skills.some((s) => !already.has(s)));
      if (!hit) return decision;
      const need = hit.skills.filter((s) => !already.has(s)).slice(0, maxSkills);
      if (!need.length) return decision;
      const llm = await getLlm();
      if (!llm) { if (!llmWarned) { llmWarned = true; log("[agent-kit] skill-router: dsh-llm недоступен, напоминания о скиллах не показываются"); } return decision; }
      done.add(hit.id); reminded.set(session, done);
      const text = "[skills] " + hit.why + ". Загрузи перед работой: " + need.map((s) => "«" + s + "»").join(", ") +
        " (инструмент skill). Соответствие «ситуация → скиллы» — AGENTS §8.";
      return { ...decision, messages: [...(decision.messages || []), noticeMessage(llm, "agent-kit-skills", text, "skills-" + hit.id)] };
    } catch (e) {
      log("[agent-kit] skill-router: " + ((e && e.message) || e)); // напоминание не должно ронять ход
    }
    return decision;
  });
  return { rules, reminded, loaded };
}
