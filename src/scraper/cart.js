/**
 * cart.js
 *
 * Работа с корзиной на mc.ru.
 * Добавляет позиции в корзину.
 */

const logger = require("../utils/logger");
const { getPage } = require("./browser");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function addToCart(variant, quantity, unit = "т") {
  const page = await getPage();

  const целеваяБаза = variant.recommendedBase || null;
  const известныеБазы = variant._allBases || [];

  logger.info("Добавляем в корзину", {
    название: variant.название,
    смц: variant.смц,
    целеваяБаза,
    известныеБазы: известныеБазы.length,
    количество: quantity,
    единица: unit,
  });

  // ============================================================
  // 1. ПЕРЕХОД НА СТРАНИЦУ С ТОВАРОМ
  // ============================================================

  if (variant.sourceUrl) {
    await page.goto(variant.sourceUrl);
    await page.waitForLoadState("domcontentloaded");
    await delay(1000);
  } else {
    await page.goto("https://mc.ru");
    await page.waitForLoadState("domcontentloaded");
    await delay(1000);

    await page.evaluate(() => {
      document.querySelector("#searchField").click();
    });
    await delay(300);

    await page.waitForSelector('input[name="referal"]', { state: "visible" });
    await page.fill('input[name="referal"]', variant.поисковый_запрос);
    await delay(300);

    await page.press('input[name="referal"]', "Enter");
    await page.waitForLoadState("domcontentloaded");
    await delay(2000);
  }

  // ============================================================
  // 2. ПОИСК СТРОКИ В ТАБЛИЦЕ
  // ============================================================

  await page.waitForSelector("table tbody tr", {
    state: "visible",
    timeout: 10000,
  });
  await delay(500);

  const rows = await page.$$("table tbody tr");
  let targetRow = null;
  let смцТаблицы = null;

  for (const row of rows) {
    const hasButton = await row.$("button._basket, button._phone").catch(() => null);
    if (!hasButton) continue;

    const название = await row
      .$eval("td.TovName", (el) => el.innerText.trim())
      .catch(() =>
        row.$eval("td:nth-child(1)", (el) => el.innerText.trim()).catch(() => "")
      );
    const марка = await row
      .$eval("td:nth-child(3)", (el) => el.innerText.trim())
      .catch(() => "");
    const смц = await row
      .$eval("td._fact", (el) => el.innerText.trim())
      .catch(() =>
        row.$eval("td:nth-child(5)", (el) => el.innerText.trim()).catch(() => "")
      );

    const маркаСовпадает = !variant.марка || марка === variant.марка;
    if (название === variant.название && маркаСовпадает) {
      // Если в СМЦ несколько баз через запятую — проваливаемся в карточку
      if (смц && смц.includes(',')) {
        logger.info("В таблице несколько баз, проваливаемся в карточку", { смц });
        return await добавитьЧерезКарточку(page, variant, quantity, unit);
      }

      if (целеваяБаза) {
        if (смц && смц.includes(целеваяБаза)) {
          targetRow = row;
          смцТаблицы = смц;
          break;
        }
      } else if (известныеБазы.length > 0) {
        for (const база of известныеБазы) {
          if (смц && смц.includes(база)) {
            targetRow = row;
            смцТаблицы = смц;
            break;
          }
        }
        if (targetRow) break;
      } else {
        targetRow = row;
        смцТаблицы = смц;
        break;
      }
    }
  }

  // ============================================================
  // 3. ЕСЛИ СТРОКА НЕ НАЙДЕНА — ПРОВАЛ В КАРТОЧКУ
  // ============================================================

  if (!targetRow) {
    logger.info("Строка не найдена, провал в карточку", {
      название: variant.название,
      целеваяБаза,
    });
    return await добавитьЧерезКарточку(page, variant, quantity, unit);
  }

  // ============================================================
  // 4. ДОБАВЛЯЕМ ЧЕРЕЗ ТАБЛИЦУ
  // ============================================================

  logger.info("Строка найдена, добавляем через таблицу", {
    название: variant.название,
    целеваяБаза,
    смц: смцТаблицы,
  });

  const basketBtn = await targetRow.$("button._basket");
  if (!basketBtn) {
    logger.warn("Нет кнопки корзины в таблице, пробуем провал в карточку");
    return await добавитьЧерезКарточку(page, variant, quantity, unit);
  }

  await basketBtn.scrollIntoViewIfNeeded();
  await delay(300);
  await page.evaluate((btn) => {
    btn.click();
  }, basketBtn);
  await delay(1000);

  // Ждём модалку
  try {
    await page.waitForSelector("#addbasket", { state: "visible", timeout: 5000 });
  } catch (e) {
    logger.info("Модалка не появилась, возможно товар уже в корзине");
    return { adjusted: false, adjustmentMessage: null };
  }
  await delay(500);

  const iframeElement = await page.$("#addbasket");
  if (!iframeElement) {
    logger.warn("Не нашли iframe #addbasket");
    return { adjusted: false, adjustmentMessage: null };
  }

  const iframe = await iframeElement.contentFrame();
  if (!iframe) {
    logger.warn("Не удалось получить contentFrame");
    return { adjusted: false, adjustmentMessage: null };
  }

  try {
    await iframe.waitForSelector("#tonns", { state: "visible", timeout: 5000 });
  } catch (e) {
    logger.warn("Не нашли #tonns в iframe");
    return { adjusted: false, adjustmentMessage: null };
  }
  await delay(500);

  await ввестиКоличество(iframe, quantity, unit);

  const errorMessage = await проверитьОшибки(iframe);
  const этоКорректировкаКоличества = errorMessage &&
    /уменьшен|скорректирован|максимальный объём заказа/i.test(errorMessage);

  if (errorMessage && !этоКорректировкаКоличества) {
    logger.warn("Предупреждение при добавлении в корзину", {
      название: variant.название,
      сообщение: errorMessage,
    });
    throw new Error(`WARNING:${variant.название}|${errorMessage}`);
  }

  if (этоКорректировкаКоличества) {
    logger.warn("Количество скорректировано сайтом", {
      название: variant.название,
      сообщение: errorMessage,
    });
  }

  await нажатьКнопкуВМодалке(iframe);

  await delay(1000);

  logger.info("Добавлено в корзину (через таблицу)", {
    название: variant.название,
    смц: variant.смц,
    ...(этоКорректировкаКоличества ? { скорректировано: errorMessage } : {}),
  });

  return {
    adjusted: !!этоКорректировкаКоличества,
    adjustmentMessage: этоКорректировкаКоличества ? errorMessage : null,
  };
}

