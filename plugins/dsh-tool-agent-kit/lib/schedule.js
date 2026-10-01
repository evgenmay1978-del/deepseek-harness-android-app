// Логика android_schedule_list / android_schedule_cancel. Без обращений к API ядра:
// весь ввод-вывод приходит через deps (см. schedule-tools.js), поэтому тестируется офлайн.
//
// Факты (проверены на устройстве 30.09.2026, см. P6):
//  - журнал <files>/scheduled-tasks.json: строки taskId|triggerAt|repeatType|intervalMin|text, только дозапись;
//  - AlarmReceiver файл при срабатывании НЕ читает, будильник живёт только в AlarmManager;
//  - /schedule всегда создаёт PendingIntent с requestCode 0 -> живой будильник из /schedule ОДИН (последний);
//  - повторы после первого срабатывания живут в слоте taskId.hashCode() (AlarmReceiver:129);
//  - команды отмены в cmd alarm нет.
export const NOOP_TEXT = "noop (cancelled)";
export const NEUTRAL_WHEN = "2099-01-01 00:00";
export const PKG = "com.deepseek.harness";

export function parseTasks(raw) {
  const out = [];
  for (const line of String(raw || "").split("\n")) {
    if (!line.trim()) continue;
    const p = line.split("|");
    if (p.length < 5) continue;
    const triggerAt = Number(p[1]);
    if (!Number.isFinite(triggerAt)) continue;
    out.push({ taskId: p[0], triggerAt, repeat: p[2] || "once", intervalMin: Number(p[3]) || 0, text: p.slice(4).join("|") });
  }
  return out;
}

// Последняя строка по taskId + сколько строк у задачи (>1 = цепочка повторов в слоте hashCode).
export function groupTasks(records) {
  const m = new Map();
  for (const r of records) {
    const g = m.get(r.taskId);
    m.set(r.taskId, { last: r, lines: g ? g.lines + 1 : 1 });
  }
  return m;
}

// Живые будильники нашего AlarmReceiver из «dumpsys alarm» (epoch-мс origWhen).
export function parseLiveAlarms(dump) {
  const set = new Set();
  const lines = String(dump || "").split("\n");
  const re = new RegExp("Alarm\\{\\w+ type \\d+ origWhen (\\d+) whenElapsed -?\\d+ " + PKG.replace(/\\./g, "\\.") + "\\}");
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m && (lines[i + 1] || "").includes("AlarmReceiver")) set.add(Number(m[1]));
  }
  return set;
}

// ── маркеры отмены: {ids:[…], texts:[…]} (старый формат — просто массив id) ──
export const normalizeText = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

export function parseMarkers(raw) {
  const out = { ids: [], texts: [] };
  try {
    const v = JSON.parse(String(raw || ""));
    if (Array.isArray(v)) { out.ids = v.map(String); return out; }
    if (v && typeof v === "object") {
      out.ids = Array.isArray(v.ids) ? v.ids.map(String) : [];
      out.texts = Array.isArray(v.texts) ? v.texts.map(normalizeText) : [];
    }
  } catch { /* пусто */ }
  return out;
}

export function emptyMarkers() { return { ids: [], texts: [] }; }

/** Совпадает ли входящее сообщение с отменённой задачей (приложение отправляет текст задачи как есть). */
export function markersHaveText(markers, text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (markers.texts.includes(t)) return true;
  return t.length >= 10 && markers.texts.some((m) => m.length >= 10 && t.includes(m));
}

// status: live | no-alarm | past | cancelled | pending? (dumpsys недоступен)
export function buildList(raw, { now = Date.now(), live = null, cancelled = new Set() } = {}) {
  const rows = [];
  for (const [taskId, g] of groupTasks(parseTasks(raw))) {
    const r = g.last;
    if (r.text.startsWith(NOOP_TEXT)) continue; // служебные заглушки отмены
    let status;
    if (cancelled.has(taskId)) status = "cancelled";
    else if (live === null) status = r.triggerAt > now ? "pending?" : "past";
    else if (live.has(r.triggerAt)) status = "live";
    else status = r.triggerAt > now ? "no-alarm" : "past";
    rows.push({ ...r, lines: g.lines, slot: g.lines > 1 ? "hash" : "0", status });
  }
  return rows.sort((a, b) => a.triggerAt - b.triggerAt);
}

const pad = n => String(n).padStart(2, "0");
export const fmtTime = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const STATUS_HELP = {
  live: "будильник есть",
  "no-alarm": "в журнале есть, будильника нет (перезаписан более поздней задачей или снят)",
  cancelled: "отменена",
  past: "время прошло",
  "pending?": "будильник не проверен (dumpsys недоступен)",
};

