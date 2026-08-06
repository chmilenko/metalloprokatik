/**
 * handlers/basePriority.js
 *
 * Команда /bases — интерактивная настройка приоритета баз кнопками.
 * Менеджер тапает базы в нужном порядке (первый тап = наивысший
 * приоритет), в конце жмёт "Готово" — порядок сохраняется в
 * data/basePriority.json (через utils/basePriorityStore.js) и
 * используется в scraper/baseOptimizer.js при подборе базы.
 *
 * Регистрация в bot/index.js:
 *   const { handleBasesCommand, handleBasePriorityCallback } = require('./handlers/basePriority');
 *   bot.command('bases', handleBasesCommand);
 * И внутри существующего handleCallback (callback.js) — роутинг вызовов
 * с data, начинающимся на "baseprio:", на handleBasePriorityCallback
 * (см. пример в конце файла).
 */

const { Markup } = require('telegraf');
const { isAllowed } = require('../../utils/auth');
const { getSession, setSession, clearSession } = require('../../utils/session');
const { getBasePriority, setBasePriority, ИЗВЕСТНЫЕ_БАЗЫ } = require('../../utils/basePriorityStore');

function построиКлавиатуру(оставшиеся, показатьГотово) {
  const кнопки = оставшиеся.map(б => [Markup.button.callback(б, `baseprio:pick:${б}`)]);
  if (показатьГотово) {
    кнопки.push([Markup.button.callback('✅ Готово', 'baseprio:done')]);
  }
  кнопки.push([Markup.button.callback('🔄 Сбросить', 'baseprio:reset')]);
  return Markup.inlineKeyboard(кнопки);
}

function текстПрогресса(выбранные) {
  const списокВыбранных = выбранные.length > 0
    ? выбранные.map((б, i) => `${i + 1}. ${б}`).join('\n')
    : '(пока пусто)';

  let текст = `⚙️ Настройка приоритета баз\n\nТапайте базы по убыванию приоритета — первая нажатая станет главной.\n\nВыбрано:\n${списокВыбранных}`;

  if (выбранные.length > 0) {
    текст += `\n\nМожно нажать "Готово" в любой момент — остальные базы будут считаться "в меньшей степени", без строгого порядка.`;
  }

  return текст;
}

async function handleBasesCommand(ctx) {
  if (!isAllowed(ctx.from.id)) {
    await ctx.reply('⛔ У вас нет доступа к этому боту.');
    return;
  }

  const userId = ctx.from.id;
  const текущий = getBasePriority();

  await ctx.reply(
    `Текущий приоритет баз:\n${текущий.map((б, i) => `${i + 1}. ${б}`).join('\n')}\n\nНастроить заново?`
  );

  setSession(userId, { basePriorityPicking: { выбранные: [] } });

  await ctx.reply(
    текстПрогресса([]),
    построиКлавиатуру(ИЗВЕСТНЫЕ_БАЗЫ, false)
  );
}

async function handleBasePriorityCallback(ctx) {
  const data = ctx.callbackQuery.data; // "baseprio:pick:Карачарово" | "baseprio:reset" | "baseprio:done"
  const userId = ctx.from.id;
  const session = getSession(userId);

  await ctx.answerCbQuery();

  if (!session.basePriorityPicking) {
    await ctx.reply('❌ Нет активной настройки баз. Отправьте /bases заново.');
    return;
  }

  const { выбранные } = session.basePriorityPicking;

  if (data === 'baseprio:reset') {
    setSession(userId, { basePriorityPicking: { выбранные: [] } });
    await ctx.editMessageText(текстПрогресса([]), построиКлавиатуру(ИЗВЕСТНЫЕ_БАЗЫ, false));
    return;
  }

  if (data === 'baseprio:done') {
    if (выбранные.length === 0) {
      await ctx.reply('Выберите хотя бы одну базу перед сохранением.');
      return;
    }

    const сохранено = setBasePriority(выбранные);
    clearSession(userId);

    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

    if (сохранено) {
      await ctx.reply(`✅ Приоритет сохранён:\n${выбранные.map((б, i) => `${i + 1}. ${б}`).join('\n')}`);
    } else {
      await ctx.reply('❌ Не удалось сохранить приоритет — попробуйте ещё раз.');
    }
    return;
  }

  if (data.startsWith('baseprio:pick:')) {
    const база = data.replace('baseprio:pick:', '');
    if (выбранные.includes(база)) return; // уже выбрана, игнорируем повторный тап

    const новыеВыбранные = [...выбранные, база];
    setSession(userId, { basePriorityPicking: { выбранные: новыеВыбранные } });

    const оставшиеся = ИЗВЕСТНЫЕ_БАЗЫ.filter(б => !новыеВыбранные.includes(б));

    await ctx.editMessageText(
      текстПрогресса(новыеВыбранные),
      построиКлавиатуру(оставшиеся, true)
    );
  }
}

module.exports = { handleBasesCommand, handleBasePriorityCallback };