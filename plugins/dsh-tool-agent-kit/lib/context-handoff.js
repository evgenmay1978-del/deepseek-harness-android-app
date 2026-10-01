/**
 * context-handoff — скользящая сводка и перенос состояния между сессиями (шаг 5 плана).
 *
 * Принцип: в контексте живёт «хвост» последних ходов дословно, а старая часть сворачивается в СТРУКТУРНУЮ
 * сводку (решения, факты, ошибки, следующий шаг) — не в пересказ «вообще». Состояние переносится через
 * handoff.json: новая сессия читает его и продолжает работу без потери договорённостей.
 */
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { trimResult } from "./blob-store.js";

// ВНИМАНИЕ: \b в JS не работает для кириллицы (он определён через ASCII-\w), поэтому границы слова не используем.
const DECISION = /^(решили|решение|договорились|выбрали|принято|сделано|готово)\s*[:—-]/i;
const FACT = /^(факт|проверено|замер|данные|оказалось)\s*[:—-]/i;
const ERROR = /^(ошибка|сбой|не работает|проблема|баг)\s*[:—-]/i;
const OPEN = /^(осталось|надо|следующий шаг|план|todo|дальше)\s*[:—-]/i;

/** Структурная выжимка из записей: решения, факты, ошибки, открытые вопросы. */
export function digest(texts) {
  const out = { decisions: [], facts: [], errors: [], open: [] };
  for (const raw of texts || []) {
    for (const line of String(raw || "").split(/\r?\n/)) {
      const s = line.replace(/^[-*•\d.\s]+/, "").trim();
      if (!s) continue;
      if (DECISION.test(s)) out.decisions.push(s);
      else if (FACT.test(s)) out.facts.push(s);
      else if (ERROR.test(s)) out.errors.push(s);
      else if (OPEN.test(s)) out.open.push(s);
    }
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].slice(0, 12);
  return out;
}

/** Скользящее окно: хвост дословно, голова — сводкой. */
export function slide(turns, { keepTail = 6, maxChars = 6000, store = null } = {}) {
  const all = (turns || []).map((t) => String(t?.text ?? t ?? ""));
  if (all.length <= keepTail) {
    const joined = all.join("\n\n");
    return { head: [], tail: all, summary: "", text: joined.slice(0, maxChars), collapsed: 0 };
  }
  const head = all.slice(0, all.length - keepTail);
  const tail = all.slice(all.length - keepTail);
  const d = digest(head);
  const summary = [
    d.decisions.length ? "Решения: " + d.decisions.join("; ") : "",
    d.facts.length ? "Факты: " + d.facts.join("; ") : "",
    d.errors.length ? "Ошибки: " + d.errors.join("; ") : "",
    d.open.length ? "Открыто: " + d.open.join("; ") : "",
  ].filter(Boolean).join("\n");
  const text = trimResult("[сводка предыдущих " + head.length + " ходов]\n" + summary + "\n\n" + tail.join("\n\n"), { max: maxChars, store }).text;
  return { head, tail, summary, text, collapsed: head.length };
}

export const handoffFile = (dir) => join(dir, "handoff.json");

export function writeHandoff(dir, state) {
  try { mkdirSync(dir, { recursive: true }); } catch { /* уже есть */ }
  const payload = { version: 1, at: new Date().toISOString(), ...state };
  writeFileSync(handoffFile(dir), JSON.stringify(payload, null, 1), "utf8");
  return payload;
}

export function readHandoff(dir) {
  try { return JSON.parse(readFileSync(handoffFile(dir), "utf8")); } catch { return null; }
}

/** Короткая вводная для новой сессии: что уже сделано, что открыто, где искать. */
export function handoffPreamble(state) {
  if (!state) return "";
  const lines = [];
  if (state.task) lines.push("Задача: " + state.task);
  if (state.done?.length) lines.push("Сделано: " + state.done.slice(0, 6).join("; "));
  if (state.open?.length) lines.push("Открыто: " + state.open.slice(0, 6).join("; "));
  if (state.keys?.length) lines.push("Факты памяти: " + state.keys.slice(0, 8).join(", "));
  if (state.next) lines.push("Следующий шаг: " + state.next);
  return lines.join("\n");
}
