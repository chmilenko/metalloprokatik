/**
 * handlers/message.js
 *
 * Обрабатывает входящие заявки от менеджера.
 *
 * ВАЖНО (текущий режим — "Вариант А"): пока не отточим поиск и подбор
 * базы/цены до уверенного состояния, полный цикл (корзина → скриншот →
 * подтверждение → PDF) ПРИОСТАНОВЛЕН. Вместо него на каждую заявку бот
 * присылает Excel-таблицу со всеми кандидатами по каждой позиции —
 * выбранный, отклонённые (с причиной) и не найденные. Это инструмент
 * проверки и дообучения поиска (см. scraper/exportToExcel.js).
 *
 * Код полного цикла (sendOrderSummary, askBaseConfirmation и т.п.) НЕ
 * удалён — он остаётся в этом файле и используется handlers/callback.js
 * для confirm_order/cancel_order/base_yes/base_no. Когда решим вернуться
 * к полной автоматизации — нужно будет просто заменить тело handleMessage
 * обратно на вызов processOrder (см. историю до этой правки).
 */

const fs = require("fs");
const { Markup } = require("telegraf");
const logger = require("../../utils/logger");
const { parseOrder } = require("../../agent/parser");
const { processOrder } = require("../../scraper/index");
const { экспортироватьЗаявку } = require("../../scraper/exportToExcel");
const { getSession, setSession, clearSession } = require("../../utils/session");
const { saveMapping } = require("../../agent/searchMapManager");
const { addToQueue } = require("../../utils/queue");
const { isAllowed } = require("../../utils/auth");
const { createOrder, saveOrder, logOrder } = require("../../utils/orderLogger");
const { sendAlert } = require("../../utils/alerts");

async function handleMessage(ctx) {
  const text = ctx.message.text;
  const userId = ctx.from.id;
  const messageId = ctx.message.message_id;
  const session = getSession(userId);

  console.log(`=== handleMessage: userId=${userId} messageId=${messageId} text="${text.substring(0, 50)}"`)
  console.log(`=== Сессия: processing=${session.processing} waitingForSearchQuery=${!!session.waitingForSearchQuery}`)

  // Проверяем доступ
  if (!isAllowed(userId)) {
    await ctx.reply("⛔ У вас нет доступа к этому боту.");
    return;
  }

  // Проверяем не обрабатывается ли уже заявка (используем ту же очередь/
  // флаг, что и раньше — браузер по-прежнему один на всех пользователей)
  if (session.processing) {
    await ctx.reply("⏳ Подожди — предыдущая заявка ещё обрабатывается.");
    return;
  }

  setSession(userId, { processing: true });
  logger.info("Получена заявка (режим: Excel-экспорт)", { userId, text });

  try {
    await addToQueue(
      async () => {
        await экспортироватьЗаявку(ctx, text);
      },
      async (queuePosition) => {
        await ctx.reply(`⏳ Ваша заявка в очереди. Позиция: ${queuePosition}`);
      }
    );
  } catch (err) {
    logger.error("Ошибка обработки заявки", { userId, error: err.message, stack: err.stack });

    await sendAlert(
      { telegram: ctx.telegram },
      `Ошибка заявки (Excel-экспорт)\n@${ctx.from.username}\n${err.message}`
    );

    await ctx.reply(`❌ Ошибка: ${err.message}`);
  } finally {
    const currentSession = getSession(userId);
    if (currentSession.processing) {
      setSession(userId, { ...currentSession, processing: false });
    }
  }
}

// ============================================================
// НИЖЕ — код полного цикла (пока не вызывается из handleMessage, см.
// комментарий в шапке файла). Используется handlers/callback.js.
// ============================================================

