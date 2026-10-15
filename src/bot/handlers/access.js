/**
 * handlers/access.js — управление доступом прямо из Telegram, без сервера.
 *
 * Для администратора:
 *   /adduser 123456789 Иван   — добавить пользователя (имя необязательно)
 *   /deluser 123456789        — убрать пользователя
 *   /users                    — кто имеет доступ
 * Для остальных: кто не в списке, получает свой ID и кнопку-запрос; администратору приходит
 * сообщение «✅ Добавить / ❌ Отклонить».
 *
 * Работает ДО общей очереди сообщений — кнопки администратора срабатывают сразу,
 * даже если бот занят оформлением заказа.
 */

const logger = require("../../utils/logger");
const auth = require("../../utils/auth");

const ПОВТОР_ЗАПРОСА_МС = 60 * 60 * 1000; // не чаще раза в час на человека
const БЛОК_ПОСЛЕ_ОТКАЗА_МС = 24 * 60 * 60 * 1000;
const запросы = new Map(); // id → время последнего запроса админу
const отказы = new Map(); // id → до какого времени не беспокоим админа

const экран = (т) => String(т || "").replace(/[<>&]/g, (с) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[с]));

function описание(from) {
  const имя = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return { имя, username: from.username || "" };
}

function подпись({ имя, username }, id) {
  return `${экран(имя) || "без имени"}${username ? ` (@${экран(username)})` : ""}, ID <code>${id}</code>`;
}

async function командаАдмина(ctx, команда, аргументы) {
  const части = аргументы.trim().split(/\s+/).filter(Boolean);

  if (команда === "users") {
    const л = auth.список();
    const строки = л.map((u) => {
      const имя = u.имя ? ` — ${экран(u.имя)}` : "";
      const ник = u.username ? ` @${экран(u.username)}` : "";
      return `• <code>${u.id}</code>${имя}${ник} <i>[${u.источник}]</i>`;
    });
    await ctx.reply(
      `👥 Доступ к боту (${л.length}):\n${строки.join("\n") || "пока никого"}\n\n` +
        `Добавить: /adduser 123456789 Имя\nУбрать: /deluser 123456789\n` +
        `<i>[.env] и [админ] убрать из бота нельзя — только правкой .env на сервере.</i>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const id = части[0];
  if (!id || !/^\d{5,15}$/.test(id)) {
    await ctx.reply(
      команда === "adduser"
        ? "Использование: /adduser 123456789 Имя\n(ID человек может узнать у бота @userinfobot или просто написать вашему боту — вам придёт запрос с кнопкой.)"
        : "Использование: /deluser 123456789\nСписок: /users"
    );
    return;
  }

  if (команда === "adduser") {
    const имя = части.slice(1).join(" ");
    const новый = auth.добавить(id, { имя, кем: String(ctx.from.id) });
    if (!новый) {
      await ctx.reply(`ℹ️ ${id} уже имеет доступ.`);
      return;
    }
    logger.info("Доступ: добавлен пользователь", { id, имя, админ: ctx.from.id });
    await ctx.reply(`✅ Добавлен: ${id}${имя ? ` (${имя})` : ""}`);
    await ctx.telegram
      .sendMessage(id, "✅ Вам открыт доступ к боту. Напишите /help — там инструкция.")
      .catch(() => ctx.reply("⚠️ Доступ открыт, но написать ему первым бот не может — пусть сам нажмёт /start у бота."));
    return;
  }

  // deluser
  const р = auth.удалить(id);
  if (р === "env") await ctx.reply("⛔ Этот пользователь записан в .env на сервере (админ или ALLOWED_USERS) — из бота его не убрать.");
  else if (р === "нет") await ctx.reply(`ℹ️ ${id} нет в списке, добавленном через бота. Проверьте /users.`);
  else {
    logger.info("Доступ: пользователь удалён", { id, админ: ctx.from.id });
    await ctx.reply(`🗑 Убран: ${id}`);
  }
}

async function кнопкаАдмина(ctx) {
  const [, действие, id] = String(ctx.callbackQuery.data).split("|");
  if (!/^\d{5,15}$/.test(id || "")) return ctx.answerCbQuery("Некорректный ID").catch(() => {});
  const исходный = ctx.callbackQuery.message?.text || "";
  if (действие === "ok") {
    // имя и ник берём из текста запроса, который бот сам отправил
    const имя = (исходный.match(/^Имя: (.*)$/m) || [])[1] || "";
    const username = ((исходный.match(/^Ник: @(.*)$/m) || [])[1] || "").trim();
    const новый = auth.добавить(id, { имя: имя === "—" ? "" : имя, username, кем: String(ctx.from.id) });
    logger.info("Доступ: запрос одобрен", { id, админ: ctx.from.id });
    await ctx.answerCbQuery(новый ? "Добавлен" : "Уже был").catch(() => {});
    await ctx.editMessageText(`✅ Доступ открыт: ${id}${имя && имя !== "—" ? ` (${имя})` : ""}`).catch(() => {});
    await ctx.telegram.sendMessage(id, "✅ Вам открыт доступ к боту. Напишите /help — там инструкция.").catch(() => {});
  } else {
    отказы.set(String(id), Date.now() + БЛОК_ПОСЛЕ_ОТКАЗА_МС);
    logger.info("Доступ: запрос отклонён", { id, админ: ctx.from.id });
    await ctx.answerCbQuery("Отклонён").catch(() => {});
    await ctx.editMessageText(`❌ Запрос отклонён: ${id}`).catch(() => {});
    await ctx.telegram.sendMessage(id, "⛔ Администратор не одобрил доступ.").catch(() => {});
  }
}

async function запросДоступа(ctx) {
  const id = String(ctx.from.id);
  const админ = auth.adminId();
  const кому = описание(ctx.from);

  if (!админ) {
    await ctx.reply(`⛔ У вас нет доступа к этому боту.\nВаш ID: ${id} — сообщите его администратору.`);
    return;
  }
  const молчим = отказы.get(id);
  if (молчим && молчим > Date.now()) {
    await ctx.reply("⛔ У вас нет доступа к этому боту.");
    return;
  }
  const было = запросы.get(id);
  if (было && Date.now() - было < ПОВТОР_ЗАПРОСА_МС) {
    await ctx.reply("⛔ У вас пока нет доступа. Запрос уже отправлен администратору — дождитесь ответа.");
    return;
  }
  запросы.set(id, Date.now());
  try {
    await ctx.telegram.sendMessage(
      админ,
      `🆕 Запрос доступа к боту\nИмя: ${кому.имя || "—"}\nНик: ${кому.username ? "@" + кому.username : "—"}\nID: ${id}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Добавить", callback_data: `au|ok|${id}` },
            { text: "❌ Отклонить", callback_data: `au|no|${id}` },
          ]],
        },
      }
    );
    await ctx.reply(`⛔ У вас пока нет доступа к этому боту.\nЗапрос отправлен администратору. Ваш ID: ${id}`);
  } catch (err) {
    logger.error("Доступ: не удалось отправить запрос администратору", { error: err.message });
    await ctx.reply(`⛔ У вас нет доступа к этому боту.\nВаш ID: ${id} — сообщите его администратору.`);
  }
}

