/**
 * Компактное представление дерева экрана + детектор изменений.
 * Чистые функции — без I/O, легко тестировать.
 *
 * ДОПУЩЕНИЕ: (x,y) узла — точка нажатия (центр), как сказано в описании android_screen
 * («можно напрямую использовать в android_tap»). Если служба отдаёт левый-верхний угол,
 * поменяйте NODE_XY_IS_CENTER на false.
 */
export const NODE_XY_IS_CENTER = false; // служба отдаёт bounds.left/top (AccessibilityService.java:954-955), значит центр = x+w/2, y+h/2

export const MAX_NODES = 80;
export const MAX_CHARS = 6000;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Оставляет только полезные узлы: с текстом/описанием или интерактивные. Убирает дубли. */
export function compact(rawNodes) {
  const seen = new Set();
  const out = [];
  for (const n of Array.isArray(rawNodes) ? rawNodes : []) {
    const text = typeof n.text === "string" ? n.text.trim() : "";
    const desc = typeof n.desc === "string" ? n.desc.trim() : "";
    const interactive = n.clickable === true || n.input === true || n.scrollable === true || n.checked === true;
    if (!text && !desc && !interactive) continue;
    const x = num(n.x), y = num(n.y), w = num(n.w), h = num(n.h);
    const key = `${text}|${desc}|${x}|${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tapX = NODE_XY_IS_CENTER ? x : x + Math.round(w / 2);
    const tapY = NODE_XY_IS_CENTER ? y : y + Math.round(h / 2);
    out.push({
      text, desc, x: tapX, y: tapY,
      clickable: n.clickable === true, input: n.input === true,
      checked: n.checked === true, scrollable: n.scrollable === true
    });
  }
  return out;
}

export function flags(n) {
  const f = [];
  if (n.clickable) f.push("tap");
  if (n.input) f.push("input");
  if (n.checked) f.push("checked");
  if (n.scrollable) f.push("scroll");
  return f;
}

export function line(n, ref) {
  const label = n.text || n.desc || "(без текста)";
  const short = label.length > 80 ? label.slice(0, 80) + "…" : label;
  const f = flags(n);
  return `[${ref}] ${short} @${n.x},${n.y}${f.length ? " " + f.join("/") : ""}`;
}

/** Ключ узла для сравнения экранов (без координат — анимации не должны считаться изменением). */
const nodeKey = (n) => `${n.text}|${n.desc}|${n.clickable ? 1 : 0}${n.input ? 1 : 0}${n.checked ? 1 : 0}`;

export function fingerprint(pkg, nodes) {
  return pkg + "\n" + nodes.map(nodeKey).join("\n");
}

/** Что появилось/исчезло относительно предыдущего снимка. */
export function diff(prevNodes, nextNodes) {
  const prev = new Map();
  for (const n of prevNodes) prev.set(nodeKey(n), (prev.get(nodeKey(n)) || 0) + 1);
  const next = new Map();
  for (const n of nextNodes) next.set(nodeKey(n), (next.get(nodeKey(n)) || 0) + 1);
  let added = 0, removed = 0;
  for (const [k, c] of next) added += Math.max(0, c - (prev.get(k) || 0));
  for (const [k, c] of prev) removed += Math.max(0, c - (next.get(k) || 0));
  return { added, removed };
}

/** Текст для модели. Ссылки [ref] можно передавать в android_act(ref=…). */
export function render(pkg, nodes, opts = {}) {
  const { maxNodes = MAX_NODES, maxChars = MAX_CHARS } = opts;
  const lines = [`app: ${pkg || "?"}  nodes: ${nodes.length}`];
  let chars = lines[0].length;
  let shown = 0;
  for (let i = 0; i < nodes.length && shown < maxNodes; i++) {
    const l = line(nodes[i], i);
    if (chars + l.length > maxChars) break;
    lines.push(l);
    chars += l.length + 1;
    shown++;
  }
  if (shown < nodes.length) lines.push(`… показано ${shown} из ${nodes.length}; уточните через android_find(query=…) или прокрутите`);
  return lines.join("\n");
}
