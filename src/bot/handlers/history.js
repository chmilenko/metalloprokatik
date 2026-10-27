/**
 * handlers/history.js
 *
 * /history — последние оформленные заказы. Кнопка у заказа открывает подробности
 * и заново присылает счета / КП (по сохранённым file_id Telegram).
 * Менеджер видит свои заказы, админ (ADMIN_TELEGRAM_ID) — заказы всех.
 */

const { isAllowed } = require('../../utils/auth');
const { последниеЗаказы, получитьЗаказ, обновитьЗаказ } = require('../../utils/orderHistory');
const logger = require('../../utils/logger');

const esc = (s) => String(s ?? '');

function этоАдмин(userId) {
  return process.env.ADMIN_TELEGRAM_ID && String(userId) === String(process.env.ADMIN_TELEGRAM_ID);
}

function формат(время) {
  const д = new Date(время);
  return д.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function строкаПозиции(п) {
  const цена = п.цена ? `, ${п.цена} ₽/т` : '';
  const альт = п.альтернатива ? ' (альтернатива)' : '';
  return `• ${esc(п.название)} — ${esc(п.количество)} ${esc(п.единица)} → ${esc(п.база)}${цена}${альт}`;
}

async function handleHistoryCommand(ctx) {
  if (!isAllowed(ctx.from.id)) {
    await ctx.reply('⛔ У вас нет доступа к этому боту.');
    return;
  }
  const админ = этоАдмин(ctx.from.id);
  const заказы = последниеЗаказы(админ ? null : ctx.from.id, 10);
  if (заказы.length === 0) {
    await ctx.reply('История пуста: заказов, оформленных через /order, пока нет.');
    return;
  }
  const кнопки = заказы.map((з) => [{
    text: `№${з.id} · ${формат(з.время)} · ${з.позиции.length} поз.` +
      (админ && з.username ? ` · @${з.username}` : '') + ((з.ожидаемыеСчета || []).some((x) => !x.получен) ? ' ⏳' : з.итог === 'ok' ? '' : ' ⚠️'),
    callback_data: `h|${з.id}`,
  }]);
  await ctx.reply('🗂 Последние заказы (⚠️ — были замечания, ⏳ — счёт ещё не получен):', { reply_markup: { inline_keyboard: кнопки } });
}

async function handleHistoryCallback(ctx) {
  if (!isAllowed(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');
  const части = String(ctx.callbackQuery.data).split('|');
  if (части[1] === 'r') return повторитьСчёт(ctx, parseInt(части[2], 10), parseInt(части[3], 10));
  const id = parseInt(части[1], 10);
  const з = получитьЗаказ(id);
  if (!з || (з.userId !== ctx.from.id && !этоАдмин(ctx.from.id))) {
    return ctx.answerCbQuery('Заказ не найден');
  }
  await ctx.answerCbQuery();

  const режимы = { one: 'один счёт', sep: 'раздельные счета', opt: 'оптимизация по одной базе' };
  const текст = [
    `🗂 Заказ №${з.id} от ${формат(з.время)}` + (з.username ? ` (@${з.username})` : ''),
    з.режим ? `Режим: ${режимы[з.режим] || з.режим}` : null,
    '',
    ...з.позиции.map(строкаПозиции),
    ...(з.замечания && з.замечания.length ? ['', '⚠️ Замечания:', ...з.замечания.map((x) => `• ${x}`)] : []),
  ].filter((x) => x !== null).join('\n');
  const ожидают = (з.ожидаемыеСчета || []).map((x, k) => ({ x, k })).filter(({ x }) => !x.получен);
  await ctx.reply(
    текст.slice(0, 4000),
    ожидают.length
      ? { reply_markup: { inline_keyboard: ожидают.map(({ x, k }) => [{ text: `🔄 Скачать счёт повторно (${x.база})`, callback_data: `h|r|${з.id}|${k}` }]) } }
      : undefined
  );

  for (const д of з.документы || []) {
    try {
      await ctx.replyWithDocument(д.fileId, д.подпись ? { caption: д.подпись.slice(0, 1000) } : undefined);
    } catch (e) {
      logger.warn('История заказов: не удалось отправить документ', { заказ: з.id, файл: д.имя, error: e.message });
      await ctx.reply(`❌ Не удалось прислать ${д.имя}: ${e.message}`);
    }
  }
  if (!(з.документы || []).length) await ctx.reply('Документов у этого заказа нет.');
}

/** Повторное получение счёта, который не скачался при оформлении (или появился на mc.ru позже). */
async function повторитьСчёт(ctx, id, k) {
  const з = получитьЗаказ(id);
  const ож = з && з.ожидаемыеСчета && з.ожидаемыеСчета[k];
  if (!ож || (з.userId !== ctx.from.id && !этоАдмин(ctx.from.id))) return ctx.answerCbQuery('Заказ не найден');
  if (ож.получен) return ctx.answerCbQuery('Этот счёт уже получен');
  await ctx.answerCbQuery('Ищу счёт на mc.ru…');
  await ctx.reply(`⏳ Ищу счёт на mc.ru (база «${ож.база}»)…`);

  const кнопкаСнова = { reply_markup: { inline_keyboard: [[{ text: '🔄 Попробовать ещё раз', callback_data: `h|r|${id}|${k}` }]] } };
  try {
    const { найтиСчетаПоВремени, скачатьСчёт } = require('../../scraper/order');
    let ссылки = ож.счётUrls && ож.счётUrls.length ? ож.счётUrls : null;
    let номера = [];
    if (!ссылки) {
      if (!ож.время) throw new Error('не сохранено время оформления — найдите счёт в личном кабинете mc.ru');
      const найдено = await найтиСчетаПоВремени(ож.время, { до: ож.до });
      ссылки = найдено.map((x) => x.url);
      номера = найдено.map((x) => x.номерСчёта).filter(Boolean);
    }
    if (!ссылки.length) {
      await ctx.reply('Счёта на mc.ru пока нет (заказ ещё «не оформлен» или не создан). Проверьте личный кабинет и попробуйте позже.', кнопкаСнова);
      return;
    }
    const пути = await скачатьСчёт(ссылки);
    const новые = [];
    for (let i = 0; i < пути.length; i++) {
      const имя = ож.смешанные ? `Счёт_mc.ru_${i + 1}.pdf` : `Счёт_mc.ru_${ож.база}.pdf`;
      const подпись = `Счёт mc.ru, база «${ож.база}» (получен повторно).` + (номера[i] ? ` Номер счёта: ${номера[i]}.` : '') + ' Позиции: ' + ож.позиции.join('; ');
      const сообщение = await ctx.replyWithDocument({ source: пути[i], filename: имя }, { caption: подпись.slice(0, 1000) });
      if (сообщение?.document?.file_id) новые.push({ имя, fileId: сообщение.document.file_id, подпись });
    }
    обновитьЗаказ(id, (запись) => {
      запись.документы = [...(запись.документы || []), ...новые];
      запись.ожидаемыеСчета[k].получен = true;
      if (номера.length) запись.ожидаемыеСчета[k].номераСчетов = номера;
    });
  } catch (e) {
    logger.warn('Повторное получение счёта не удалось', { заказ: id, error: e.message });
    await ctx.reply(`❌ Не удалось получить счёт: ${e.message}`, кнопкаСнова);
  }
}

module.exports = { handleHistoryCommand, handleHistoryCallback };