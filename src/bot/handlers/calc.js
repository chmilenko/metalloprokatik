/**
 * handlers/calc.js
 *
 * Команда /calc <текст позиции> — быстрый пересчёт веса без поиска на
 * сайтах. Переиспользует parseOrder (тот же парсер, что и для обычной
 * заявки) — значит понимает текст в том же свободном формате, что
 * менеджер и так использует ("труба 89х3.5 - 300м", "круг 34 - 500шт"
 * и т.п.), не нужен отдельный синтаксис команды.
 *
 * Регистрация в bot/index.js:
 *   const { handleCalcCommand } = require('./handlers/calc');
 *   bot.command('calc', handleCalcCommand);
 */

const { isAllowed } = require('../../utils/auth');
const { parseOrder } = require('../../agent/parser');
const { посчитайПоЗаявке } = require('../../utils/metalcalc-integration');
const logger = require('../../utils/logger');

async function handleCalcCommand(ctx) {
  if (!isAllowed(ctx.from.id)) {
    await ctx.reply('⛔ У вас нет доступа к этому боту.');
    return;
  }

  const текст = ctx.message.text.replace('/calc', '').trim();

  if (!текст) {
    await ctx.reply(
      '📝 Использование: /calc <позиция>\n\n' +
      'Примеры:\n' +
      '  /calc труба 89х3.5 - 300м\n' +
      '  /calc круг 34 - 500шт\n' +
      '  /calc арматура 14 - 0.5т\n' +
      '  /calc швеллер 16П - 200шт'
    );
    return;
  }

  try {
    const positions = await parseOrder(текст);

    if (positions.length === 0) {
      await ctx.reply('❌ Не разобрал позицию — попробуйте переформулировать.');
      return;
    }

    const строки = [];

    for (const position of positions) {
      const результат = посчитайПоЗаявке(position);

      if (!результат) {
        строки.push(
          `❌ *${position.название}* — не смог посчитать (неизвестная форма проката или не хватает размера в заявке)`
        );
        continue;
      }

      let строка = `✅ *${position.название}*\n` +
        `   ${результат.total_length} м = ${результат.total_weight_tons} т ` +
        `(${результат.weight_per_meter} кг/м)`;

      if (результат.pieces != null) {
        строка += `\n   ${результат.pieces} шт × ${результат.piece_length} м`;
      }
      if (результат._предположениеПоДлине) {
        строка += `\n   ⚠️ Длина хлыста не указана в заявке — взято по умолчанию: ${результат._предположениеПоДлине}`;
      }

      строки.push(строка);
    }

    await ctx.reply(строки.join('\n\n'), { parse_mode: 'Markdown' });
  } catch (err) {
    logger.error('Ошибка /calc', { userId: ctx.from.id, error: err.message, stack: err.stack });
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
}

module.exports = { handleCalcCommand };