async function handleMessageFullCycle(ctx) {
  const text = ctx.message.text;
  const userId = ctx.from.id;
  const messageId = ctx.message.message_id;
  const session = getSession(userId);

  console.log(`=== handleMessage: userId=${userId} messageId=${messageId} text="${text.substring(0, 50)}"`)
  console.log(`=== Сессия: processing=${session.processing} waitingForSearchQuery=${!!session.waitingForSearchQuery}`)

  // Проверяем доступ
  if (!isAllowed(userId)) {
    await ctx.reply("⛔ У вас нет доступа к этому боту.");
    return;
  }

  // Проверяем — может менеджер отвечает на вопрос про ненайденную позицию
  if (session.waitingForSearchQuery) {
    return await handleSearchQueryResponse(ctx, text, userId, session);
  }

  // Проверяем не обрабатывается ли уже заявка
  if (session.processing) {
    await ctx.reply("⏳ Подожди — предыдущая заявка ещё обрабатывается.");
    return;
  }

  // Устанавливаем флаг обработки
  setSession(userId, { processing: true });

  logger.info("Получена заявка", { userId, text });

  const order = createOrder(userId, ctx.from.username, text);
  await ctx.reply(`🔍 Анализирую заявку... (ID: #${order.id})`);

  try {
    const positions = await parseOrder(text);

    if (positions.length === 0) {
      await ctx.reply("❌ Не смог найти позиции в заявке. Попробуй написать иначе.");
      order.итог.статус = "ошибка";
      order.итог.ошибка = "Не найдено позиций при парсинге";
      saveOrder(order);
      logOrder(order);
      return;
    }

    order.парсинг = positions.map((p) => ({
      название: p.название,
      поисковый_запрос: p.поисковый_запрос,
      количество: p.количество,
      единица: p.единица,
    }));
    saveOrder(order);

    await ctx.reply(`✅ Нашёл ${positions.length} позиций. Начинаю поиск на mc.ru...`);

    const needHelpList = [];

    const result = await addToQueue(
      async () => {
        return await processOrder(
          positions,
          async (message) => { await ctx.reply(message); },
          async (position) => { needHelpList.push(position); },
          order
        );
      },
      async (queuePosition) => {
        await ctx.reply(`⏳ Ваша заявка #${order.id} в очереди. Позиция: ${queuePosition}`);
      }
    );

    // Подбор базы требует подтверждения менеджера — корзина ЕЩЁ НЕ
    // заполнена. Спрашиваем и ждём ответ через callback (base_yes/base_no
    // в handlers/callback.js), которая потом сама вызовет finalizeOrder.
    if (result.needsBaseConfirmation) {
      setSession(userId, {
        processing: false,
        awaitingBaseConfirmation: true,
        baseFound: result.found,
        baseNotFound: result.notFound,
        baseNeedHelp: result.needHelp,
        baseRecommendation: result.baseRecommendation,
        baseExcluded: [],
        baseOrder: order,
        needHelpList,
      });

      await askBaseConfirmation(ctx, result.baseRecommendation);
      return;
    }

    await sendOrderSummary(ctx, userId, order, result, positions.length, needHelpList);

  } catch (err) {
    logger.error("Ошибка обработки заявки", { userId, error: err.message, stack: err.stack });

    await sendAlert(
      { telegram: ctx.telegram },
      `Ошибка заявки #${order.id}\n@${ctx.from.username}\n${err.message}`
    );

    order.итог.статус = "ошибка";
    order.итог.ошибка = err.message;
    saveOrder(order);
    logOrder(order);

    await ctx.reply(`❌ Ошибка: ${err.message}`);
  } finally {
    // Снимаем флаг обработки
    const currentSession = getSession(userId);
    if (currentSession.processing) {
      setSession(userId, { ...currentSession, processing: false });
    }
  }
}

