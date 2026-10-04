/**
 * memory-index — производный индекс памяти поверх markdown-файлов.
 *
 * Принцип (по разбору): markdown в git остаётся ЕДИНСТВЕННЫМ источником правды, индекс — кэш поиска,
 * который в любой момент пересобирается из файлов. Взято из ответа Claude: frontmatter с id/key/supersedes,
 * поиск через SQLite FTS5 (встроен в Node 26 — новых зависимостей нет).
 *
 * Frontmatter записи:
 *   ---
 *   id: m_01h...                # стабильный идентификатор
 *   key: proj.maestro.build_cmd # ключ факта (для дедупликации)
 *   supersedes: [m_old1]        # какие записи эта заменяет
 *   tags: [build, maestro]
 *   updated: 2026-10-01
 *   ---
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Все .md в каталоге и подкаталогах, кроме скрытых (архив памяти раньше не попадал в индекс). */
export function walkMd(dir, out = [], root = dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out, root);
    else if (e.name.endsWith(".md")) out.push(p.slice(root.length + 1));
  }
  return out;
}

export function parseNote(text) {
  const raw = String(text ?? "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const meta = {};
  let body = raw;
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
      if (k) meta[k] = v;
    }
  }
  return { meta, body: body.trim() };
}

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

export function openIndex(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(id UNINDEXED, key UNINDEXED, supersedes UNINDEXED, tags UNINDEXED, updated UNINDEXED, origin UNINDEXED, body)");
  return db;
}

/**
 * Пересборка индекса из НЕСКОЛЬКИХ каталогов ОДНИМ проходом.
 * Критично: нельзя чистить таблицу на каждый каталог — пустой (но существующий) каталог стирал бы
 * уже собранный индекс предыдущего. Сначала собираем все файлы, потом один раз чистим и пишем.
 */
/** Каноническая форма записи для подписи: id, key, origin, supersedes, sha256(тело). */
export function canonicalRecord({ id, key, origin, supersedes, body }) {
  const bodyHash = createHash("sha256").update(String(body ?? "")).digest("hex");
  return [String(id ?? ""), String(key ?? ""), String(origin ?? ""), asArray(supersedes).join(","), bodyHash].join("\n");
}

/** Происхождение: human только при ДВУХ условиях — файл в humanDirs И валидная подпись.
 *  Верификатор по умолчанию запрещающий (fail-closed): нет канала подписи — запись агентская. */
export function classifyOrigin({ dir, humanDirs = [], record, signature, verify }) {
  if (!humanDirs.includes(dir)) return "agent";
  if (typeof verify !== "function") return "agent";
  try { return verify(canonicalRecord(record), signature) === true ? "human" : "agent"; }
  catch { return "agent"; }
}

let building = false;   // single-flight: ночная консолидация и старт движка не должны пересекаться

export function rebuildAll(db, dirs, deps = {}, { allowEmpty = false, minRatio = 0.5, log = () => {}, humanDirs = [] } = {}) {
  if (building) { log("сборка уже идёт — пропускаем повторный запуск"); return { inserted: 0, built: 0, previous: 0, swapped: false, reason: "busy" }; }
  building = true;
  try { return buildOnce(db, dirs, deps, { allowEmpty, minRatio, log, humanDirs }); }
  finally { building = false; }
}

