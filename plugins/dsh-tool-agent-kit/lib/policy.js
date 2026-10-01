/**
 * Политика риска для привилегированных команд (Shizuku/root).
 *
 * Уровни: read < write < destructive < forbidden.
 *   forbidden   — никогда (агент может убить собственный движок / Shizuku / стереть систему)
 *   destructive — необратимо или ломает окружение → всегда спрашивать при DSH_APPROVAL=risky|ask
 *   write       — меняет состояние, но обратимо → спрашивать только при DSH_APPROVAL=ask
 *   read        — без побочных эффектов → никогда не спрашивать
 *
 * DSH_APPROVAL: auto (по умолчанию = прежнее поведение) | risky (рекомендую) | ask (= SHIZUKU_APPROVE=ask).
 */
const LEVELS = ["read", "write", "destructive", "forbidden"];
const rank = (l) => LEVELS.indexOf(l);
const worst = (a, b) => (rank(a) >= rank(b) ? a : b);

export function protectedPackages() {
  const base = [
    process.env.SHIZUKU_APP_ID || "com.deepseek.harness",
    "com.deepseek.harness",
    "moe.shizuku.privileged.api",
    "com.android.systemui"
  ];
  const extra = (process.env.DSH_PROTECTED_PKGS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...base, ...extra])];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Команды, которые «выключают» сам агент или его канал привилегий. */
function forbiddenReason(cmd) {
  const pk = protectedPackages().map(esc).join("|");
  const hit = (re) => re.test(cmd);
  if (hit(new RegExp(`\\b(pm\\s+(uninstall|clear|disable|disable-user|suspend|hide)|am\\s+(force-stop|kill|kill-all)|cmd\\s+package\\s+(uninstall|clear))\\b[^;&|\\n]*\\b(${pk})\\b`)))
    return "команда остановит/удалит защищённый пакет (само приложение, Shizuku или SystemUI)";
  if (hit(/\b(pkill|killall)\b[^;&|\n]*\b(node|app_process|rish|shizuku)\b/) || hit(/\bkill\s+(-9\s+)?(-1|1)\b/))
    return "команда убьёт процесс движка/канала привилегий";
  if (hit(/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(--\s+)?\/(\s|$|\*|(system|data|vendor|product|apex|storage|sdcard)(\/?\s|\/?$|\/\*))/))
    return "рекурсивное удаление корня или системного раздела";
  if (hit(/\b(dd\s+[^;&|\n]*of=\/dev\/|mkfs|wipe\s+data|reboot\s+(bootloader|recovery|fastboot|sideload))\b/))
    return "низкоуровневая запись на устройство / перезагрузка в служебный режим";
  if (hit(/\bsettings\s+put\s+global\s+(adb_enabled|development_settings_enabled|adb_wifi_enabled)\s+0\b/))
    return "отключение отладки оборвёт канал Shizuku";
  return null;
}

const READ_HEADS = new Set([
  "ls", "cat", "head", "tail", "grep", "egrep", "find", "stat", "df", "du", "ps", "top", "id", "whoami", "pwd", "echo", "date", "uname",
  "getprop", "dumpsys", "logcat", "wc", "sort", "uniq", "cut", "tr", "sed", "awk", "test", "[", "true", "which"
]);

