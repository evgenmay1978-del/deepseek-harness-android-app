#!/usr/bin/env node
/**
 * load-index.mjs — сквозной загрузчик РЕАЛЬНОГО index.js в vm с заглушками ядра.
 * ЗАЧЕМ: 04.10.2026 123 теста были зелёными, пока apply() не мог собрать строку
 * self-check (замыкание на block-scoped store → ReferenceError). Тесты проверяли детали,
 * а не сборку плагина. Здесь собирается и запускается ровно то, что грузит движок.
 *
 * Запуск: node --experimental-vm-modules tests/support/load-index.mjs
 * Успех: exit 0 и строка "E2E_LINE ..." со всеми секциями.
 */
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detectFilesDir } from "../../lib/paths.js";

// Флаг обязателен: без него vm.SourceTextModule===undefined и загрузчик молча «не запустится».
if (typeof vm.SourceTextModule !== "function") {
  console.error("load-index: нужен флаг --experimental-vm-modules (vm.SourceTextModule отсутствует)");
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..", "..");
const REAL_FILES = detectFilesDir(); // ДО подмены DSH_FILES_DIR — иначе потеряем путь к ядру
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "idx-e2e-"));

process.env.DSH_FILES_DIR = TMP;
process.env.DSH_GUARD = "off";
process.env.DSH_SCHEDULE = "off";
process.env.DSH_VSCREEN_TOOLS = "off";
process.env.DSH_SELFCHECK_DELAY_MS = "50";

// Контракт с ядром: заглушка dsh-tools должна покрывать то, что плагин реально импортирует.
// Если апстрим переименует defineTool, заглушка молча «разойдётся» с ядром — здесь это падение.
const REQUIRED_DSH_TOOLS = ["defineTool"];
let kernelLine = "KERNEL none";
try {
  const dshRoot = path.join(REAL_FILES, "payload/dshroot/lib/node_modules/@deepseek-ai/dsh");
  const dshTools = path.join(dshRoot, "node_modules/@deepseek-ai/dsh-tools/lib/index.js");
  if (fs.existsSync(dshTools)) {
    const ver = JSON.parse(fs.readFileSync(path.join(dshRoot, "package.json"), "utf8")).version;
    const mod = await import(pathToFileURL(dshTools).href);
    const missing = REQUIRED_DSH_TOOLS.filter((n) => !(n in mod));
    if (missing.length) { console.error("КОНТРАКТ С ЯДРОМ: dsh-tools не экспортирует " + missing.join(", ")); process.exit(3); }
    kernelLine = "KERNEL " + ver + " dsh-tools:" + Object.keys(mod).length + " defineTool:ok";
  }
} catch (e) {
  console.error("КОНТРАКТ С ЯДРОМ: не удалось проверить (" + ((e && e.message) || e) + ")");
  process.exit(3);
}
console.log(kernelLine);

// Журнал с записью: строка должна показать ветку инъекции, а не «инъекций не было».
fs.mkdirSync(path.join(TMP, "agent-memory"), { recursive: true });
fs.writeFileSync(path.join(TMP, "agent-memory", "injection-log.json"), JSON.stringify([
  { v: 1, at: "2026-10-04T18:23:15.725Z", turn: 34, step: 1, branch: "standard", via: "fallback", qlen: 12, keys: ["m1:1"], size: 975, cap: 1800 }
]));

const logged = [];
const context = vm.createContext({ console, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, URL, TextEncoder, TextDecoder, structuredClone });
const cache = new Map();
function synth(ns, id) { const names = Object.keys(ns); return new vm.SyntheticModule(names, function () { for (const n of names) this.setExport(n, ns[n]); }, { context, identifier: id }); }
async function link(specifier, referencing) {
  if (specifier.startsWith("node:")) return synth(await import(specifier), "b:" + specifier);
  if (specifier === "@deepseek-ai/dsh-tools") return synth({ defineTool: (x) => x, registerTool: (x) => x }, "stub-tools");
  if (specifier === "@deepseek-ai/cordis") return synth({ Context: class {} }, "stub-cordis");
  if (specifier === "./lib/app.js") return new vm.SourceTextModule('export function assembleSafely(){return {ok:true, app:{checks:["stub"],validation:[],protectedPaths:[],origin_protection:"stub"}};} export function defaultStatusPath(){return "/tmp/x.json";}', { context, identifier: "stub-app" });
  if (specifier === "./lib/a11y-boot.js") return new vm.SourceTextModule('export async function ensureAccessibility(){ return { ok: true, skipped: "e2e" }; }', { context, identifier: "stub-a11y-boot" });
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const p = path.resolve(path.dirname(referencing.identifier), specifier);
    if (cache.has(p)) return cache.get(p);
    const m = new vm.SourceTextModule(fs.readFileSync(p, "utf8"), { context, identifier: p });
    cache.set(p, m);
    return m;
  }
  throw new Error("unexpected specifier " + specifier);
}

const mainPath = path.join(PLUGIN, "index.js");
const main = new vm.SourceTextModule(fs.readFileSync(mainPath, "utf8"), { context, identifier: mainPath });
cache.set(mainPath, main);
await main.link(link);
await main.evaluate();

const registered = [];
const ctx = { tools: { register: (t) => registered.push(t && t.name || "?"), get: () => true }, logger: { warn: (m) => logged.push(String(m)) }, on: () => {}, remote: {} };
main.namespace.apply(ctx);

async function waitFor(pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = pred(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } return null; }
const line = await waitFor(() => logged.find((l) => l.includes("самопроверка")), 5000);
fs.rmSync(TMP, { recursive: true, force: true });

if (!line) { console.error("НЕТ строки самопроверки. Зарегистрированы: " + registered.join(",")); process.exit(1); }
for (const need of ["инструменты", "скиллов на диске", "память", "последняя инъекция ДО СТАРТА", "via fallback"]) {
  if (!line.includes(need)) { console.error("В строке нет «" + need + "»: " + line); process.exit(1); }
}
console.log("E2E_LINE " + line);