function buildOnce(db, dirs, deps, { allowEmpty, minRatio, log, humanDirs = [] }) {
  const verify = deps.verifySignature;   // нет верификатора — всё агентское (fail-closed)
  const list = deps.list || walkMd;
  const read = deps.read || ((p) => readFileSync(p, "utf8"));
  const items = [];
  for (const d of dirs || []) {
    let files = [];
    try { files = list(d); } catch (e) {
      const code = (e && e.code) || "";
      if (code && code !== "ENOENT") {   // нет доступа/ошибка ввода-вывода — это не «пустой каталог»: прерываем всю сборку
        log("СБОРКА ПРЕРВАНА: каталог " + d + " недоступен (" + code + ") — индекс не тронут");
        return { inserted: 0, built: 0, previous: Number(db.prepare("SELECT count(*) AS c FROM notes").get().c) || 0, swapped: false, reason: "io_error" };
      }
      log("каталог отсутствует: " + d);
      continue;
    }
    if (!files.length) log("каталог без заметок: " + d);
    for (const f of files) items.push([d, f]);
  }
  const found = items.length;
  // Предпроход: кто есть кто по id и key. Нужен, чтобы агентская запись не могла скрыть человеческий факт
  // ни через supersedes, ни через одинаковый key — независимо от порядка файлов.
  const originsById = new Map();
  const keyOwners = new Map();
  for (const [d, f] of items) {
    try {
      const { meta } = parseNote(read(join(d, f)));
      const id = String(meta.id || f.replace(/\.md$/, ""));
      const rec = { id, key: String(meta.key || ""), origin: "human", supersedes: meta.supersedes, body: parseNote(read(join(d, f))).body };
      const org = classifyOrigin({ dir: d, humanDirs, record: rec, signature: meta.signature, verify });
      originsById.set(id, org);
      const key = String(meta.key || "");
      if (key) { const arr = keyOwners.get(key) || []; arr.push({ id, origin: org }); keyOwners.set(key, arr); }
    } catch { /* файл посчитаем ниже */ }
  }
  const MIN_PARSED_RATIO = 0.5;   // разобрано меньше половины — это смена формата или повреждение, индекс не подменяем
  const previous = Number(db.prepare("SELECT count(*) AS c FROM notes").get().c) || 0;

  // 1) Собираем НОВЫЕ данные в отдельную таблицу. Рабочую не трогаем вообще.
  db.exec("DROP TABLE IF EXISTS notes_new");   // остатки от убитого процесса не должны мешать
  db.exec("CREATE VIRTUAL TABLE notes_new USING fts5(id UNINDEXED, key UNINDEXED, supersedes UNINDEXED, tags UNINDEXED, updated UNINDEXED, origin UNINDEXED, body)");
  db.exec("DELETE FROM notes_new");
  const ins = db.prepare("INSERT INTO notes_new (id, key, supersedes, tags, updated, origin, body) VALUES (?,?,?,?,?,?,?)");
  let inserted = 0, failed = 0, duplicates = 0;
  const conflicts = [];
  const seenPairs = new Set();
  const recordConflict = (id, loser, winner, kind) => {
    const h = id + "|" + loser + "|" + winner + "|" + kind;
    if (seenPairs.has(h)) return;   // не шумим: пишем событие при изменении состояния, а не каждую сборку
    seenPairs.add(h);
    conflicts.push({ id, loser, winner, kind });
    log("АУДИТ: конфликт памяти " + kind + " id=" + id + " проиграл=" + loser + " победил=" + winner);
  };

  const seen = new Map();   // id → {origin, file}: нужен для приоритета human > agent
  for (const [d, f] of items) {
    try {
      const { meta, body } = parseNote(read(join(d, f)));
      const id = String(meta.id || f.replace(/\.md$/, ""));
      const rec = { id, key: String(meta.key || ""), origin: "human", supersedes: meta.supersedes, body };
      const origin = classifyOrigin({ dir: d, humanDirs, record: rec, signature: meta.signature, verify });   // каталог + валидная подпись
      const rawSup = asArray(meta.supersedes);
      const blocked = origin === "agent" ? rawSup.filter((x) => originsById.get(String(x)) === "human") : [];
      const allowedSup = rawSup.filter((x) => !blocked.includes(x));
      if (blocked.length) recordConflict(id, String(blocked.join(",")), "human", "agent_supersedes_human_blocked");
      const ownKey = String(meta.key || "");
      if (origin === "agent" && ownKey) {
        const humans = (keyOwners.get(ownKey) || []).filter((o) => o.origin === "human" && o.id !== id);
        if (humans.length) recordConflict(id, id, humans.map((o) => o.id).join(","), "agent_key_collision");
      }
      const writeRow = () => ins.run(id, String(meta.key || ""),
        allowedSup.join(" "), asArray(meta.tags).join(" "), String(meta.updated || ""), origin, body);
      if (seen.has(id)) {
        duplicates++;
        const prev = seen.get(id);
        // Приоритет: human > agent. Порядок каталогов — только tie-break (равные origin).
        if (prev.origin !== "human" && origin === "human") {
          db.prepare("DELETE FROM notes_new WHERE id = ?").run(id);   // агентскую версию убираем, человеческую ставим
          writeRow();
          seen.set(id, { origin, file: f });
          recordConflict(id, prev.file, f, "human_over_agent");
        } else if (prev.origin === "human" && origin !== "human") {
          recordConflict(id, f, prev.file, "agent_blocked");
        } else {
          log("дубль id пропущен: " + id + " — равный приоритет (" + prev.origin + "), побеждает первый по порядку каталогов: " + prev.file);
        }
        continue;
      }
      writeRow();
      seen.set(id, { origin, file: f });
      inserted++;
    } catch (e) { failed++; log("файл пропущен: " + f + " (" + ((e && e.message) || e) + ")"); }
  }

  // 2) Инвариант: сколько вставили — столько и лежит. Расхождение = громкая ошибка, подмены не будет.
  const built = Number(db.prepare("SELECT count(*) AS c FROM notes_new").get().c) || 0;
  const parsed = inserted + duplicates;
  const ratioApplies = found >= 4;   // на 2-3 файлах доля недостоверна: один сбойный уже «ниже порога»
  const tooManyErrors = failed > 2;  // абсолютный лимит ошибок разбора
  if (tooManyErrors || (ratioApplies && parsed < found * MIN_PARSED_RATIO)) {
    log("СБОРКА ПРЕРВАНА: разобрано " + parsed + " из " + found + ", ошибок " + failed + " (порог/лимит) — индекс не тронут");
    try { db.exec("DROP TABLE IF EXISTS notes_new"); } catch { /* уже нет */ }
    return { inserted, built, previous, swapped: false, reason: "parse_ratio", found, parsed };
  }
  if (built !== inserted || found !== inserted + failed + duplicates) {
    log("ИНВАРИАНТ НАРУШЕН: найдено " + found + ", вставлено " + inserted + ", ошибок " + failed + ", дублей " + duplicates + ", в таблице " + built + " — подмена отменена");
    try { db.exec("DELETE FROM notes_new"); } catch { /* уже пусто */ }
    return { inserted, built, previous, swapped: false, reason: "invariant", conflicts };
  }

  // 3) Защита от обвала: пустая или резко усохшая сборка не заменяет рабочую без явного разрешения.
  if (previous > 0 && !allowEmpty && (inserted === 0 || inserted < previous * minRatio)) {
    log("сборка подозрительно мала: было " + previous + ", стало " + inserted + " — подмена отменена");
    try { db.exec("DELETE FROM notes_new"); } catch { /* уже пусто */ }
    return { inserted, built, previous, swapped: false, reason: "shrink" };
  }

  // 4) Подмена в одной транзакции: либо новый индекс целиком, либо старый.
  db.exec("BEGIN");
  try {
    db.exec("DROP TABLE notes");
    db.exec("ALTER TABLE notes_new RENAME TO notes");
    db.exec("COMMIT");
    return { inserted, built, previous, swapped: true, failed, duplicates, conflicts };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* откат уже сделан */ }
    log("подмена не удалась: " + ((e && e.message) || e));
    return { inserted, built, previous, swapped: false, reason: "swap_failed" };
  }
}

