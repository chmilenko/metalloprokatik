/**
 * handlers/dipos.js
 *
 * /dipos — состояние прайса Дипоса и принудительное обновление.
 * Дипос используется только для сравнения цен (в корзину не кладётся).
 */

const { isAllowed } = require("../../utils/auth");
const { инфоОПрайсе } = require("../../scraper-dipos/index");
const { обновитьПрайс } = require("../../scraper-dipos/download");
const logger = require("../../utils/logger");

function описание(инфо) {
  if (!инфо.есть) return "Прайс Дипоса пока не загружен.";
  const часов = инфо.возрастЧасов != null ? Math.round(инфо.возрастЧасов) : null;
  return (
    `Прайс Дипоса от ${инфо.датаПрайсаТекст}` +
    (часов != null ? ` (${часов} ч назад)` : "") +
    `\nПозиций в тоннах: ${инфо.позиций}, из них распознано для сравнения: ${инфо.разобрано}.` +
    (инфо.устарел ? "\n⚠️ Прайс устарел." : "")
  );
}

async function handleDiposCommand(ctx) {
  if (!isAllowed(ctx.from.id)) {
    await ctx.reply("⛔ У вас нет доступа к этому боту.");
    return;
  }

  await ctx.reply(`${описание(инфоОПрайсе())}\n\n⏬ Скачиваю свежий прайс с dipos.ru…`);
  try {
    const р = await обновитьПрайс();
    const с = р.статистика;
    await ctx.reply(
      `✅ Прайс обновлён: от ${р.датаПрайсаТекст}.\n` +
        `Позиций в тоннах: ${с.разобрано + с.неРазобрано}, распознано: ${с.разобрано}` +
        (с.неРазобрано > 0 ? ` (${с.неРазобрано} не распознано — они в сравнении не участвуют)` : "") +
        `.`,
    );
  } catch (err) {
    logger.error("Дипос: ручное обновление не удалось", { error: err.message });
    await ctx.reply(`❌ Не удалось обновить прайс Дипоса: ${err.message}`);
  }
}

module.exports = { handleDiposCommand };