// ============================================================
// ДОБАВЛЕНИЕ ЧЕРЕЗ КАРТОЧКУ
// ============================================================

async function добавитьЧерезКарточку(page, variant, quantity, unit) {
  logger.info("Добавляем через карточку", {
    название: variant.название,
    целеваяБаза: variant.recommendedBase,
  });

  // Находим строку
  const rows = await page.$$("table tbody tr");
  let targetRow = null;

  for (const row of rows) {
    const hasButton = await row.$("button._basket, button._phone").catch(() => null);
    if (!hasButton) continue;

    const название = await row
      .$eval("td.TovName", (el) => el.innerText.trim())
      .catch(() =>
        row.$eval("td:nth-child(1)", (el) => el.innerText.trim()).catch(() => "")
      );
    const марка = await row
      .$eval("td:nth-child(3)", (el) => el.innerText.trim())
      .catch(() => "");

    const маркаСовпадает = !variant.марка || марка === variant.марка;
    if (название === variant.название && маркаСовпадает) {
      targetRow = row;
      break;
    }
  }

  if (!targetRow) {
    throw new Error(`Не нашли строку для провала в карточку: ${variant.название}`);
  }

  // Переходим в карточку
  const titleLink = await targetRow.$("td.TovName a");
  if (!titleLink) {
    const titleTd = await targetRow.$("td.TovName");
    if (titleTd) {
      await titleTd.click();
    } else {
      throw new Error(`Не нашли ссылку на карточку товара: ${variant.название}`);
    }
  } else {
    await titleLink.click();
  }

  await page.waitForLoadState("domcontentloaded");
  await delay(1500);

  // ============================================================
  // ВЫБОР БАЗЫ (ПРОСТОЙ СПОСОБ)
  // ============================================================

  const целеваяБаза = variant.recommendedBase || null;
  if (целеваяБаза) {
    // Просто выбираем базу из списка или таблицы
    await выбратьБазуНаКарточке(page, целеваяБаза);
    await delay(500);
  }

  // ============================================================
  // НАЖИМАЕМ КНОПКУ "ДОБАВИТЬ В КОРЗИНУ"
  // ============================================================

  let basketBtn = await page.$('button.catIcon.in._basket, button._basket');

  if (!basketBtn) {
    basketBtn = await page.$('button[id*="_basket"]');
  }

  if (!basketBtn) {
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const text = await btn.textContent().catch(() => "");
      if (text && (text.includes("Добавить в корзину") || text.includes("В корзину"))) {
        basketBtn = btn;
        break;
      }
    }
  }

  if (!basketBtn) {
    const screenshotPath = `error_btn_${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath });
    logger.error("Кнопка не найдена", { screenshot: screenshotPath });
    throw new Error(`Не нашли кнопку корзины: ${variant.название}`);
  }

  logger.info("Кнопка найдена", {
    id: await basketBtn.getAttribute('id'),
    classes: await basketBtn.getAttribute('class'),
  });

  await page.evaluate((btn) => {
    btn.style.display = 'block';
    btn.style.visibility = 'visible';
    btn.style.opacity = '1';
    btn.style.position = 'relative';
    btn.style.zIndex = '9999';
    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => {
      btn.click();
    }, 300);
  }, basketBtn);

  await delay(1000);

  // Ждём модалку
  try {
    await page.waitForSelector("#addbasket", { state: "visible", timeout: 5000 });
  } catch (e) {
    logger.info("Модалка не появилась, возможно товар уже в корзине");
    return { adjusted: false, adjustmentMessage: null };
  }
  await delay(500);

  const iframeElement = await page.$("#addbasket");
  if (!iframeElement) {
    logger.warn("Не нашли iframe #addbasket");
    return { adjusted: false, adjustmentMessage: null };
  }

  const iframe = await iframeElement.contentFrame();
  if (!iframe) {
    logger.warn("Не удалось получить contentFrame");
    return { adjusted: false, adjustmentMessage: null };
  }

  try {
    await iframe.waitForSelector("#tonns", { state: "visible", timeout: 5000 });
  } catch (e) {
    logger.warn("Не нашли #tonns в iframe");
    return { adjusted: false, adjustmentMessage: null };
  }
  await delay(500);

  await ввестиКоличество(iframe, quantity, unit);

  const errorMessage = await проверитьОшибки(iframe);
  const этоКорректировкаКоличества = errorMessage &&
    /уменьшен|скорректирован|максимальный объём заказа/i.test(errorMessage);

  if (errorMessage && !этоКорректировкаКоличества) {
    logger.warn("Предупреждение при добавлении в корзину", {
      название: variant.название,
      сообщение: errorMessage,
    });
    throw new Error(`WARNING:${variant.название}|${errorMessage}`);
  }

  if (этоКорректировкаКоличества) {
    logger.warn("Количество скорректировано сайтом", {
      название: variant.название,
      сообщение: errorMessage,
    });
  }

  await нажатьКнопкуВМодалке(iframe);

  await delay(1000);

  logger.info("Добавлено в корзину (через карточку)", {
    название: variant.название,
    смц: variant.смц,
    ...(этоКорректировкаКоличества ? { скорректировано: errorMessage } : {}),
  });

  return {
    adjusted: !!этоКорректировкаКоличества,
    adjustmentMessage: этоКорректировкаКоличества ? errorMessage : null,
  };
}

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

async function ввестиКоличество(iframe, quantity, unit) {
  if (unit === "м" || unit === "шт") {
    const metersType = await iframe.$eval("#meters", (el) => el.type).catch(() => "hidden");
    if (metersType !== "hidden") {
      await iframe.click("#meters", { clickCount: 3 });
      await delay(200);
      await iframe.type("#meters", String(quantity), { delay: 100 });
    } else {
      logger.warn("Поле метров скрыто — вводим в тонны", { quantity });
      await iframe.click("#tonns", { clickCount: 3 });
      await delay(200);
      await iframe.type("#tonns", String(quantity), { delay: 100 });
    }
  } else {
    await iframe.click("#tonns", { clickCount: 3 });
    await delay(200);
    await iframe.type("#tonns", String(quantity), { delay: 100 });
  }
  await delay(1500);
}

async function проверитьОшибки(iframe) {
  return await iframe
    .evaluate(() => {
      const specific = document.querySelector("p.error");
      if (specific && specific.innerText.trim()) {
        return specific.innerText.trim();
      }
      const bodyText = document.body.innerText || "";
      const patterns = [
        /недостаточно[^\n]*/i,
        /максимально доступно[^\n]*/i,
        /нет в наличии[^\n]*/i,
        /невозможно добавить[^\n]*/i,
        /остаток[^\n]*меньше[^\n]*/i,
        /превышает[^\n]*остаток[^\n]*/i,
      ];
      for (const p of patterns) {
        const match = bodyText.match(p);
        if (match) return match[0].trim();
      }
      return null;
    })
    .catch(() => null);
}

async function нажатьКнопкуВМодалке(iframe) {
  await iframe.evaluate(() => {
    const buttons = document.querySelectorAll("button");
    const btn = Array.from(buttons).find(
      (b) =>
        b.textContent.trim().toLowerCase().includes("добавить в корзину") ||
        b.textContent.trim().toLowerCase().includes("обновить в корзине"),
    );
    if (btn) btn.click();
  });
}

async function выбратьБазуНаКарточке(page, целеваяБаза) {
  logger.info("Выбираем базу на карточке", { целеваяБаза });

  let baseFound = false;

  // Способ 1: Список баз (полоса, квадрат)
  const baseItems = await page.$$('ul.packs li.ipacks');
  for (const item of baseItems) {
    const text = await item.textContent();
    if (text && text.trim() === целеваяБаза) {
      await item.click();
      baseFound = true;
      logger.info("Выбрана база через список", { база: целеваяБаза });
      await delay(500);
      break;
    }
  }

  // Способ 2: Таблица с базами (круг, балка, лист)
  if (!baseFound) {
    const baseRows = await page.$$('table#tab_main1 tbody tr');
    for (const row of baseRows) {
      const baseName = await row.getAttribute('data-base');
      if (baseName && baseName === целеваяБаза) {
        // Пробуем кликнуть на первую ячейку
        const firstCell = await row.$('td:first-child');
        if (firstCell) {
          await firstCell.click();
          baseFound = true;
          logger.info("Выбрана база через ячейку таблицы", { база: целеваяБаза });
          await delay(500);
          break;
        }
        // Запасной вариант — клик на строку
        await row.click();
        baseFound = true;
        logger.info("Выбрана база через строку таблицы", { база: целеваяБаза });
        await delay(500);
        break;
      }
    }
  }

  // Способ 3: Блок "Отгрузка"
  if (!baseFound) {
    const baseElements = await page.$$('.base-item, .warehouse-item, .stock-item');
    for (const el of baseElements) {
      const text = await el.textContent();
      if (text && text.trim() === целеваяБаза) {
        await el.click();
        baseFound = true;
        logger.info("Выбрана база через элемент", { база: целеваяБаза });
        await delay(500);
        break;
      }
    }
  }

  if (!baseFound) {
    logger.warn("Не найдена база в карточке", { целеваяБаза });
  }
}

module.exports = { addToCart };