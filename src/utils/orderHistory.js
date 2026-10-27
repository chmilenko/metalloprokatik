/**
 * utils/orderHistory.js
 *
 * История оформленных через /order заказов. Без внешних зависимостей: один JSON-файл
 * data/order-history.json (последние 500 заказов), запись атомарная (через временный файл).
 * PDF-файлы на диске не храним — сохраняем file_id Telegram, по нему /history
 * заново присылает счёт или КП.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const ПАПКА = path.join(__dirname, '../../data');
const ФАЙЛ = path.join(ПАПКА, 'order-history.json');
const МАКС_ЗАПИСЕЙ = 500;

function прочитать() {
  try {
    const данные = JSON.parse(fs.readFileSync(ФАЙЛ, 'utf8'));
    return Array.isArray(данные) ? данные : [];
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn('История заказов: не удалось прочитать файл', { error: e.message });
    return [];
  }
}

function записать(список) {
  fs.mkdirSync(ПАПКА, { recursive: true });
  const врем = ФАЙЛ + '.tmp';
  fs.writeFileSync(врем, JSON.stringify(список, null, 1), 'utf8');
  fs.renameSync(врем, ФАЙЛ);
}

/**
 * Добавляет заказ. запись: { userId, username, режим, позиции[], документы[], замечания[], итог }
 * Никогда не бросает исключений — история не должна ломать оформление заказа.
 */
function добавитьЗаказ(запись) {
  try {
    const список = прочитать();
    const id = (список.length ? Math.max(...список.map((з) => з.id || 0)) : 0) + 1;
    список.push({ id, время: new Date().toISOString(), ...запись });
    записать(список.slice(-МАКС_ЗАПИСЕЙ));
    return id;
  } catch (e) {
    logger.warn('История заказов: не удалось сохранить заказ', { error: e.message });
    return null;
  }
}

/** Последние заказы (новые первыми). userId = null — все пользователи. */
function последниеЗаказы(userId, лимит = 10) {
  return прочитать()
    .filter((з) => userId == null || з.userId === userId)
    .slice(-лимит)
    .reverse();
}

/** Меняет запись заказа: изменить(запись) правит объект на месте. */
function обновитьЗаказ(id, изменить) {
  try {
    const список = прочитать();
    const запись = список.find((з) => з.id === id);
    if (!запись) return false;
    изменить(запись);
    записать(список);
    return true;
  } catch (e) {
    logger.warn('История заказов: не удалось обновить заказ', { error: e.message });
    return false;
  }
}

function получитьЗаказ(id) {
  return прочитать().find((з) => з.id === id) || null;
}

module.exports = { добавитьЗаказ, последниеЗаказы, получитьЗаказ, обновитьЗаказ };