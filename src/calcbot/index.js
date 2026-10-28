/**
 * calcbot/index.js — публичный бот-калькулятор металлопроката (отдельный процесс, отдельный токен).
 *
 * Запуск:  pm2 start src/calcbot/index.js --name metalloprokatik-calc
 * .env:    CALC_BOT_TOKEN        — токен бота-калькулятора (BotFather)
 *          TELEGRAM_BOT_TOKEN    — токен ОСНОВНОГО бота: через него лид приходит админу
 *          ADMIN_TELEGRAM_ID     — кому слать лиды (админ должен писать основному боту)
 *          CALC_DAILY_LIMIT      — расчётов в сутки на человека (по умолчанию 20)
 *          CALC_PRIVACY_URL      — ссылка на политику обработки персональных данных
 *          CALC_OWNER            — кто оператор данных (текст в согласии, напр. «ИП Иванов И.И.»)
 *
 * Только расчёт веса + заявка «узнать цену». Парсинга заказов, поиска цен и корзин здесь нет.
 * Логика расчёта — core/calcService.js (не зависит от Telegram, под MAX будет свой адаптер).
 */

require('dotenv').config();
const { Telegraf, Telegram, Markup } = require('telegraf');
const logger = require('../utils/logger');
const { getSession, setSession } = require('../utils/session');
const { посчитатьТекстом } = require('../core/calcService');
const { добавитьЛид, удалитьПользователя } = require('../utils/leads');

const ТОКЕН = process.env.CALC_BOT_TOKEN;
if (!ТОКЕН) {
  logger.error('CALC_BOT_TOKEN не задан — бот-калькулятор не запущен');
  process.exit(1);
}

const ЛИМИТ = Number(process.env.CALC_DAILY_LIMIT) || 20;
const ВЕРСИЯ_СОГЛАСИЯ = '2026-10-28';
const ПЛАТФОРМА = 'telegram';

const bot = new Telegraf(ТОКЕН);
const основной = process.env.TELEGRAM_BOT_TOKEN ? new Telegram(process.env.TELEGRAM_BOT_TOKEN) : null;

// Только личные чаты
bot.use((ctx, next) => (ctx.chat && ctx.chat.type !== 'private' ? undefined : next()));

// ── лимит расчётов (в памяти, сбрасывается по дате) ──
const счётчик = new Map();
function списатьПопытку(userId) {
  const ключ = `${userId}|${new Date().toISOString().slice(0, 10)}`;
  const n = (счётчик.get(ключ) || 0) + 1;
  счётчик.set(ключ, n);
  if (счётчик.size > 5000) счётчик.clear();
  return n <= ЛИМИТ;
}

const ПРИМЕРЫ =
  'Примеры:\n' +
  '• труба 89х3.5 - 300 м\n' +
  '• арматура 12 - 2 т\n' +
  '• швеллер 16П - 20 шт\n' +
  '• лист 3х1250х2500 - 52 шт\n\n' +
  'Можно сразу несколько позиций, каждая с новой строки.';

// Параметр /start с сайта: c_<источник>_<тип>_<размеры...>_<ед><кол-во>[_l<длина хлыста, м>]
// пример: c_direct_pipe_89_3p5_m300 → «труба 89х3.5 - 300 м». p вместо десятичной точки.
const ЕДИНИЦЫ = { m: 'м', t: 'т', s: 'шт', k: 'кг' };
function текстИзПараметра(payload) {
  const ч = String(payload || '').split('_');
  if (ч[0] !== 'c' || ч.length < 5) return null;
  const источник = ч[1].replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'site';
  const тип = ч[2];
  const части = ч.slice(3);
  let длинаХлыста = null;
  if (части.length && /^l[0-9p]+$/.test(части[части.length - 1])) длинаХлыста = части.pop().slice(1);
  const мед = (части.pop() || '').match(/^([mtsk])([0-9p]+)$/);
  if (!мед || !части.length || !части.every((x) => /^[0-9p]+$/.test(x))) return null;
  const число = (x) => x.replace('p', '.');
  const колво = число(мед[2]);
  const ед = ЕДИНИЦЫ[мед[1]];
  const слово = { rebar: 'арматура', round: 'круг', square: 'квадрат', pipe: 'труба', sheet: 'лист' }[тип];
  if (!слово || !(Number(колво) > 0)) return null;
  let текст = `${слово} ${части.map(число).join('х')} - ${колво} ${ед}`;
  if (длинаХлыста && ед === 'шт') текст += `, длина ${Math.round(Number(число(длинаХлыста)) * 1000)} мм`;
  return { источник, текст };
}

