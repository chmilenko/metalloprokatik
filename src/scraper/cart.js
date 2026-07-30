/**
 * cart.js
 *
 * Работа с корзиной на mc.ru.
 * Добавляет позиции в корзину через модальное окно (iframe).
 */

const logger = require("../utils/logger");
const { getPage } = require("./browser");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function addToCart(variant, quantity, unit = "т") {
  const page = await getPage();

  logger.info("Добавляем в корзину", {
    название: variant.название,
    смц: variant.смц,
    количество: quantity,
    единица: unit,
  });

  // Переходим на главную и ищем через поисковую строку
  await page.goto("https://mc.ru");
  await page.waitForLoadState("domcontentloaded");
  await delay(1000);

  // Открываем поиск
  await page.evaluate(() => {
    document.querySelector("#searchField").click();
  });
  await delay(300);

  // Вводим запрос
  await page.waitForSelector('input[name="referal"]', { state: "visible" });
  await page.fill('input[name="referal"]', variant.поисковый_запрос);
  await delay(300);

  await page.press('input[name="referal"]', "Enter");
  await page.waitForLoadState("domcontentloaded");
  await delay(2000);

  // Ждём таблицу
  await page.waitForSelector("table tbody tr", {
    state: "visible",
    timeout: 10000,
  });
  await delay(500);

  // Находим нужную строку по названию и СМЦ
  const rows = await page.$$("table tbody tr");

  let targetRow = null;

  for (const row of rows) {
    // Пропускаем строки без кнопки
    const hasButton = await row
      .$("button._basket, button._phone")
      .catch(() => null);
    if (!hasButton) continue;

    const смц = await row
      .$eval("td._fact", (el) => el.innerText.trim())
      .catch(() =>
        row
          .$eval("td:nth-child(5)", (el) => el.innerText.trim())
          .catch(() => ""),
      );
    const название = await row
      .$eval("td.TovName", (el) => el.innerText.trim())
      .catch(() =>
        row
          .$eval("td:nth-child(1)", (el) => el.innerText.trim())
          .catch(() => ""),
      );

    if (смц === variant.смц && название === variant.название) {
      targetRow = row;
      break;
    }
  }

  if (!targetRow) {
    throw new Error(
      `Не нашли строку: ${variant.название} на базе ${variant.смц}`,
    );
  }

  // Проверяем кнопки
  const basketBtn = await targetRow.$("button._basket").catch(() => null);
  const phoneBtn = await targetRow.$("button._phone").catch(() => null);

  if (phoneBtn && !basketBtn) {
    logger.warn("Позиция только по звонку", {
      название: variant.название,
      смц: variant.смц,
    });
    throw new Error(`PHONE_ONLY:${variant.название}`);
  }

  if (!basketBtn) {
    throw new Error(`Не нашли кнопку корзины: ${variant.название}`);
  }

  // Кликаем на иконку корзины
  await basketBtn.click();
  await delay(1000);

  // Ждём появления iframe внутри модалки
  await page.waitForSelector("#addbasket", { state: "visible" });
  await delay(500);

  // Переключаемся на iframe
  const iframeElement = await page.$("#addbasket");
  const iframe = await iframeElement.contentFrame();

  // Ждём загрузки содержимого iframe
  await iframe.waitForSelector("#tonns", { state: "visible" });
  await delay(500);

  // Определяем куда вводить количество
  if (unit === "м" || unit === "шт") {
    // Проверяем доступно ли поле метров
    const metersType = await iframe
      .$eval("#meters", (el) => el.type)
      .catch(() => "hidden");
    console.log("Тип поля метров:", metersType);

    if (metersType !== "hidden") {
      // Вводим в метры
      await iframe.click("#meters", { clickCount: 3 });
      await delay(200);
      await iframe.type("#meters", String(quantity), { delay: 100 });
    } else {
      // Метры скрыты — вводим в тонны
      logger.warn("Поле метров скрыто — вводим в тонны", { quantity });
      await iframe.click("#tonns", { clickCount: 3 });
      await delay(200);
      await iframe.type("#tonns", String(quantity), { delay: 100 });
    }
  } else {
    // Тонны или кг
    await iframe.click("#tonns", { clickCount: 3 });
    await delay(200);
    await iframe.type("#tonns", String(quantity), { delay: 100 });
  }

  // Ждём пересчёта суммы
  await delay(1500);

  // Читаем сообщения об ошибках из iframe
  const errorMessage = await iframe
    .$eval("p.error", (el) => el.innerText.trim())
    .catch(() => null);
  if (errorMessage) {
    logger.warn("Предупреждение при добавлении в корзину", {
      название: variant.название,
      сообщение: errorMessage,
    });
    // Возвращаем предупреждение — не падаем, просто сообщаем
    throw new Error(`WARNING:${variant.название}|${errorMessage}`);
  }

  // Нажимаем кнопку — "Добавить в корзину" или "Обновить в корзине"
  await iframe.evaluate(() => {
    const buttons = document.querySelectorAll("button");
    const btn = Array.from(buttons).find(
      (b) =>
        b.textContent.trim().toLowerCase().includes("добавить в корзину") ||
        b.textContent.trim().toLowerCase().includes("обновить в корзине"),
    );
    if (btn) btn.click();
  });

  await delay(1000);
  logger.info("Добавлено в корзину", {
    название: variant.название,
    смц: variant.смц,
  });
}

module.exports = { addToCart };
