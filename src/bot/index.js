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
const ktzCode = require("../utils/ktzCode");
const { handleBasesCommand } = require('./handlers/basePriority');
const { handleCollectCommand } = require('./handlers/collect');
const { handleDecisionCommand } = require('./handlers/decision');
const { экспортироватьЗаявку } = require('../scraper/exportToExcel');
const { handleCalcCommand } = require('./handlers/calc');
const { handleOrderCommand, handleOrderCallback, обработатьТекстКоличества } = require('./handlers/order');
const { handleDiposCommand } = require('./handlers/dipos');
const { handleBrokCommand } = require('./handlers/brok');
const { handleStartCommand, handleHelpCommand, КОМАНДЫ_МЕНЮ } = require('./handlers/help');
const { handlePricesCommand } = require('./handlers/prices');
const { похожеНаЗаявку, ПОДСКАЗКА } = require('../utils/orderFilter');
const { доступ, КОМАНДЫ_АДМИНА } = require('./handlers/access');
const { запуститьЕжедневноеОбновление: запуститьОбновлениеДипоса } = require('../scraper-dipos/download');
const { запуститьЕжедневноеОбновление: запуститьОбновлениеБрока } = require('../scraper-brok/download');
// handlerTimeout: по умолчанию Telegraf обрывает обработчик через 90 секунд и
// пишет "Promise timed out" — а заявка на 7+ позиций (поиск на mc.ru и КТЗ,
// потом сбор корзин) идёт заметно дольше. Работа при этом не прерывалась,
// но в логах и у админа появлялись ложные ошибки. Ставим 15 минут.
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, {
  handlerTimeout: 15 * 60 * 1000,
});

// ──────────────────────────────────────────────────────────────────────
// Очередь обработки + код подтверждения КТЗ
//
// Проблема: Telegraf (polling) не запрашивает новые сообщения, пока не
// завершатся обработчики текущей пачки. Пока /order ждёт код КТЗ, сообщение
// админа с этим кодом даже не доходило бы до бота — взаимная блокировка.
//
// Решение: каждое обновление ставим в ОДНУ общую очередь (обработка по
// одному, как и раньше — браузер у бота общий, параллельно с ним работать
// нельзя), а polling освобождаем сразу. Исключение — сообщение админа с
// кодом, пока бот его ждёт: оно обрабатывается мимо очереди.
// ──────────────────────────────────────────────────────────────────────
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

if (ADMIN_ID) {
  ktzCode.настроитьОтправителя((текст) => bot.telegram.sendMessage(ADMIN_ID, текст));
  require('../agent/llm').настроитьОтправителя((текст) => bot.telegram.sendMessage(ADMIN_ID, текст));
} else {
  logger.warn("ADMIN_TELEGRAM_ID не задан — код подтверждения КТЗ нельзя будет запросить через Telegram");
}

let очередьОбновлений = Promise.resolve();

// Сторож очереди: если обработка одного сообщения зависла (браузер, сайт,
// ожидание ответа), остальные сообщения вставали бы навсегда. Через 30 минут
// предупреждаем админа и пускаем очередь дальше. Зависшая задача при этом
// не прерывается — если она вдруг завершится, просто закончится сама.
const ЛИМИТ_ОБРАБОТКИ_МС = 30 * 60 * 1000;

function сСторожем(задача, ctx) {
  let таймер;
  const сторож = new Promise((resolve) => {
    таймер = setTimeout(() => {
      logger.error("Обработка сообщения зависла, освобождаю очередь", { userId: ctx.from?.id });
      if (ADMIN_ID) {
        bot.telegram
          .sendMessage(
            ADMIN_ID,
            "⚠️ Обработка одного из сообщений идёт больше 30 минут — похоже, зависла. Очередь освобождена, следующие сообщения будут обработаны. Если бот ведёт себя странно: pm2 restart metalloprokatik."
          )
          .catch(() => {});
      }
      resolve();
    }, ЛИМИТ_ОБРАБОТКИ_МС);
  });
  return Promise.race([Promise.resolve(задача).finally(() => clearTimeout(таймер)), сторож]);
}

// Доступ: проверка «кто в списке», запросы доступа и команды /adduser /deluser /users —
// ДО общей очереди, чтобы кнопки администратора срабатывали сразу, даже пока бот занят заказом.
bot.use(доступ());

bot.use(async (ctx, next) => {
  const текст = ctx.message?.text;
  if (текст && ADMIN_ID && String(ctx.from?.id) === String(ADMIN_ID) && ktzCode.ждётКод()) {
    if (ktzCode.передатьКод(текст)) {
      await ctx.reply("✅ Код принят, ввожу его на КТЗ…").catch(() => {});
      return;
    }
  }

  очередьОбновлений = очередьОбновлений
    .then(() => сСторожем(next(), ctx))
    .catch((err) => bot.handleError(err, ctx));
});

bot.command('bases', handleBasesCommand);

bot.command('decision', handleDecisionCommand);

bot.command('collect', handleCollectCommand);

bot.command('calc', handleCalcCommand);

bot.command('order', handleOrderCommand);

bot.command('dipos', handleDiposCommand);

bot.command('brok', handleBrokCommand);

bot.action(/^o\|/, handleOrderCallback);

// Команда /export — экспорт заявки в Excel
bot.command('export', async (ctx) => {
  if (!isAllowed(ctx.from.id)) return;
  
  const text = ctx.message.text.replace('/export', '').trim();
  
  if (!text) {
    await ctx.reply(
      '📝 Использование: /export <заявка>\n\n' +
      'Пример:\n' +
      '/export Полоса г/к 50х5 - 6м\n' +
      'Труба 20х20х1,5 - 1т\n' +
      'Лист 1,5х1250х2500 - 1т'
    );
    return;
  }
  
  await экспортироватьЗаявку(ctx, text);
});