bot.start(async (ctx) => {
  const с = текстИзПараметра(ctx.startPayload);
  const прежняя = getSession(ctx.from.id).калькулятор || {};
  const источник = с?.источник || String(ctx.startPayload || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || прежняя.источник || null;
  setSession(ctx.from.id, { калькулятор: { ...прежняя, источник } });
  if (с) {
    await ctx.reply(`Считаю: ${с.текст}`);
    return обработатьРасчёт(ctx, с.текст);
  }
  await ctx.reply(
    'Здравствуйте! Я считаю вес металлопроката: труба, арматура, швеллер, балка, уголок, лист и другое.\n\n' +
      'Напишите позицию и количество — отвечу весом в тоннах.\n\n' + ПРИМЕРЫ,
  );
});

bot.help((ctx) => ctx.reply('Напишите позицию и количество, например:\n\n' + ПРИМЕРЫ + '\n\n/forget — удалить мои данные'));

bot.command('forget', async (ctx) => {
  const n = удалитьПользователя(ПЛАТФОРМА, ctx.from.id);
  setSession(ctx.from.id, { калькулятор: null });
  await ctx.reply(n ? 'Готово, ваши данные и заявки удалены.' : 'Ваших данных у нас нет.', Markup.removeKeyboard());
});

// ── заявка «узнать цену» ──
function кнопкаЦены() {
  return Markup.inlineKeyboard([[Markup.button.callback('💰 Узнать цену', 'c|price')]]);
}

async function предложитьСогласие(ctx) {
  const оператор = process.env.CALC_OWNER || 'владелец сервиса';
  const ссылка = process.env.CALC_PRIVACY_URL ? `\n\nПолитика: ${process.env.CALC_PRIVACY_URL}` : '';
  await ctx.reply(
    'Чтобы рассчитать стоимость, нужен ваш контакт. ' +
      `Нажимая «Согласен», вы даёте согласие (${оператор}) на обработку имени и контакта для ответа на ваш запрос. ` +
      'Удалить данные можно командой /forget.' + ссылка,
    Markup.inlineKeyboard([[Markup.button.callback('✅ Согласен', 'c|agree')]]),
  );
}

async function спроситьСегмент(ctx) {
  await ctx.reply(
    'Вы заказываете как частное лицо или организация?',
    Markup.inlineKeyboard([
      [Markup.button.callback('Частное лицо', 'c|seg|private'), Markup.button.callback('Организация', 'c|seg|org')],
    ]),
  );
}

async function спроситьКонтакт(ctx) {
  await ctx.reply(
    'Оставьте телефон или логин в Telegram — менеджер пришлёт цену. Можно нажать кнопку или написать сообщением.',
    Markup.keyboard([[Markup.button.contactRequest('📱 Отправить мой номер')]]).oneTime().resize(),
  );
}

bot.action('c|price', async (ctx) => {
  await ctx.answerCbQuery();
  const s = getSession(ctx.from.id).калькулятор;
  if (!s?.последний) return ctx.reply('Сначала пришлите позицию для расчёта.');
  if (!s.согласие) return предложитьСогласие(ctx);
  if (!s.сегмент) return спроситьСегмент(ctx);
  setSession(ctx.from.id, { калькулятор: { ...s, шаг: 'контакт' } });
  return спроситьКонтакт(ctx);
});

bot.action('c|agree', async (ctx) => {
  await ctx.answerCbQuery();
  const s = getSession(ctx.from.id).калькулятор;
  if (!s?.последний) return ctx.reply('Сначала пришлите позицию для расчёта.');
  setSession(ctx.from.id, { калькулятор: { ...s, согласие: { время: new Date().toISOString(), версия: ВЕРСИЯ_СОГЛАСИЯ } } });
  return спроситьСегмент(ctx);
});

bot.action(/^c\|seg\|(private|org)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = getSession(ctx.from.id).калькулятор;
  if (!s?.последний || !s.согласие) return ctx.reply('Сначала пришлите позицию для расчёта.');
  setSession(ctx.from.id, { калькулятор: { ...s, сегмент: ctx.match[1], шаг: 'контакт' } });
  return спроситьКонтакт(ctx);
});

