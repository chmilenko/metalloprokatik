/**
 * bot/index.js
 *
 * Точка входа Telegram бота.
 * Инициализирует бота и подключает обработчики сообщений.
 */

require("dotenv").config();
const { Telegraf } = require("telegraf");
const logger = require("../utils/logger");
const { handleMessage } = require("./handlers/message");
const { getSession, clearSession, setSession } = require("../utils/session");
const { handleCallback } = require("./handlers/callback");
const { isAllowed } = require("../utils/auth");
const { saveFeedback, getFeedback } = require("../utils/feedback");
const { getOrder, getRecentOrders } = require("../utils/orderLogger");
const { sendAlert } = require("../utils/alerts");

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Команды — должны быть ДО обработчика текста
bot.command("skip", async (ctx) => {
  if (!isAllowed(ctx.from.id)) return;
  const userId = ctx.from.id;
  const session = getSession(userId);

  if (session.waitingForSearchQuery) {
    const remaining = session.remainingNeedHelp || [];
    
    if (remaining.length > 0) {
      // Есть ещё ненайденные — спрашиваем про следующую
      await ctx.reply("⏭️ Позиция пропущена.");
      
      const next = remaining[0];
      const rest = remaining.slice(1);
      setSession(userId, {
        waitingForSearchQuery: next,
        remainingNeedHelp: rest,
      });

      await ctx.reply(
        `❓ Следующая ненайденная позиция:\n*${next.название}*\n\n` +
        `Найди её вручную на mc.ru и напиши точный поисковый запрос.\n` +
        `Или /skip чтобы пропустить.`,
        { parse_mode: "Markdown" }
      );
    } else {
      // Больше нет ненайденных
      clearSession(userId);
      await ctx.reply("⏭️ Позиция пропущена. Отправь заявку снова.");
    }
  } else {
    await ctx.reply("Нечего пропускать.");
  }
});

bot.command("start", async (ctx) => {
  if (!isAllowed(ctx.from.id)) {
    await ctx.reply("⛔ У вас нет доступа к этому боту.");
    return;
  }
  await ctx.reply(
    "👋 Привет! Я бот для заказов на mc.ru\n\n" +
      "Напиши список позиций металлопроката и я:\n" +
      "1. Найду их на сайте\n" +
      "2. Добавлю в корзину\n" +
      "3. Покажу скриншот корзины\n" +
      "4. Оформлю заказ и пришлю PDF\n\n" +
      "Пример:\n" +
      "Труба ВГП ДУ15 стенка 2 одна тонна\n" +
      "Арматура А500С диаметр 12 две тонны\n\n" +
      "Команды:\n" +
      "/order — последние заявки\n" +
      "/feedback [текст] — сообщить об ошибке\n" +
      "/skip — пропустить ненайденную позицию"
  );
});

// Команда для обратной связи
bot.command("feedback", async (ctx) => {
  if (!isAllowed(ctx.from.id)) return;
  const text = ctx.message.text.replace("/feedback", "").trim();

  if (!text) {
    await ctx.reply(
      "Напиши что не так после команды.\nПример: /feedback лист х/к не нашёлся"
    );
    return;
  }

  saveFeedback(ctx.from.id, ctx.from.username, text);
  await ctx.reply("✅ Спасибо! Записал. Исправим.");

  // Алерт администратору
  const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
  if (ADMIN_ID) {
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `🔔 Фидбек от @${ctx.from.username}:\n\n${text}`
    );
  }
});