// Отправляет менеджеру вопрос о подборе базы с кнопками Да/Нет.
// Вызывается и из handleMessage (первая попытка), и из handlers/callback.js
// (повторные попытки после отказа).
async function askBaseConfirmation(ctx, baseRecommendation) {
  await ctx.reply(
    `💰 ${baseRecommendation.объяснение}\n\n${baseRecommendation.вопросДляМенеджера}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Да", "base_yes")],
      [Markup.button.callback("❌ Нет", "base_no")],
    ])
  );
}

// Итоговая сводка + скриншот + кнопки "Оформить заказ"/"Отменить" —
// общая для обычного пути (сразу после processOrder) и для пути после
// подтверждения базы (вызывается из handlers/callback.js)
async function sendOrderSummary(ctx, userId, order, result, всегоПозиций, needHelpList) {
  const { cartScreenshot, selection, notFound } = result;

  const добавленоВКорзину = order.корзина.filter(c => c.статус === 'добавлено').length
  const звонок = order.корзина.filter(c => c.статус === 'звонок').length
  const ошибкаДобавления = order.корзина.filter(c => c.статус === 'ошибка').length

  let summary = `📊 Добавлено в корзину ${добавленоВКорзину} из ${всегоПозиций} позиций:\n\n`

  selection.forEach((s, i) => {
    summary += `${i + 1}. ${s.variant.название}\n`
    summary += `   ${s.position.количество} ${s.position.единица} — ${s.variant.смц}\n`
    summary += `   Цена: ${s.variant.цена_от_1т?.toLocaleString("ru")} руб/т\n`

    const запись = order.корзина.find(
      (c) => c.название === s.position.название && c.смц === s.variant.смц
    );
    if (запись?.предупреждение) {
      summary += `   ⚠️ ${запись.предупреждение}\n`
    }

    summary += `\n`
  })

  if (notFound.length > 0) {
    summary += `❌ Не найдено (${notFound.length}):\n`
    notFound.forEach((p) => { summary += `   • ${p.название}\n` })
    summary += '\n'
  }

  if (звонок > 0) {
    summary += `📞 Только по звонку (${звонок}):\n`
    order.корзина.filter(c => c.статус === 'звонок')
      .forEach(c => { summary += `   • ${c.название}\n` })
    summary += '\n'
  }

  if (ошибкаДобавления > 0) {
    summary += `⚠️ Не удалось добавить (${ошибкаДобавления}):\n`
    order.корзина.filter(c => c.статус === 'ошибка')
      .forEach(c => {
        summary += `   • ${c.название}`
        summary += c.ошибка ? ` — ${c.ошибка}\n` : `\n`
      })
    summary += '\n'
  }

  summary += `💡 Проверьте корзину на скриншоте. Если позиция добавлена неверно — исправьте вручную на mc.ru перед оформлением.`

  await ctx.reply(summary);

  if (cartScreenshot && fs.existsSync(cartScreenshot)) {
    await ctx.replyWithPhoto(
      { source: fs.createReadStream(cartScreenshot) },
      { caption: "🛒 Проверьте корзину перед оформлением заказа" }
    );
  }

  setSession(userId, {
    processing: false,
    awaitingConfirmation: true,
    selection,
    notFound,
    needHelp: needHelpList,
    orderId: order.id,
  });

  await ctx.reply(
    "Всё верно в корзине?",
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Оформить заказ", "confirm_order")],
      [Markup.button.callback("❌ Отменить", "cancel_order")],
    ])
  );

  if (needHelpList.length > 0) {
    await askAboutNextPosition(ctx, userId, needHelpList);
  }
}

async function askAboutNextPosition(ctx, userId, remainingList) {
  const current = remainingList[0];
  const rest = remainingList.slice(1);

  setSession(userId, {
    waitingForSearchQuery: current,
    remainingNeedHelp: rest,
  });

  await ctx.reply(
    `❓ Не смог найти ${remainingList.length} позиций. Помоги научить меня!\n\n` +
    `Позиция:\n*${current.название}*\n\n` +
    `Найди её вручную на mc.ru и напиши точный поисковый запрос который сработал.\n` +
    `Или /skip чтобы пропустить.`,
    { parse_mode: "Markdown" }
  );
}

async function handleSearchQueryResponse(ctx, text, userId, session) {
  const position = session.waitingForSearchQuery;
  const remaining = session.remainingNeedHelp || [];

  saveMapping(position.поисковый_запрос, text);
  logger.info("Сохранено в словарь", {
    from: position.поисковый_запрос,
    to: text,
  });

  await ctx.reply(`✅ Запомнил: "${position.поисковый_запрос}" → "${text}"`);

  if (remaining.length > 0) {
    await askAboutNextPosition(ctx, userId, remaining);
  } else {
    // Полностью очищаем сессию
    clearSession(userId);
    await ctx.reply(
      `🎉 Всё запомнил! Отправь заявку снова — теперь найду все позиции автоматически.`
    );
  }
}

module.exports = { handleMessage, sendOrderSummary, askBaseConfirmation };