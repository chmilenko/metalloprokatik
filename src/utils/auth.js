/**
 * utils/auth.js — кто может пользоваться ботом.
 *
 * Доступ имеют:
 *   1) администратор (ADMIN_TELEGRAM_ID в .env) — всегда;
 *   2) пользователи из .env: ALLOWED_USERS (ID через запятую) — как раньше, их бот из списка не удаляет;
 *   3) пользователи, добавленные администратором прямо в Telegram (/adduser, кнопка «Добавить»
 *      под запросом доступа) — хранятся в data/users.json, правки подхватываются без перезапуска.
 */

const fs = require("fs");
const path = require("path");

const ФАЙЛ = path.join(__dirname, "../../data/users.json");

function идыИзСтроки(строка) {
  return String(строка || "")
    .split(/[\s,;]+/)
    .map((с) => с.trim())
    .filter((с) => /^\d{3,}$/.test(с));
}

function идыИзEnv() {
  return new Set([
    ...идыИзСтроки(process.env.ALLOWED_USERS),
    ...идыИзСтроки(process.env.ALLOWED_USER_IDS),
    ...идыИзСтроки(process.env.ADMIN_TELEGRAM_ID),
  ]);
}

function adminId() {
  const а = String(process.env.ADMIN_TELEGRAM_ID || "").trim();
  return а || null;
}

function isAdmin(id) {
  const а = adminId();
  return !!а && String(id) === а;
}

function прочитать() {
  try {
    const данные = JSON.parse(fs.readFileSync(ФАЙЛ, "utf8"));
    return данные && typeof данные.users === "object" && данные.users ? данные : { users: {} };
  } catch (e) {
    return { users: {} };
  }
}

function записать(данные) {
  const папка = path.dirname(ФАЙЛ);
  if (!fs.existsSync(папка)) fs.mkdirSync(папка, { recursive: true });
  const времянка = `${ФАЙЛ}.tmp`;
  fs.writeFileSync(времянка, JSON.stringify(данные, null, 2));
  fs.renameSync(времянка, ФАЙЛ);
}

function isAllowed(id) {
  if (id == null) return false;
  const s = String(id);
  if (идыИзEnv().has(s)) return true;
  return Object.prototype.hasOwnProperty.call(прочитать().users, s);
}

/** Добавляет пользователя. Возвращает true, если добавлен новый (false — уже был). */
function добавить(id, { имя = "", username = "", кем = "" } = {}) {
  const s = String(id);
  if (isAllowed(s)) return false;
  const данные = прочитать();
  данные.users[s] = {
    имя: String(имя || "").slice(0, 80),
    username: String(username || "").replace(/^@/, "").slice(0, 40),
    добавлен: new Date().toISOString(),
    кем: String(кем || ""),
  };
  записать(данные);
  return true;
}

/** Удаляет добавленного через бота пользователя. Из .env удалить нельзя (вернётся «env»). */
function удалить(id) {
  const s = String(id);
  if (идыИзEnv().has(s)) return "env";
  const данные = прочитать();
  if (!данные.users[s]) return "нет";
  delete данные.users[s];
  записать(данные);
  return "ок";
}

function список() {
  const env = [...идыИзEnv()].map((id) => ({ id, источник: isAdmin(id) ? "админ" : ".env", имя: "", username: "" }));
  const добавленные = Object.entries(прочитать().users).map(([id, u]) => ({
    id,
    источник: "бот",
    имя: u.имя || "",
    username: u.username || "",
    добавлен: u.добавлен,
  }));
  return [...env, ...добавленные];
}

module.exports = { isAllowed, isAdmin, adminId, добавить, удалить, список };