/**
 * utils/leads.js — заявки (лиды) с публичных ботов-калькуляторов (Telegram, позже MAX).
 * Один JSON-файл data/leads.json, запись атомарная. Хранит согласие на обработку
 * персональных данных (время + версия текста), сегмент и контакт.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const ПАПКА = path.join(__dirname, '../../data');
const ФАЙЛ = path.join(ПАПКА, 'leads.json');

function прочитать() {
  try {
    const d = JSON.parse(fs.readFileSync(ФАЙЛ, 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn('Лиды: не удалось прочитать файл', { error: e.message });
    return [];
  }
}

function записать(список) {
  fs.mkdirSync(ПАПКА, { recursive: true });
  const врем = ФАЙЛ + '.tmp';
  fs.writeFileSync(врем, JSON.stringify(список, null, 1), 'utf8');
  fs.renameSync(врем, ФАЙЛ);
}

/** лид: { платформа, userId, username, имя, контакт, сегмент, согласие:{время,версия}, расчёт:{исходныйТекст, итогоТонн, строки[]} } */
function добавитьЛид(лид) {
  const список = прочитать();
  const id = (список.length ? Math.max(...список.map((x) => x.id || 0)) : 0) + 1;
  список.push({ id, время: new Date().toISOString(), ...лид });
  записать(список);
  return id;
}

/** «Забудь меня»: удаляет все лиды пользователя. Возвращает, сколько удалено. */
function удалитьПользователя(платформа, userId) {
  const список = прочитать();
  const осталось = список.filter((x) => !(x.платформа === платформа && String(x.userId) === String(userId)));
  if (осталось.length !== список.length) записать(осталось);
  return список.length - осталось.length;
}

module.exports = { добавитьЛид, удалитьПользователя };