async function завершитьЗаявку(ctx, контакт) {
  const s = getSession(ctx.from.id).калькулятор;
  if (!s?.последний || !s.согласие) return ctx.reply('Сначала пришлите позицию для расчёта.');
  const р = s.последний;
  const сегментТекст = s.сегмент === 'org' ? 'организация' : 'частное лицо';
  const id = добавитьЛид({
    платформа: ПЛАТФОРМА,
    userId: ctx.from.id,
    username: ctx.from.username || null,
    имя: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
    контакт,
    сегмент: s.сегмент || null,
    источник: s.источник || null,
    согласие: s.согласие,
    расчёт: { исходныйТекст: р.исходныйТекст, итогоТонн: р.итогоТонн, строки: р.строки.map((x) => x.текст) },
  });
  setSession(ctx.from.id, { калькулятор: { ...s, шаг: null } });
  await ctx.reply('Спасибо! Заявка принята, менеджер свяжется с вами и пришлёт цену.', Markup.removeKeyboard());

  // Лид админу — через ОСНОВНОГО бота. Исходный текст в блоке кода: его можно скопировать в основной бот как заявку.
  const ADMIN = process.env.ADMIN_TELEGRAM_ID;
  if (основной && ADMIN) {
    const текст =
      `🆕 Лид №${id} (калькулятор)\n` +
      `${[ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'без имени'}` +
      `${ctx.from.username ? ` @${ctx.from.username}` : ''} · ${сегментТекст}${s.источник ? ` · источник: ${s.источник}` : ''}\n` +
      `Контакт: ${контакт}\n\n` + р.текст + `\n\nЗаявка для основного бота:\n${р.исходныйТекст}`;
    try {
      await основной.sendMessage(ADMIN, текст.slice(0, 4000));
    } catch (e) {
      logger.error('Не удалось отправить лид админу', { id, error: e.message });
    }
  } else {
    logger.warn('Лид сохранён, но уведомить админа некому (нет TELEGRAM_BOT_TOKEN/ADMIN_TELEGRAM_ID)', { id });
  }
}

bot.on('contact', async (ctx) => {
  const s = getSession(ctx.from.id).калькулятор;
  if (s?.шаг !== 'контакт') return;
  await завершитьЗаявку(ctx, ctx.message.contact.phone_number);
});

async function обработатьРасчёт(ctx, текст) {
  const s = getSession(ctx.from.id).калькулятор;
  if (!списатьПопытку(ctx.from.id)) {
    return ctx.reply('На сегодня лимит расчётов исчерпан. Если нужна цена, нажмите «Узнать цену» под предыдущим расчётом.');
  }

  await ctx.sendChatAction('typing').catch(() => {});
  const р = await посчитатьТекстом(текст);
  if (!р.ok) {
    const причина =
      р.ошибка === 'parse'
        ? 'Сервис временно не отвечает, попробуйте через минуту.'
        : 'Не получилось посчитать. Напишите позицию и количество, например: труба 89х3.5 - 300 м.';
    return ctx.reply(причина);
  }
  setSession(ctx.from.id, { калькулятор: { ...(s || {}), последний: р, шаг: null } });
  await ctx.reply(р.текст, кнопкаЦены());
}

// ── текст: либо контакт (на шаге контакта), либо позиция для расчёта ──
bot.on('text', async (ctx) => {
  const текст = (ctx.message.text || '').trim();
  if (текст.startsWith('/')) return;
  const s = getSession(ctx.from.id).калькулятор;

  if (s?.шаг === 'контакт') {
    if (текст.length < 5 || текст.length > 100) return ctx.reply('Не похоже на контакт. Напишите телефон или логин, например +7 900 000-00-00.');
    return завершитьЗаявку(ctx, текст);
  }

  return обработатьРасчёт(ctx, текст);
});

bot.catch((err, ctx) => logger.error('Ошибка бота-калькулятора', { error: err.message, userId: ctx?.from?.id }));

bot.launch().then(() => logger.info('Бот-калькулятор запущен'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));