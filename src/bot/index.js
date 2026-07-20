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
const { getSession, clearSession } = require("../utils/session");
const { handleCallback } = require("./handlers/callback");

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Команды — должны быть ДО обработчика текста
bot.command("skip", async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  if (!isAllowed(ctx.from.id)) return;

  if (session.waitingForSearchQuery) {
    clearSession(userId);
    await ctx.reply("⏭️ Позиция пропущена. Отправь заявку снова.");
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
      "2. Выберу оптимальную базу\n" +
      "3. Оформлю заказ\n" +
      "4. Пришлю PDF счёт\n\n" +
      "Пример:\n" +
      "Труба ВГП ДУ15 стенка 2 одна тонна\n" +
      "Арматура А500С диаметр 12 две тонны",
  );
});

bot.on("callback_query", handleCallback);

// Обработка текстовых сообщений
bot.on("text", handleMessage);

// Обработка ошибок
bot.catch((err, ctx) => {
  logger.error("Ошибка бота", { error: err.message });
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
