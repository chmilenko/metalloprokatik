/**
 * notificationModal.js
 *
 * Общая для cart-ktz.js и order-ktz.js модалка "Уведомление" — сайт
 * переиспользует один и тот же компонент для РАЗНЫХ предупреждений:
 *   - наценка +1000₽/т за заказ < 1 тонны (на странице товара)
 *   - разбивка заказа по двум разным складам, доп. расходы на доставку/
 *     перемещение (на /cart, при оформлении КП)
 * и, возможно, других в будущем. Все они рендерятся как <h2>Уведомление</h2>
 * + кнопка "Продолжить" — определяем по этому общему признаку, а не по
 * конкретному тексту предупреждения, чтобы не пришлось добавлять новую
 * ветку под каждый новый вариант формулировки.
 *
 * ВАЖНО: чекбокс "Больше не показывать" НЕ трогаем — это меняет
 * постоянную настройку аккаунта ("изменить можно в личном кабинете"),
 * а не разовое действие в рамках одной заявки.
 */

const logger = require("../utils/logger");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function закройУведомлениеЕслиЕсть(page) {
  const модалкаЕсть = await page.evaluate(() => {
    const заголовок = Array.from(document.querySelectorAll("h2")).find(
      (el) => el.textContent.trim() === "Уведомление",
    );
    return !!заголовок;
  });

  if (!модалкаЕсть) return;

  logger.info("КТЗ: модалка «Уведомление» — закрываем");

  const нажали = await page.evaluate(() => {
    const кнопки = Array.from(document.querySelectorAll("button"));
    const btn = кнопки.find((b) => b.textContent.trim() === "Продолжить");
    if (!btn) return false;
    btn.click();
    return true;
  });

  if (!нажали) {
    logger.warn('КТЗ: не нашли кнопку "Продолжить" в модалке — пробуем закрыть крестиком');
    await page.evaluate(() => {
      const closeBtn = document.querySelector('button[aria-label="close"]');
      if (closeBtn) closeBtn.click();
    });
  }

  await delay(500);
}

module.exports = { закройУведомлениеЕслиЕсть };