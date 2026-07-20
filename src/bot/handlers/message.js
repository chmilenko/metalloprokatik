/**
 * handlers/message.js
 *
 * Обрабатывает входящие заявки от менеджера.
 * Полный цикл: парсинг → поиск → корзина → скриншот → подтверждение → PDF
 */

const fs = require("fs");
const { Markup } = require("telegraf");
const logger = require("../../utils/logger");
const { parseOrder } = require("../../agent/parser");
const { processOrder } = require("../../scraper/index");
const { getSession, setSession, clearSession } = require("../../utils/session");
const { saveMapping } = require("../../agent/searchMapManager");
const { isAllowed } = require("../../utils/auth");

async function handleMessage(ctx) {
  const text = ctx.message.text;
  const userId = ctx.from.id;
  const session = getSession(userId);
  const userId = ctx.from.id;

  if (!isAllowed(userId)) {
    await ctx.reply("⛔ У вас нет доступа к этому боту.");
    return;
  }

  // Проверяем — может менеджер отвечает на вопрос про ненайденную позицию
  if (session.waitingForSearchQuery) {
    return await handleSearchQueryResponse(ctx, text, userId, session);
  }

  logger.info("Получена заявка", { userId, text });
  await ctx.reply("🔍 Анализирую заявку...");

  try {
    const positions = await parseOrder(text);

    if (positions.length === 0) {
      await ctx.reply(
        "❌ Не смог найти позиции в заявке. Попробуй написать иначе.",
      );
      return;
    }

    await ctx.reply(
      `✅ Нашёл ${positions.length} позиций. Начинаю поиск на mc.ru...`,
    );

    const needHelpList = [];

    const { cartScreenshot, selection, notFound, needHelp, bases } =
      await processOrder(
        positions,
        async (message) => {
          await ctx.reply(message);
        },
        async (position) => {
          needHelpList.push(position);
        },
      );

    // Итоговая сводка
    let summary = `📊 Найдено ${selection.length} из ${positions.length} позиций:\n\n`;
    selection.forEach((s, i) => {
      summary += `${i + 1}. ${s.position.название}\n`;
      summary += `   ${s.position.количество} ${s.position.единица} — ${s.variant.смц}\n`;
      summary += `   Цена: ${s.variant.цена_от_1т.toLocaleString("ru")} руб/т\n\n`;
    });

    if (notFound.length > 0) {
      summary += `❌ Не найдено (${notFound.length}):\n`;
      notFound.forEach((p) => {
        summary += `   • ${p.название}\n`;
      });
    }

    await ctx.reply(summary);

    // Отправляем скриншот корзины
    if (cartScreenshot && fs.existsSync(cartScreenshot)) {
      await ctx.replyWithPhoto(
        { source: fs.createReadStream(cartScreenshot) },
        { caption: "🛒 Проверьте корзину перед оформлением заказа" },
      );
    }

    // Сохраняем состояние в сессию — ждём подтверждения
    setSession(userId, {
      awaitingConfirmation: true,
      selection,
      notFound,
      needHelp: needHelpList,
    });

    // Кнопки подтверждения
    await ctx.reply(
      "Всё верно в корзине?",
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Оформить заказ", "confirm_order")],
        [Markup.button.callback("❌ Отменить", "cancel_order")],
      ]),
    );

    // Спрашиваем про ненайденные позиции
    if (needHelpList.length > 0) {
      await askAboutNextPosition(ctx, userId, needHelpList);
    }
  } catch (err) {
    logger.error("Ошибка обработки заявки", { userId, error: err.message });
    await ctx.reply(`❌ Ошибка: ${err.message}`);
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
    { parse_mode: "Markdown" },
  );
}

async function handleSearchQueryResponse(ctx, text, userId, session) {
  const position = session.waitingForSearchQuery;
  const remaining = session.remainingNeedHelp || [];

  await ctx.reply(`🔄 Пробую запрос "${text}"...`);

  try {
    const { searchPosition } = require("../../scraper/search");
    const result = await searchPosition(text, position);

    if (result.found) {
      saveMapping(position.поисковый_запрос, text);
      logger.info("Сохранено в словарь", {
        from: position.поисковый_запрос,
        to: text,
      });

      await ctx.reply(
        `✅ Нашёл! Запомнил: "${position.поисковый_запрос}" → "${text}"`,
      );

      if (remaining.length > 0) {
        await askAboutNextPosition(ctx, userId, remaining);
      } else {
        clearSession(userId);
        await ctx.reply(
          `🎉 Всё запомнил! Отправь заявку снова — теперь найду все позиции автоматически.`,
        );
      }
    } else {
      await ctx.reply(
        `❌ По запросу "${text}" тоже не нашлось.\n\n` +
          `Попробуй другой запрос или /skip чтобы пропустить.`,
      );
    }
  } catch (err) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
}

module.exports = { handleMessage };