export async function listTasks(deps, { includePast = false } = {}) {
  const now = deps.now();
  let raw;
  try { raw = await deps.readTasks(); } catch (e) { return { ok: false, error: "не прочитан журнал задач: " + e.message }; }
  let live = null, truncated = false;
  try {
    const d = await deps.dumpsys();
    if (d) {
      // Канал /shell усекает вывод (проверено 30.09.2026: полный «dumpsys alarm» приходит обрезанным до 8000 символов,
      // нашего пакета в нём нет). Поэтому: нет упоминания пакета — считаем данные недостоверными, а не «будильников нет».
      if (String(d).includes(PKG)) live = parseLiveAlarms(d);
      else truncated = true;
    }
  } catch { /* останется null */ }
  const markers = await deps.readMarkers().catch(() => emptyMarkers());
  const cancelled = new Set(markers.ids || []);
  const all = buildList(raw, { now, live, cancelled });
  const rows = includePast ? all : all.filter(r => r.status !== "past");
  const hidden = all.length - rows.length;
  const out = rows.map(r =>
    r.taskId + " | " + r.status + " | " + fmtTime(r.triggerAt) + " | " +
    (r.repeat === "interval" ? "каждые " + r.intervalMin + " мин" : r.repeat === "daily" ? "каждый день" : "один раз") +
    " | " + r.text);
  const head = rows.length ? "id | статус | время | повтор | текст" : "Задач нет.";
  const legend = [...new Set(rows.map(r => r.status))].map(s => s + " — " + STATUS_HELP[s]).join("; ");
  const notes = [];
  if (live === null) notes.push(truncated
    ? "dumpsys alarm пришёл без нашего пакета (канал /shell усекает вывод): статусы будильников не проверены."
    : "dumpsys alarm не удалось прочитать: статусы по журналу могут врать.");
  notes.push("Из /schedule живёт один будильник — последний созданный; остальные строки журнала без будильника не сработают.");
  if (hidden) notes.push("Прошедших скрыто: " + hidden + " (include_past=true покажет).");
  return { ok: true, total: rows.length, text: [head, ...out, legend && "Статусы: " + legend, ...notes].filter(Boolean).join("\n") };
}

export async function cancelTask(deps, id) {
  const taskId = String(id ?? "").trim();
  if (!taskId) return { ok: false, error: "id пустой" };
  let raw;
  try { raw = await deps.readTasks(); } catch (e) { return { ok: false, error: "не прочитан журнал задач: " + e.message }; }
  const g = groupTasks(parseTasks(raw)).get(taskId);
  if (!g) return { ok: false, error: "задача " + taskId + " не найдена в журнале" };
  const rec = g.last;
  const now = deps.now();

  const markers = await deps.readMarkers().catch(() => emptyMarkers());
  if (!Array.isArray(markers.ids)) markers.ids = [];
  if (!Array.isArray(markers.texts)) markers.texts = [];
  // Пишем и id, и текст: приложение отправляет задачу в движок текстом, без id —
  // поэтому гейт (lib/schedule-gate.js) может опознать отменённую задачу только по тексту.
  const mark = async () => {
    if (!markers.ids.includes(taskId)) markers.ids.push(taskId);
    const nt = normalizeText(rec.text);
    if (nt && !markers.texts.includes(nt)) markers.texts.push(nt);
    await deps.writeMarkers(markers);
  };

  let live = null;
  try { const d = await deps.dumpsys(); if (d && String(d).includes(PKG)) live = parseLiveAlarms(d); } catch { /* null */ }

  if (live && !live.has(rec.triggerAt)) {
    await mark();
    return { ok: true, guaranteed: true, text: rec.triggerAt > now
      ? taskId + ": будильника уже нет (перезаписан более поздней задачей или снят). Помечена отменённой."
      : taskId + ": время уже прошло, будильника нет. Помечена отменённой." };
  }

  // Жёсткая отмена возможна только для слота 0: будильник живой, и у задачи одна строка (цепочки повторов нет).
  if (live && g.lines === 1) {
    let res;
    try { res = await deps.schedulePost({ text: NOOP_TEXT, when: NEUTRAL_WHEN, repeat: "once" }); }
    catch (e) { res = { ok: false, error: e.message }; }
    let still = true;
    if (res && res.ok) {
      try { const d2 = await deps.dumpsys(); still = d2 ? parseLiveAlarms(d2).has(rec.triggerAt) : true; } catch { still = true; }
    }
    await mark();
    if (res && res.ok && !still) {
      return { ok: true, guaranteed: true, text: taskId + ": будильник заменён заглушкой на " + NEUTRAL_WHEN.slice(0, 4) + " год, задача не сработает. В статус-баре может показаться «следующий будильник» 2099 года." };
    }
    return { ok: true, guaranteed: false, text: taskId + ": заменить будильник не удалось" + (res && res.error ? " (" + res.error + ")" : "") + " или он всё ещё виден в dumpsys. Поставлена только метка отмены — задача может сработать." };
  }

  await mark();
  const why = live === null
    ? "dumpsys alarm недоступен, не могу убедиться, что слот 0 принадлежит этой задаче (иначе рискую снять чужой будильник)"
    : "это цепочка повторов: будильник в слоте taskId.hashCode(), заменить его без APK нельзя";
  return { ok: true, guaranteed: false, text: taskId + ": настоящая отмена невозможна — " + why + ". Поставлена метка отмены; уведомление и запуск сервиса всё равно произойдут, а повтор перепланируется. Метка работает только если движок проверяет её перед исполнением (проверка не подключена)." };
}