// Команда для просмотра заявок
bot.command("order", async (ctx) => {
  if (!isAllowed(ctx.from.id)) return;

  const orderId = ctx.message.text.replace("/order", "").trim();

  if (!orderId) {
    // Показываем последние 5 заявок
    const recent = getRecentOrders(5);
    if (recent.length === 0) {
      await ctx.reply("Заявок пока нет.");
      return;
    }

    let text = "📋 Последние заявки:\n\n";
    recent.forEach((o) => {
      const icon =
        o.итог.статус === "завершено"
          ? "✅"
          : o.итог.статус === "ошибка"
            ? "❌"
            : "⏳";
      text += `${icon} #${o.id} — ${o.итог.найдено}/${o.итог.всего} позиций\n`;
      text += `   @${o.username} | ${new Date(o.время).toLocaleString("ru")}\n\n`;
    });
    text += "Напиши /order [id] для деталей";
    await ctx.reply(text);
    return;
  }

  const order = getOrder(orderId);
  if (!order) {
    await ctx.reply(`❌ Заявка #${orderId} не найдена.`);
    return;
  }

  let text = `📋 Заявка #${order.id}\n\n`;
  text += `Пользователь: @${order.username}\n`;
  text += `Время: ${new Date(order.время).toLocaleString("ru")}\n`;
  text += `Статус: ${order.итог.статус}\n\n`;
  text += `Позиций: ${order.итог.найдено}/${order.итог.всего}\n`;
  text += `Время обработки: ${order.итог.время_обработки_сек}с\n\n`;
  text += `Поиск:\n`;

  order.поиск.forEach((s) => {
    const icon = s.статус === "найдено" ? "✅" : "❌";
    text += `${icon} ${s.название}\n`;
    if (s.выбран) {
      text += `   → ${s.выбран.смц} | ${s.выбран.цена?.toLocaleString("ru")} руб/т\n`;
    }
  });

  await ctx.reply(text);
});

// Команда статистики — только для админа
bot.command("stats", async (ctx) => {
  const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
  if (String(ctx.from.id) !== String(ADMIN_ID)) return;

  const orders = getRecentOrders(100);

  if (orders.length === 0) {
    await ctx.reply("Статистики пока нет.");
    return;
  }

  const total = orders.length;
  const totalFound = orders.reduce((sum, o) => sum + (o.итог.найдено || 0), 0);
  const totalPositions = orders.reduce((sum, o) => sum + (o.итог.всего || 0), 0);
  const successRate = totalPositions > 0
    ? Math.round(totalFound / totalPositions * 100)
    : 0;

  const notFoundMap = {};
  orders.forEach(o => {
    o.поиск?.forEach(s => {
      if (s.статус !== 'найдено') {
        notFoundMap[s.название] = (notFoundMap[s.название] || 0) + 1;
      }
    });
  });

  const topNotFound = Object.entries(notFoundMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  let text = `📊 Статистика бота\n\n`;
  text += `Заявок: ${total}\n`;
  text += `Позиций всего: ${totalPositions}\n`;
  text += `Найдено: ${totalFound}\n`;
  text += `Успешность: ${successRate}%\n\n`;

  if (topNotFound.length > 0) {
    text += `Топ ненайденных:\n`;
    topNotFound.forEach(([name, count], i) => {
      text += `${i + 1}. ${name} — ${count} раз\n`;
    });
    text += '\n';
  }

  text += `Последние заявки:\n`;
  orders.slice(0, 3).forEach(o => {
    const icon = o.итог.статус === 'завершено' ? '✅' : '❌';
    text += `${icon} @${o.username} — ${o.итог.найдено}/${o.итог.всего}\n`;
  });

  // Без parse_mode
  await ctx.reply(text);
});

// Команда для просмотра фидбеков — только для админа
bot.command("feedbacks", async (ctx) => {
  const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
  if (String(ctx.from.id) !== String(ADMIN_ID)) return;

  const feedback = getFeedback();
  if (feedback.length === 0) {
    await ctx.reply("Фидбеков пока нет.");
    return;
  }

  const last5 = feedback.slice(-5);
  let text = `📋 Последние фидбеки:\n\n`;
  last5.forEach((f, i) => {
    const date = new Date(f.время).toLocaleString("ru");
    text += `${i + 1}. @${f.username} (${date})\n${f.текст}\n\n`;
  });

  await ctx.reply(text);
});

bot.on("callback_query", handleCallback);

// Обработка текстовых сообщений
bot.on("text", handleMessage);

// Обработка ошибок
bot.catch(async (err, ctx) => {
  logger.error("Ошибка бота", { error: err.message });

  // Алерт администратору
  await sendAlert(
    bot,
    `Ошибка у @${ctx.from?.username}\n\`${err.message}\``
  );

  if (err.message.includes("timed out")) {
    ctx.reply("⏳ Обработка занимает больше времени чем обычно, подожди...");
  } else {
    ctx.reply("Что-то пошло не так. Попробуйте снова.");
  }
});

// Запуск
bot.launch();
logger.info("Бот запущен");

// Корректное завершение при остановке
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

module.exports = { bot };