function segmentLevel(seg) {
  const s = seg.trim();
  if (!s) return "read";
  const words = s.split(/\s+/);
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || words[i] === "env")) i++;
  const head = (words[i] || "").replace(/^.*\//, "");
  const a = words[i + 1] || "";
  const rest = words.slice(i + 1).join(" ");

  if (head === "pm") {
    if (/^(list|path|dump|resolve-activity|get-|has-feature)/.test(a)) return "read";
    if (/^(uninstall|clear|disable|disable-user|suspend|hide|revoke|trim-caches)/.test(a)) return "destructive";
    return "write";
  }
  if (head === "settings") {
    if (a === "get" || a === "list") return "read";
    return "destructive"; // put/delete меняют глобальное поведение системы
  }
  if (head === "am" || head === "cmd") {
    if (/^(force-stop|kill|kill-all|crash|clear-debug-app)/.test(a) || /\bpackage\s+(uninstall|clear)/.test(rest)) return "destructive";
    if (/^(stack|task)/.test(a) && /\blist\b/.test(rest)) return "read";
    return "write";
  }
  if (head === "wm") return /^(size|density)\s+\S/.test(rest) ? "destructive" : "read"; // wm size/density с аргументом ломает интерфейс
  if (head === "input" || head === "screencap") return "write";
  if (head === "svc" || head === "reboot" || head === "setprop" || head === "stop" || head === "start") return "destructive";
  if (head === "rm" || head === "rmdir") return /-[a-zA-Z]*[rf]/.test(rest) ? "destructive" : "write";
  if (["chmod", "chown", "mv", "cp", "mkdir", "touch", "tee"].includes(head)) return "write";
  if (head === "find" && /\s-(delete|exec|execdir|ok)\b/.test(" " + rest)) return /-delete|rm\b/.test(rest) ? "destructive" : "write";
  if (READ_HEADS.has(head)) return head === "sed" && /\s-i\b/.test(" " + rest) ? "write" : "read";
  return "write";
}

/** @returns {{level:'read'|'write'|'destructive'|'forbidden', reason:string}} */
export function classifyShell(command) {
  const cmd = String(command ?? "");
  const forb = forbiddenReason(cmd);
  if (forb) return { level: "forbidden", reason: forb };
  let level = "read";
  // сегменты по ; && || | и переводам строк; подстановки $() и `` тоже разбираем
  const flat = cmd.replace(/\$\(([^)]*)\)/g, "; $1 ;").replace(/`([^`]*)`/g, "; $1 ;");
  for (const seg of flat.split(/;|&&|\|\||\||\n/)) level = worst(level, segmentLevel(seg));
  if (/>{1,2}\s*[^\s&|;]/.test(cmd.replace(/2>&1|>\s*\/dev\/null/g, ""))) level = worst(level, "write"); // редирект в файл
  return { level, reason: level === "read" ? "только чтение" : "изменяет состояние устройства" };
}

/** Уровень для структурных действий (android_package и т.п.). */
export function classifyPackageAction(action, pkg) {
  const protectedHit = pkg && protectedPackages().includes(String(pkg));
  if (protectedHit && ["uninstall", "clear", "force_stop", "revoke"].includes(action))
    return { level: "forbidden", reason: `защищённый пакет ${pkg}` };
  if (["uninstall", "clear", "revoke", "force_stop"].includes(action)) return { level: "destructive", reason: action };
  if (["install", "grant", "launch"].includes(action)) return { level: "write", reason: action };
  return { level: "read", reason: action };
}

export function approvalMode() {
  const m = (process.env.DSH_APPROVAL || "").toLowerCase();
  if (m === "auto" || m === "risky" || m === "ask") return m;
  return process.env.SHIZUKU_APPROVE === "ask" ? "ask" : "auto";
}

export function needsApproval(level, mode = approvalMode()) {
  if (level === "forbidden") return false; // не спрашиваем — просто запрещаем
  if (mode === "ask") return level !== "read";
  if (mode === "risky") return level === "destructive";
  return false;
}

/**
 * Единая точка контроля для инструментов. Бросает Error при запрете/отказе.
 * Возвращает решение, чтобы вызывающий мог залогировать.
 */
export async function enforce(ctx, exec, { toolName, verdict, label }) {
  if (verdict.level === "forbidden") {
    throw new Error(`Запрещено политикой безопасности: ${verdict.reason}. Команда не выполнена: ${label}`);
  }
  if (!needsApproval(verdict.level)) return { approved: "auto", level: verdict.level };
  const approver = ctx.get("approval");
  if (approver === undefined) throw new Error("Сервис подтверждений не подключён — рискованное действие заблокировано");
  const outcome = await approver.request({
    agent: exec.agent,
    toolName,
    callId: exec.callId,
    reason: `[${verdict.level}] ${label}`,
    signal: exec.signal
  });
  if (outcome !== "allowed-once") throw new Error(`Действие не одобрено (${outcome}): ${label}`);
  return { approved: "user", level: verdict.level };
}