/** Пересборка индекса из каталога markdown-файлов. Возвращает число записей. */
export function rebuild(db, dir, deps = {}) {
  const list = deps.list || walkMd;
  const read = deps.read || ((p) => readFileSync(p, "utf8"));
  // ВАЖНО: сначала получаем список файлов и только потом чистим таблицу.
  // Иначе отсутствующий каталог (readdirSync бросает) стирал бы уже собранный индекс из предыдущего каталога.
  const files = list(dir);
  db.exec("DELETE FROM notes");
  const ins = db.prepare("INSERT INTO notes (id, key, supersedes, tags, updated, origin, body) VALUES (?,?,?,?,?,?,?)");
  let n = 0;
  for (const f of files) {
    const { meta, body } = parseNote(read(join(dir, f)));
    ins.run(String(meta.id || f.replace(/\.md$/, "")), String(meta.key || ""),
      asArray(meta.supersedes).join(" "), asArray(meta.tags).join(" "), String(meta.updated || ""), "agent", body);
    n++;
  }
  return n;
}

/** Записи, которые кто-то заменил (их не показываем как актуальные). */
export function supersededIds(db) {
  const out = new Set();
  for (const row of db.prepare("SELECT supersedes FROM notes").all()) {
    for (const id of String(row.supersedes || "").split(/\s+/)) if (id) out.add(id);
  }
  return out;
}

/** Поиск: релевантность (bm25) + свежесть, старые версии фактов исключаются. */
export function search(db, query, { limit = 5, now = 0, includeSuperseded = false } = {}) {
  const rows = db.prepare("SELECT id, key, updated, supersedes, origin, body, bm25(notes) AS score FROM notes WHERE notes MATCH ? ORDER BY score LIMIT ?")
    .all(String(query), limit * 4);
  const dead = includeSuperseded ? new Set() : supersededIds(db);
  const day = 86400e3;
  const scored = rows.filter((r) => !dead.has(r.id)).map((r) => {
    const t = Date.parse(r.updated || "");
    const fresh = Number.isFinite(t) && now > 0 ? Math.max(0, 1 - (now - t) / (90 * day)) : 0;
    // Архив — история: половинный вес, чтобы не вытеснял свежие заметки
    const archived = String(r.id).startsWith("archive/");
    return { ...r, rank: (-Number(r.score) + fresh * 0.5) * (archived ? 0.5 : 1) };
  });
  return scored.sort((a, b) => b.rank - a.rank).slice(0, limit);
}
