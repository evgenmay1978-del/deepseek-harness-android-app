#!/usr/bin/env node
// ci/install-agent-kit.mjs — вкладывает наш плагин dsh-tool-agent-kit в payload сборки.
//
// Зачем: плагин живёт в payload (profiles/*/node_modules) и подхватывается движком при старте.
// Без этого шага APK собирается без наших инструментов — то есть без памяти, скиллов и диспетчера.
// Скрипт идемпотентен: повторная сборка не дублирует записи и не портит уже установленное.
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [devhome, repoRoot] = process.argv.slice(2);
if (!devhome || !repoRoot) { console.error("использование: node ci/install-agent-kit.mjs <devhome> <repoRoot>"); process.exit(2); }

const src = join(repoRoot, "plugins", "dsh-tool-agent-kit");
if (!existsSync(src)) { console.error("нет исходников плагина: " + src); process.exit(1); }

const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
const pkgName = pkg.name;
if (!pkgName) { console.error("в package.json плагина нет name"); process.exit(1); }

// Ищем все профили в распакованном payload, не полагаясь на конкретный путь: он может меняться.
const profiles = [];
(function walk(dir, depth) {
  if (depth > 6) return;
  let items = [];
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (!it.isDirectory()) continue;
    const p = join(dir, it.name);
    if (it.name === "node_modules" && existsSync(join(dir, "package.json"))) { profiles.push(dir); continue; }
    walk(p, depth + 1);
  }
})(join(devhome, ".dsh"), 0);
if (!profiles.length) { console.error("в payload не найдено ни одного профиля (profiles/*/node_modules)"); process.exit(1); }

// Кладём только то, что нужно движку: код, манифест и патч профиля. Тесты и CI-скрипты — не грузим.
const FILES = ["index.js", "package.json", "cordis.patch.yml", "dsh.bundle.patch", "README.md"];
let installed = 0, registered = 0;
for (const profile of profiles) {
  const dst = join(profile, "node_modules", pkgName);
  mkdirSync(dst, { recursive: true });
  for (const f of FILES) if (existsSync(join(src, f))) cpSync(join(src, f), join(dst, f));
  cpSync(join(src, "lib"), join(dst, "lib"), { recursive: true });
  installed++;

  // Регистрация как бандла профиля: без записи в dsh.profile.bundles движок плагин не поднимет.
  const pf = join(profile, "package.json");
  const manifest = JSON.parse(readFileSync(pf, "utf8"));
  manifest.dsh = manifest.dsh || {};
  const bundles = Array.isArray(manifest.dsh.profile?.bundles) ? manifest.dsh.profile.bundles
    : Array.isArray(manifest.dsh.bundles) ? manifest.dsh.bundles : null;
  if (bundles) {
    if (!bundles.includes(pkgName)) { bundles.push(pkgName); registered++; }
  } else {
    manifest.dsh.bundles = [...(manifest.dsh.bundles || []), pkgName];
    registered++;
  }
  writeFileSync(pf, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log("  профиль " + profile.replace(devhome + "/", "") + ": установлен " + pkgName);
}
console.log("плагин " + pkgName + " вложен в профилей: " + installed + " | новых регистраций: " + registered);
