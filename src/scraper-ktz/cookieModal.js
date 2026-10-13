/**
 * cookieModal.js
 *
 * Общая для cart-ktz.js и order-ktz.js модалка cookie-согласия —
 * всплывает один раз за сессию браузера, при первом заходе на сайт
 * (до логина). Пока она не закрыта, она перекрывает клики по нижней
 * таблице "Наличие" (и, видимо, другим элементам под ней) — отсюда и
 * баг "модалка мешает вводу количества".
 *
 * Селектор — по тексту ("cookie" в абзаце), а не по CSS-классам:
 * классы вида "style-module-scss-module__pO2uwG__container" —
 * автогенерируемые хэши CSS-модулей, пересобираются при каждом
 * деплое фронтенда (та же причина, по которой не используем
 * автогенерируемые id вида "_r_t_" — см. cart-ktz.js).
 */

const logger = require("../utils/logger");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function закройCookieModalЕслиЕсть(page) {
  const модалкаЕсть = await page.evaluate(() => {
    const абзацы = Array.from(document.querySelectorAll("p"));
    return абзацы.some((p) => p.textContent.toLowerCase().includes("cookie"));
  });

  if (!модалкаЕсть) return;

  logger.info("КТЗ: модалка cookie-согласия — закрываем");

  const нажали = await page.evaluate(() => {
    const абзацы = Array.from(document.querySelectorAll("p"));
    const абзацСCookie = абзацы.find((p) => p.textContent.toLowerCase().includes("cookie"));
    if (!абзацСCookie) return false;
    // Кнопка "Принять" — единственная кнопка в том же контейнере, что
    // и абзац с текстом про cookie (см. присланную разметку).
    const контейнер = абзацСCookie.closest("div") || абзацСCookie.parentElement;
    const кнопка = контейнер?.querySelector("button");
    if (!кнопка) return false;
    кнопка.click();
    return true;
  });

  if (!нажали) {
    logger.warn("КТЗ: не нашли кнопку «Принять» в модалке cookie — продолжаем как есть");
  }

  await delay(400);
}

module.exports = { закройCookieModalЕслиЕсть };