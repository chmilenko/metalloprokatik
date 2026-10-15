/**
 * utils/liveMessage.js
 *
 * «Живое» сообщение: одно сообщение в Telegram, которое бот редактирует по
 * ходу работы (прогресс поиска, сбор корзины), вместо десятков отдельных
 * сообщений. Telegram позволяет редактировать свои сообщения, но:
 *   • не чаще ~1 раза в секунду на чат — поэтому правки копятся и уходят
 *     не чаще раза в 1.5 с (последний текст всегда доходит);
 *   • правка сообщения НЕ даёт менеджеру уведомления — поэтому итог работы
 *     вызывающий код должен присылать отдельным новым сообщением.
 *
 * Используем обычный текст (без parse_mode): названия позиций могут
 * содержать «<», «&» и т.п.
 *
 * Если редактирование не получается (сообщение удалено и т.п.) — тихо
 * отправляем новое сообщение и продолжаем править его.
 */

const logger = require("./logger");

const МИН_ИНТЕРВАЛ_МС = 1500;
const МАКС_ДЛИНА = 4000; // лимит Telegram — 4096

const пауза = (мс) => new Promise((r) => setTimeout(r, мс));

function обрезать(текст) {
  const т = String(текст);
  if (т.length <= МАКС_ДЛИНА) return т;
  return `${т.slice(0, МАКС_ДЛИНА - 20)}\n… (обрезано)`;
}

class ЖивоеСообщение {
  constructor(ctx) {
    this.ctx = ctx;
    this.chatId = ctx.chat?.id ?? ctx.from?.id;
    this.messageId = null;
    this.показано = null; // текст, который сейчас в Telegram
    this.ожидает = null; // текст, который ещё не отправлен
    this.таймер = null;
    this.последняяПравка = 0;
    this.занят = Promise.resolve();
    this.закрыто = false;
  }

  async старт(текст) {
    const сообщение = await this.ctx.reply(обрезать(текст));
    this.messageId = сообщение?.message_id ?? null;
    this.показано = обрезать(текст);
    this.последняяПравка = Date.now();
    return this;
  }

  /** Поставить новый текст (не блокирует; отправится с учётом ограничения частоты). */
  обновить(текст) {
    if (this.закрыто) return;
    const т = обрезать(текст);
    if (т === this.показано && !this.ожидает) return;
    this.ожидает = т;
    if (this.таймер) return;
    const ждать = Math.max(0, this.последняяПравка + МИН_ИНТЕРВАЛ_МС - Date.now());
    this.таймер = setTimeout(() => {
      this.таймер = null;
      this.занят = this.занят.then(() => this._отправить());
    }, ждать);
  }

  async _отправить() {
    const текст = this.ожидает;
    if (текст == null || текст === this.показано) {
      this.ожидает = null;
      return;
    }
    this.ожидает = null;
    for (let попытка = 1; попытка <= 3; попытка++) {
      try {
        if (this.messageId == null) {
          const м = await this.ctx.reply(текст);
          this.messageId = м?.message_id ?? null;
        } else {
          await this.ctx.telegram.editMessageText(this.chatId, this.messageId, undefined, текст);
        }
        this.показано = текст;
        this.последняяПравка = Date.now();
        return;
      } catch (err) {
        const сообщение = String(err?.description || err?.message || "");
        if (/message is not modified/i.test(сообщение)) {
          this.показано = текст;
          return;
        }
        const повтор = err?.parameters?.retry_after || (/too many requests/i.test(сообщение) ? 3 : 0);
        if (повтор && попытка < 3) {
          await пауза((повтор + 0.5) * 1000);
          continue;
        }
        if (/message to edit not found|message can't be edited/i.test(сообщение)) {
          this.messageId = null; // пришлём новое сообщение и будем править его
          continue;
        }
        logger.warn("Живое сообщение: не удалось обновить", { error: сообщение.slice(0, 200) });
        return;
      }
    }
  }

  /** Дождаться, пока последний текст уйдёт в Telegram. */
  async сбросить() {
    if (this.таймер) {
      clearTimeout(this.таймер);
      this.таймер = null;
    }
    this.занят = this.занят.then(() => this._отправить());
    await this.занят;
  }

  /** Финальный текст сообщения; после этого правки игнорируются. */
  async завершить(текст) {
    if (текст != null) this.ожидает = обрезать(текст);
    await this.сбросить();
    this.закрыто = true;
  }
}

async function создатьЖивоеСообщение(ctx, текст) {
  return new ЖивоеСообщение(ctx).старт(текст);
}

module.exports = { создатьЖивоеСообщение, ЖивоеСообщение, МИН_ИНТЕРВАЛ_МС };