// Команды — должны быть ДО обработчика текста
bot.command("skip", async (ctx) => {
  if (!isAllowed(ctx.from.id)) return;
  const userId = ctx.from.id;
  const session = getSession(userId);

  if (session.waitingForSearchQuery) {
    const remaining = session.remainingNeedHelp || [];

    if (remaining.length > 0) {
      await ctx.reply("⏭️ Позиция пропущена.");

      const next = remaining[0];
      const rest = remaining.slice(1);
      
      // Сохраняем awaitingConfirmation если было
      setSession(userId, {
        awaitingConfirmation: session.awaitingConfirmation,
        selection: session.selection,
        orderId: session.orderId,
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
      // Больше нет ненайденных — сохраняем только awaitingConfirmation
      setSession(userId, {
        awaitingConfirmation: session.awaitingConfirmation,
        selection: session.selection,
        orderId: session.orderId,
      });
      await ctx.reply("⏭️ Позиция пропущена. Можете оформить заказ.");
    }
  } else {
    await ctx.reply("Нечего пропускать.");
  }
});

bot.command("start", handleStartCommand);
bot.command("help", handleHelpCommand);
bot.command("prices", handlePricesCommand);

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

// Фильтр: сообщение без единого признака заявки («привет», «спасибо», «где мой счёт?»)
// не отправляем в LLM — экономим деньги и не путаем менеджера странным ответом.
// Если бот сейчас ждёт текстовый ответ (любое состояние waiting*/await* в сессии,
// например поисковый запрос для ненайденной позиции) — фильтр не вмешивается.
function ждётТекстовыйОтвет(userId) {
  try {
    const сессия = getSession(userId) || {};
    return Object.keys(сессия).some((к) => /^(waiting|await)/i.test(к) && сессия[к]);
  } catch (_) {
    return true; // сомневаемся — не мешаем
  }
}

async function фильтрЗаявок(ctx, next) {
  const текст = ctx.message?.text || "";
  if (ждётТекстовыйОтвет(ctx.from.id) || похожеНаЗаявку(текст)) return next();
  logger.info("Сообщение не похоже на заявку — LLM не вызываем", { userId: ctx.from.id, текст: текст.slice(0, 80) });
  await ctx.reply(ПОДСКАЗКА).catch(() => {});
}

// Обработка текстовых сообщений
// Пока /order ждёт количество для позиции, короткий ответ («2 т») идёт туда, а не в разбор заявки
async function перехватКоличества(ctx, next) {
  if (await обработатьТекстКоличества(ctx)) return;
  return next();
}

bot.on("text", перехватКоличества, фильтрЗаявок, handleMessage);

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

// Запуск. Если запуск не удался (неверный токен, 409 — тот же токен уже
// запущен в другом месте), громко пишем в лог и выходим с кодом 1 — иначе
// процесс висит "живым", но сообщения не получает, а менеджеры не понимают почему.
bot.launch().catch((err) => {
  logger.error("Не удалось запустить бота", { error: err?.message || String(err) });
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  logger.error('Необработанный reject (упало бы молча без этого)', {
    error: err?.message || String(err),
    stack: err?.stack,
  })
})
process.on('uncaughtException', (err) => {
  logger.error('Необработанное исключение (упало бы молча без этого)', {
    error: err.message,
    stack: err.stack,
  })
  // НЕ падаем сразу — даём боту дожить хотя бы до следующего сообщения,
  // но если браузер и правда умер, следующий getPage() пересоздаст его
})
logger.info("Бот запущен");
bot.telegram.setMyCommands(КОМАНДЫ_МЕНЮ).catch((e) => logger.warn("Не удалось задать меню команд", { error: e.message }));
if (ADMIN_ID) {
  bot.telegram
    .setMyCommands([...КОМАНДЫ_МЕНЮ, ...КОМАНДЫ_АДМИНА], { scope: { type: "chat", chat_id: Number(ADMIN_ID) } })
    .catch((e) => logger.warn("Не удалось задать меню команд администратора", { error: e.message }));
}

// Дипос: прайс-лист скачивается каждое утро (≈9:20) — только для сравнения цен
// в сводной таблице, заказать там нельзя (у Дипоса нет корзины).
запуститьОбновлениеДипоса({
  уведомить: ADMIN_ID ? (текст) => bot.telegram.sendMessage(ADMIN_ID, текст) : null,
});

// Брок Инвест: прайс-листы по категориям (склад «Октябрьский») скачиваются
// каждое утро (≈9:30) — тоже только для сравнения цен, без заказа через бота.
запуститьОбновлениеБрока({
  уведомить: ADMIN_ID ? (текст) => bot.telegram.sendMessage(ADMIN_ID, текст) : null,
});

// Корректное завершение при остановке
// bot.stop() бросает "Bot is not running!", если polling уже остановлен или ещё не
// успел стартовать (например, pm2 restart сразу после запуска) — ловим, это не ошибка.
function остановить(сигнал) {
  try {
    bot.stop(сигнал);
  } catch (err) {
    logger.info("Остановка бота: " + (err?.message || err));
  }
  setTimeout(() => process.exit(0), 1000).unref();
}
process.once("SIGINT", () => остановить("SIGINT"));
process.once("SIGTERM", () => остановить("SIGTERM"));

module.exports = { bot };