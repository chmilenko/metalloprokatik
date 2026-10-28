/**
 * core/calcService.js — расчёт веса по тексту. НЕ зависит от мессенджера:
 * принимает строку, возвращает данные и готовый простой текст (без Markdown).
 * Им пользуются и Telegram-бот-калькулятор, и (позже) адаптер MAX.
 */

const { parseOrder } = require('../agent/parser');
const { посчитайПоЗаявке } = require('../utils/metalcalc-integration');

const МАКС_ДЛИНА_ТЕКСТА = 600;
const МАКС_ПОЗИЦИЙ = 15;

const кг = (n) => (Math.round(n * 100) / 100).toLocaleString('ru-RU');
const т = (n) => (Math.round(n * 1000) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 3 });

function описатьПозицию(position, r) {
  if (!r) {
    return { ok: false, текст: `❌ ${position.название} — не смог посчитать (не хватает размера или неизвестный вид проката)` };
  }
  if (r._лист) {
    const л = r._лист;
    return {
      ok: true,
      тонн: Number(r.total_weight_tons),
      текст: `✅ ${position.название}\n   ${л.штуки} шт × ${кг(л.кгОдного)} кг = ${т(r.total_weight_tons)} т\n   (лист ${л.толщина}×${л.ширина}×${л.длина} мм)`,
    };
  }
  let текст = `✅ ${position.название}\n   ${r.total_length != null ? `${кг(r.total_length)} м = ` : ''}${т(r.total_weight_tons)} т (${кг(r.weight_per_meter)} кг/м)`;
  if (r.pieces != null) текст += `\n   ${r.pieces} шт × ${r.piece_length} м`;
  if (r._предположениеПоДлине) текст += `\n   ⚠️ Длина хлыста не указана — взята стандартная: ${r._предположениеПоДлине}`;
  return { ok: true, тонн: Number(r.total_weight_tons), текст };
}

/**
 * @returns {Promise<{ok:boolean, ошибка?:string, позиции:Array, строки:Array, итогоТонн:number, текст:string}>}
 */
async function посчитатьТекстом(сырой) {
  const вход = String(сырой || '').trim().slice(0, МАКС_ДЛИНА_ТЕКСТА);
  if (!вход) return { ok: false, ошибка: 'пусто', позиции: [], строки: [], итогоТонн: 0, текст: '' };

  let позиции;
  try {
    позиции = (await parseOrder(вход)) || [];
  } catch (e) {
    return { ok: false, ошибка: 'parse', позиции: [], строки: [], итогоТонн: 0, текст: '' };
  }
  позиции = позиции.slice(0, МАКС_ПОЗИЦИЙ);
  if (!позиции.length) return { ok: false, ошибка: 'не_разобрал', позиции: [], строки: [], итогоТонн: 0, текст: '' };

  const строки = позиции.map((p) => {
    let r = null;
    try { r = посчитайПоЗаявке(p); } catch (e) { /* позиция не считается */ }
    return { название: p.название, ...описатьПозицию(p, r) };
  });
  const итогоТонн = строки.reduce((s, x) => s + (x.ok && x.тонн > 0 ? x.тонн : 0), 0);
  const посчитано = строки.filter((x) => x.ok).length;
  let текст = строки.map((x) => x.текст).join('\n\n');
  if (посчитано > 1) текст += `\n\nИтого: ${т(итогоТонн)} т`;
  return { ok: посчитано > 0, ошибка: посчитано ? undefined : 'не_посчитал', позиции, строки, итогоТонн, текст, исходныйТекст: вход };
}

module.exports = { посчитатьТекстом };