/** Middleware: ставится ДО общей очереди. */
function доступ() {
  return async (ctx, next) => {
    const id = ctx.from?.id;
    if (id == null) return next();

    const данныеКнопки = ctx.callbackQuery?.data;
    if (typeof данныеКнопки === "string" && данныеКнопки.startsWith("au|")) {
      if (auth.isAdmin(id)) await кнопкаАдмина(ctx);
      else await ctx.answerCbQuery("Только для администратора").catch(() => {});
      return;
    }

    const текст = ctx.message?.text;
    const м = текст && текст.match(/^\/(adduser|deluser|users)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    if (м && auth.isAdmin(id)) {
      await командаАдмина(ctx, м[1].toLowerCase(), м[2] || "").catch((err) => {
        logger.error("Доступ: ошибка команды", { error: err.message });
        return ctx.reply(`❌ Ошибка: ${err.message}`);
      });
      return;
    }

    if (м) {
      await ctx.reply("⛔ Эта команда только для администратора.").catch(() => {});
      return;
    }

    if (auth.isAllowed(id)) return next();

    // Не в списке
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("⛔ Нет доступа").catch(() => {});
      return;
    }
    if (ctx.message) await запросДоступа(ctx);
  };
}

module.exports = { доступ, КОМАНДЫ_АДМИНА: [
  { command: "users", description: "Кто имеет доступ к боту" },
  { command: "adduser", description: "Добавить пользователя: /adduser ID Имя" },
  { command: "deluser", description: "Убрать пользователя: /deluser ID" },
] };