/**
 * handlers/decision.js
 *
 * Команда /decision <orderId> — показывает менеджеру таблицу решения по
 * заявке: какие варианты были доступны на каждую позицию, кто прошёл
 * фильтр, кто отклонён и почему, что в итоге выбрано и почему именно это.
 *
 * ID заказа — тот же самый, что бот показывает в начале обработки заявки
 * ("🔍 Анализирую заявку... (ID: #xxxxxx)"). Просто чтобы не завязываться
 * на то, как именно orderLogger.js связывает заказы с userId (файл не
 * заводили — пусть менеджер сам скопирует ID из истории переписки).
 *
 * Регистрация в bot/index.js (там, где регистрируются остальные команды,
 * например рядом с /order, /stats и т.п.):
 *   const { handleDecisionCommand } = require('./handlers/decision');
 *   bot.command('decision', handleDecisionCommand);
 */

const fs = require('fs');
const path = require('path');
const { isAllowed } = require('../../utils/auth');
const { таблицаТекстом } = require('../../scraper/decisionTable');

const DECISIONS_DIR = path.join(__dirname, '..', '..', '..', 'logs', 'decisions');

async function handleDecisionCommand(ctx) {
  const userId = ctx.from.id;

  if (!isAllowed(userId)) {
    await ctx.reply('⛔ У вас нет доступа к этому боту.');
    return;
  }

  const args = ctx.message.text.split(' ').slice(1);
  const orderId = args[0];

  if (!orderId) {
    // Без аргумента — показываем список последних заказов, по которым
    // есть таблица решения, чтобы менеджер знал, что можно посмотреть
    await showRecentOrders(ctx);
    return;
  }

  const filePath = path.join(DECISIONS_DIR, `${orderId}.json`);

  if (!fs.existsSync(filePath)) {
    await ctx.reply(
      `❌ Таблица решения для заказа #${orderId} не найдена.\n\n` +
      `Отправьте /decision без аргумента, чтобы увидеть список доступных заказов.`
    );
    return;
  }

  let записи;
  try {
    записи = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    await ctx.reply(`❌ Не удалось прочитать таблицу решения: ${err.message}`);
    return;
  }

  if (записи.length === 0) {
    await ctx.reply(`Таблица решения для заказа #${orderId} пуста.`);
    return;
  }

  await ctx.reply(`📋 Таблица решения по заказу #${orderId} (${записи.length} позиций):`);

  // Отправляем по одной позиции отдельным сообщением — у Telegram лимит
  // 4096 символов на сообщение, а таблица по одной позиции может быть
  // длинной сама по себе (особенно с большим количеством отклонённых)
  for (const запись of записи) {
    const текст = таблицаТекстом(запись);
    // На случай если даже одна позиция длиннее лимита — режем на части
    const части = разбейНаЧасти(текст, 3800);
    for (const часть of части) {
      await ctx.reply(часть);
    }
  }
}

async function showRecentOrders(ctx) {
  try {
    if (!fs.existsSync(DECISIONS_DIR)) {
      await ctx.reply('Пока нет ни одной сохранённой таблицы решения.');
      return;
    }

    const файлы = fs.readdirSync(DECISIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filePath = path.join(DECISIONS_DIR, f);
        const stat = fs.statSync(filePath);
        return { orderId: f.replace('.json', ''), mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10);

    if (файлы.length === 0) {
      await ctx.reply('Пока нет ни одной сохранённой таблицы решения.');
      return;
    }

    const список = файлы.map(f => `/decision ${f.orderId}`).join('\n');
    await ctx.reply(`Последние заказы с таблицей решения:\n\n${список}`);
  } catch (err) {
    await ctx.reply(`❌ Не удалось получить список заказов: ${err.message}`);
  }
}

// Разбивает длинный текст на части не длиннее maxLen, стараясь резать по
// границам позиций (разделитель "━━━"), а не посреди строки
function разбейНаЧасти(текст, maxLen) {
  if (текст.length <= maxLen) return [текст];

  const части = [];
  let остаток = текст;

  while (остаток.length > maxLen) {
    let разрез = остаток.lastIndexOf('\n', maxLen);
    if (разрез <= 0) разрез = maxLen;
    части.push(остаток.slice(0, разрез));
    остаток = остаток.slice(разрез).trim();
  }
  if (остаток) части.push(остаток);

  return части;
}

module.exports = { handleDecisionCommand };