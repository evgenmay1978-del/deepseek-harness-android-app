#!/usr/bin/env node
/**
 * gen-tokens.mjs — единый источник токенов в два выхода.
 *   design-system/tokens.json (W3C Design Tokens)
 *     -> out/tokens.css   (веб-UI DSH: переопределение --dsw-alias-* на :root и [data-ds-dark-theme])
 *     -> out/console.json (нативная консоль: theme-pack schema 1, валидируется theme_pack_check.py)
 * Плюс детерминированная проверка WCAG-контраста на парах «текст/фон» для обеих тем.
 * !important не генерируется: сначала проверяем, выигрывает ли stylesheet по порядку (по ТЗ).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const T = JSON.parse(readFileSync(join(HERE, "tokens.json"), "utf8"));
const v = (t) => t.$value;

// наш токен -> имена --dsw-alias-* в веб-UI
const WEB_MAP = {
  bg:     ["bg-base", "bg-mask-1", "menu-group-header-fill"],
  card:   ["bg-layer-1", "bg-layer-2", "bg-layer-3", "bg-layer-4", "toast-bg", "tooltip-bg", "tooltip-key-bg", "markdown-code-block", "markdown-code-block-banner"],
  text:   ["label-primary"],
  sub:    ["label-secondary", "label-tertiary", "label-caption", "label-dimmed", "scrollbar-bg-l2"],
  line:   ["border-l1", "border-l2", "border-l3", "border-l4", "border-l2-darkmode-thin"],
  accent: ["brand-primary", "button-primary-fill", "link", "state-business-primary"],
  green:  ["state-success-primary", "state-success-tertiary", "code-diff-added"],
  red:    ["label-error", "state-error-primary", "code-diff-deleted", "interactive-bg-hover-danger"]
};

const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
function shade(hex, amt) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const f = (c) => clamp(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  const p = (c) => c.toString(16).padStart(2, "0");
  return "#" + p(f(r)) + p(f(g)) + p(f(b));
}

// --- WCAG 2.x ---
const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
function lum(hex) {
  const h = hex.replace("#", "");
  return 0.2126 * srgb(parseInt(h.slice(0, 2), 16)) + 0.7152 * srgb(parseInt(h.slice(2, 4), 16)) + 0.0722 * srgb(parseInt(h.slice(4, 6), 16));
}
const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
// пары «передний/задний»; крупный текст и элементы интерфейса — порог 3:1
const PAIRS = [
  ["text", "bg", 4.5], ["text", "card", 4.5],
  ["sub", "bg", 4.5], ["sub", "card", 4.5],
  ["accent", "bg", 3.0], ["accent", "card", 3.0],
  ["green", "bg", 3.0], ["green", "card", 3.0],
  ["red", "bg", 3.0], ["red", "card", 3.0]
];

// --- CSS ---
const blocks = [];
for (const scheme of ["light", "dark"]) {
  const c = T.color[scheme];
  const sel = scheme === "dark" ? "[data-ds-dark-theme]" : ":root";
  const decls = [];
  for (const [key, names] of Object.entries(WEB_MAP)) {
    const color = v(c[key]);
    for (const n of names) decls.push("  --dsw-alias-" + n + ": " + color + ";");
    if (key === "accent") {
      decls.push("  --dsw-alias-brand-primary-hover: " + shade(color, 0.14) + ";");
      decls.push("  --dsw-alias-brand-primary-active: " + shade(color, -0.14) + ";");
      decls.push("  --dsw-alias-brand-primary-new-colorprimary-new-color: " + color + ";");
      decls.push("  --dsw-alias-button-primary-hover: " + shade(color, 0.14) + ";");
    }
  }
  blocks.push(sel + " {\n" + decls.join("\n") + "\n}");
}
const css = "/* Сгенерировано gen-tokens.mjs из tokens.json — НЕ править руками. */\n" + blocks.join("\n\n") + "\n";

// --- console.json (schema 1) ---
const col = (s) => s;
const per = {};
for (const scheme of ["light", "dark"]) {
  const c = T.color[scheme];
  per[scheme] = { bg: v(c.bg), card: v(c.card), text: v(c.text), sub: v(c.sub), line: v(c.line) };
}
const consoleJson = {
  schema: T.meta.consoleSchema,
  name: T.meta.name,
  author: "design-system (gen-tokens.mjs)",
  app: T.meta.consoleApp,
  appearance: {
    dark: "follow",
    perScheme: per,
    colors: {
      accent: v(T.color.dark.accent),
      green: v(T.color.dark.green),
      red: v(T.color.dark.red),
      track: v(T.color.dark.track),
      statusBar: "auto"
    },
    fontScale: v(T.font?.scale ?? { $value: 1 }),
    radius: v(T.radius.md)
  }
};

// --- проверки ---
let failed = 0;
const report = [];
for (const scheme of ["light", "dark"]) {
  const c = T.color[scheme];
  for (const [fg, bg, min] of PAIRS) {
    const r = contrast(v(c[fg]), v(c[bg]));
    const ok = r >= min;
    if (!ok) failed++;
    report.push((ok ? "ok  " : "FAIL") + " " + scheme + " " + fg + "/" + bg + " = " + r.toFixed(2) + " (min " + min + ")");
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "tokens.css"), css, "utf8");
writeFileSync(join(OUT, "console.json"), JSON.stringify(consoleJson, null, 2) + "\n", "utf8");
console.log(report.join("\n"));
console.log("WCAG: " + (failed ? "FAIL (" + failed + ")" : "ok, все пары прошли"));
console.log("outputs: out/tokens.css, out/console.json");
process.exit(failed ? 1 : 0);
