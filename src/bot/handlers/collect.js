/**
 * handlers/collect.js
 *
 * Команда /collect <база> — берёт ПОСЛЕДНЮЮ собранную для этого
 * пользователя сводную таблицу (см. scraper/exportToExcel.js) и сразу
 * заполняет корзину вариантами, привязанными к указанной базе — без
 * повторного поиска. Дальше тот же флоу, что и раньше: скриншот →
 * подтверждение → PDF (переиспользую finalizeOrder и sendOrderSummary,
 * ничего не пишу заново).
 *
 * ВАЖНО про свежесть данных: между построением таблицы и /collect может
 * пройти время — остаток на складе или цена могли измениться. Если
 * прошло много времени, честно предупреждаем и просим подтвердить, а не
 * тихо действуем по устаревшим данным. Сама addToCart всё равно умеет
 * поймать несовпадение остатка на моменте добавления (см. cart.js) —
 * это не железная гарантия, а разумная подстраховка.
 *
 * Регистрация в bot/index.js:
 *   const { handleCollectCommand } = require('./handlers/collect');
 *   bot.command('collect', handleCollectCommand);
 */

const { isAllowed } = require('../../utils/auth');
const { getSession, setSession } = require('../../utils/session');
const { addToQueue } = require('../../utils/queue');
const { createOrder, saveOrder } = require('../../utils/orderLogger');
const { finalizeOrder } = require('../../scraper/index');
const { разберБазы } = require('../../scraper/baseOptimizer');
const { получиКэшСводки, выбериЛучшего } = require('../../scraper/exportToExcel');
const { sendOrderSummary } = require('./message');
const logger = require('../../utils/logger');

// Если с момента построения таблицы прошло больше этого — сначала
// спрашиваем подтверждение, а не действуем молча
const ПОРОГ_УСТАРЕВАНИЯ_МИН = 20;

async function handleCollectCommand(ctx) {
  if (!isAllowed(ctx.from.id)) {
    await ctx.reply('⛔ У вас нет доступа к этому боту.');
    return;
  }

  const userId = ctx.from.id;
  const база = ctx.message.text.replace('/collect', '').trim();

  const кэш = получиКэшСводки(userId);

  if (!кэш) {
    await ctx.reply(
      '❌ Нет свежей таблицы. Сначала пришлите заявку обычным сообщением — ' +
      'бот пришлёт Excel, и уже потом можно вызвать /collect <база>.'
    );
    return;
  }

  const базыДоступные = [...new Set(
    кэш.позицииДляСводки.flatMap(p => p.прошедшие.flatMap(v => разберБазы(v.смц)))
  )];

  if (!база) {
    await ctx.reply(
      '📝 Использование: /collect <база>\n\n' +
      `Базы, доступные в последней таблице:\n${базыДоступные.map(b => `• ${b}`).join('\n')}`
    );
    return;
  }

  if (!базыДоступные.includes(база)) {
    await ctx.reply(
      `❌ База "${база}" не встречается в последней таблице.\n\n` +
      `Доступные базы:\n${базыДоступные.map(b => `• ${b}`).join('\n')}`
    );
    return;
  }

  // Проверка свежести — таблица могла устареть
  const возрастМин = Math.round((Date.now() - кэш.время) / 60000);
  const session = getSession(userId);

  if (возрастМин > ПОРОГ_УСТАРЕВАНИЯ_МИН && !session.collectConfirmedStale) {
    await ctx.reply(
      `⚠️ Таблица построена ${возрастМин} мин назад — остаток и цены на сайте могли ` +
      `измениться за это время.\n\nЕсли всё равно хотите продолжить именно с этими ` +
      `данными — отправьте /collect ${база} ещё раз в течение 5 минут, я не буду больше спрашивать.`
    );
    setSession(userId, { collectConfirmedStale: true, collectConfirmedStaleUntil: Date.now() + 5 * 60000 });
    return;
  }

  if (session.collectConfirmedStale && session.collectConfirmedStaleUntil < Date.now()) {
    setSession(userId, { collectConfirmedStale: false });
  }

  if (session.processing) {
    await ctx.reply('⏳ Подожди — предыдущая заявка ещё обрабатывается.');
    return;
  }

  setSession(userId, { processing: true, collectConfirmedStale: false });

  const order = createOrder(userId, ctx.from.username, кэш.text);
  order.поиск = кэш.позицииДляСводки.map(p => ({
    название: p.position.название,
    запрос: p.position.поисковый_запрос,
    статус: p.прошедшие.length > 0 ? 'найдено' : 'не найдено',
  }));
  saveOrder(order);

  await ctx.reply(`🛒 Собираю корзину по базе "${база}" из последней таблицы...`);

  try {
    const found = [];
    const непокрытые = [];
    const вариантПоПозиции = new Map();

    for (const { position, прошедшие } of кэш.позицииДляСводки) {
      const наЭтойБазе = прошедшие.filter(v => разберБазы(v.смц).includes(база));
      const лучший = выбериЛучшего(наЭтойБазе)[0] || null;

      if (лучший) {
        found.push({ position, variants: прошедшие });
        // Копируем объект (а не мутируем закэшированный!), чтобы разные
        // /collect для разных баз не затирали друг другу recommendedBase
        // на ОДНОМ И ТОМ ЖЕ закэшированном варианте между вызовами.
        // Без recommendedBase cart.js не знает, какую именно базу мы
        // просим, и берёт ПЕРВУЮ подходящую строку в таблице на сайте —
        // это и было причиной багов "не та база при добавлении".
        вариантПоПозиции.set(position.название, { ...лучший, recommendedBase: база });
      } else {
        непокрытые.push(position);
      }
    }

    if (found.length === 0) {
      await ctx.reply(`❌ Ни одной позиции нет на базе "${база}".`);
      setSession(userId, { processing: false });
      return;
    }

    if (непокрытые.length > 0) {
      await ctx.reply(
        `⚠️ На базе "${база}" нет (${непокрытые.length}):\n` +
        непокрытые.map(p => `• ${p.название}`).join('\n')
      );
    }

    const result = await addToQueue(
      async () => finalizeOrder(
        found,
        вариантПоПозиции,
        непокрытые,
        [],
        async (msg) => { await ctx.reply(msg); },
        order
      ),
      async (queuePosition) => {
        await ctx.reply(`⏳ Ваша заявка в очереди. Позиция: ${queuePosition}`);
      }
    );

    const всегоПозиций = кэш.позицииДляСводки.length;
    await sendOrderSummary(ctx, userId, order, result, всегоПозиций, []);
  } catch (err) {
    logger.error('Ошибка /collect', { userId, error: err.message, stack: err.stack });
    await ctx.reply(`❌ Ошибка: ${err.message}`);
    setSession(userId, { processing: false });
  }
}

module.exports = { handleCollectCommand };