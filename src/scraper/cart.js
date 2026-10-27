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
  // 0. ПРЯМОЙ ПЕРЕХОД К КАРТОЧКЕ
  // ============================================================
  // Если база выбрана, добавление всё равно идёт через карточку, а её адрес мы запомнили
  // при поиске (variant.cardUrl). Тогда страницу категории не открываем вовсе: это
  // экономит ~3 с на позицию. Не вышло — идём прежним путём через категорию.
  // Отключить: ПРЯМОЙ_ПЕРЕХОД_К_КАРТОЧКЕ=off в .env.
  if (целеваяБаза && variant.cardUrl && process.env.ПРЯМОЙ_ПЕРЕХОД_К_КАРТОЧКЕ !== "off") {
    let карточкаОткрыта = false;
    try {
      await page.goto(variant.cardUrl);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForSelector(
        'table#tab_main1 tbody tr, ul.packs li.ipacks, button[id^="btn_"]',
        { timeout: 8000 },
      );
      await delay(700);

      // ПРОВЕРКА, что это та самая карточка: марка и длина строки выбранной базы должны
      // совпасть с вариантом (круг Ст45 и круг 20Х — разные карточки с одним названием).
      // Не сошлось — открываем товар прежним путём через страницу категории.
      const сверка = await page.evaluate((база) => {
        const строки = Array.from(document.querySelectorAll("table#tab_main1 tbody tr"));
        const r = strings_find(строки, база);
        function strings_find(список, имя) {
          return список.find((x) => (x.getAttribute("data-base") || "").trim() === имя) || null;
        }
        return r
          ? { марка: (r.getAttribute("data-mark") || "").trim(), длина: (r.getAttribute("data-len") || "").trim() }
          : null;
      }, целеваяБаза);
      if (сверка) {
        const маркаНе = variant.марка && сверка.марка && сверка.марка !== String(variant.марка).trim();
        const длинаНе = variant.длина && сверка.длина && сверка.длина !== String(variant.длина).trim();
        if (маркаНе || длинаНе) {
          throw new Error(
            `карточка не совпала: марка «${сверка.марка}» / длина «${сверка.длина}», ждали «${variant.марка || ""}» / «${variant.длина || ""}»`,
          );
        }
      }

      карточкаОткрыта = true;
      logger.info("Карточка открыта напрямую (без страницы категории)", {
        название: variant.название,
        целеваяБаза,
        проверенаПоМаркеДлине: !!сверка,
      });
    } catch (e) {
      logger.warn("Прямой переход к карточке не удался — иду через страницу категории", {
        название: variant.название,
        error: String(e.message || e).split("\n")[0],
      });
    }
    if (карточкаОткрыта) {
      // ошибки самого добавления (WARNING: …) пробрасываем как есть — повторять через категорию нельзя
      return await продолжитьНаКарточке(page, variant, quantity, unit);
    }
  }

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

  // ФИКС: если менеджер выбрал базу — добавляем ТОЛЬКО через карточку с
  // явным выбором этой базы. Добавление из строки таблицы базу не
  // гарантирует: труба, добавленная из строки «Очаково», в корзине
  // оказалась на другой базе («Подольск») и после выбора базы Балашиха
  // стала неактивной; та же труба, добавленная через карточку с выбором
  // Балашихи, была в порядке (проверено вручную на сайте).
  if (целеваяБаза) {
    logger.info("Задана база — добавляем через карточку с явным выбором базы", {
      название: variant.название,
      целеваяБаза,
    });
    return await добавитьЧерезКарточку(page, variant, quantity, unit);
  }

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
    // ФИКС: сверяем и длину (4-я колонка таблицы, как в search.js). Раньше
    // выбиралась ПЕРВАЯ строка с тем же названием и маркой — например
    // «Швеллер 12 П С255 12000» вместо нужной «С255 6000», хотя это разные
    // товары с разными базами и ценой.
    const длинаСтроки = await row
      .$eval("td:nth-child(4)", (el) => el.innerText.trim())
      .catch(() => "");
    const длинаСовпадает =
      !variant.длина || !длинаСтроки || длинаСтроки === String(variant.длина).trim();
    if (название === variant.название && маркаСовпадает && длинаСовпадает) {
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
  await delay(300); // клик по кнопке отложен на 300 мс; дальше ждём модалку по селектору

  // Ждём модалку
  try {
    await page.waitForSelector("#addbasket", { state: "visible", timeout: 5000 });
  } catch (e) {
    logger.info("Модалка не появилась, возможно товар уже в корзине");
    throw new Error(`WARNING:${variant.название}|после нажатия кнопки корзины окно количества не появилось`);
  }
  await delay(250);

  const iframeElement = await page.$("#addbasket");
  if (!iframeElement) {
    logger.warn("Не нашли iframe #addbasket");
    throw new Error(`WARNING:${variant.название}|окно количества не открылось`);
  }

  const iframe = await iframeElement.contentFrame();
  if (!iframe) {
    logger.warn("Не удалось получить contentFrame");
    throw new Error(`WARNING:${variant.название}|окно количества не открылось`);
  }

  try {
    await iframe.waitForSelector("#tonns", { state: "visible", timeout: 5000 });
  } catch (e) {
    logger.warn("Не нашли #tonns в iframe");
    const текст = await iframe.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200)).catch(() => '');
    throw new Error(`WARNING:${variant.название}|в окне нет поля количества (сайт показал сообщение)${текст ? ': ' + текст : ''}`);
  }
  await delay(250);

  await ввестиКоличество(iframe, quantity, unit, variant);

  const инфоСообщение = await прочитатьИнформацию(iframe);
  if (инфоСообщение) {
    logger.info("Информационное сообщение сайта (не блокирует)", {
      название: variant.название,
      сообщение: инфоСообщение,
    });
  }

  const errorMessageСайта = await проверитьОшибки(iframe);
  // Страховка: сайт мог молча изменить количество (лимит и т.п.) без понятного сообщения —
  // сверяем то, что осталось в поле, с тем, что вводили.
  const расхождение = await проверитьВведённое(iframe, quantity, unit);
  const errorMessage = errorMessageСайта || расхождение;
  const этоКорректировкаКоличества = errorMessage &&
    (расхождение || /уменьшен|скорректирован|максимальный объём заказа/i.test(errorMessage));

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
    infoMessage: инфоСообщение || null,
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
    const длинаСтроки = await row
      .$eval("td:nth-child(4)", (el) => el.innerText.trim())
      .catch(() => "");
    const длинаСовпадает =
      !variant.длина || !длинаСтроки || длинаСтроки === String(variant.длина).trim();
    if (название === variant.название && маркаСовпадает && длинаСовпадает) {
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

  return await продолжитьНаКарточке(page, variant, quantity, unit);
}

/**
 * Дальше мы УЖЕ на странице карточки товара: выбираем базу, нажимаем «в корзину»,
 * вводим количество. Сюда попадаем либо кликом по названию на странице категории,
 * либо прямым переходом по адресу карточки (variant.cardUrl).
 */
async function продолжитьНаКарточке(page, variant, quantity, unit) {
  // ============================================================
  // ВЫБОР БАЗЫ (ПРОСТОЙ СПОСОБ)
  // ============================================================

  const целеваяБаза = variant.recommendedBase || null;
  let базаНеВыбрана = false;
  if (целеваяБаза) {
    // Просто выбираем базу из списка или таблицы
    const выбрана = await выбратьБазуНаКарточке(page, целеваяБаза);
    базаНеВыбрана = !выбрана;
    await delay(500);
  }

  // ============================================================
  // НАЖИМАЕМ КНОПКУ "ДОБАВИТЬ В КОРЗИНУ"
  // ============================================================

  // На карточке несколько кнопок «в корзину» — по одной на базу (id вида btn_<товар>_<код базы>,
  // например ..._3 Карачарово, ..._4 Очаково, ..._H7 Коровино). Раньше бралась первая в DOM,
  // поэтому в корзину попадала не та база. Берём кнопку именно выбранной базы.
  let basketBtn = null;
  if (целеваяБаза) {
    try {
      const р = await найтиКнопкуДляБазы(page, целеваяБаза);
      logger.info("Кнопки корзины на карточке", { целеваяБаза, выбрана: р.id, способ: р.способ, кнопки: р.кнопки, атрибутыСтроки: р.атрибутыСтроки });
      if (р.id) basketBtn = await page.$(`[id="${р.id}"]`);
    } catch (e) {
      logger.warn("Не удалось подобрать кнопку под базу", { error: e.message });
    }
  }
  if (!basketBtn) basketBtn = await page.$('button.catIcon.in._basket, button._basket');

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

  await delay(300); // клик по кнопке отложен на 300 мс; дальше ждём модалку по селектору

  // Ждём модалку
  try {
    await page.waitForSelector("#addbasket", { state: "visible", timeout: 5000 });
  } catch (e) {
    logger.info("Модалка не появилась, возможно товар уже в корзине");
    throw new Error(`WARNING:${variant.название}|после нажатия кнопки корзины окно количества не появилось`);
  }
  await delay(250);

  const iframeElement = await page.$("#addbasket");
  if (!iframeElement) {
    logger.warn("Не нашли iframe #addbasket");
    throw new Error(`WARNING:${variant.название}|окно количества не открылось`);
  }

  const iframe = await iframeElement.contentFrame();
  if (!iframe) {
    logger.warn("Не удалось получить contentFrame");
    throw new Error(`WARNING:${variant.название}|окно количества не открылось`);
  }

  try {
    await iframe.waitForSelector("#tonns", { state: "visible", timeout: 5000 });
  } catch (e) {
    logger.warn("Не нашли #tonns в iframe");
    const текст = await iframe.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200)).catch(() => '');
    throw new Error(`WARNING:${variant.название}|в окне нет поля количества (сайт показал сообщение)${текст ? ': ' + текст : ''}`);
  }
  await delay(250);

  await ввестиКоличество(iframe, quantity, unit, variant);

  const инфоСообщение = await прочитатьИнформацию(iframe);
  if (инфоСообщение) {
    logger.info("Информационное сообщение сайта (не блокирует)", {
      название: variant.название,
      сообщение: инфоСообщение,
    });
  }

  const errorMessageСайта = await проверитьОшибки(iframe);
  // Страховка: сайт мог молча изменить количество (лимит и т.п.) без понятного сообщения —
  // сверяем то, что осталось в поле, с тем, что вводили.
  const расхождение = await проверитьВведённое(iframe, quantity, unit);
  const errorMessage = errorMessageСайта || расхождение;
  const этоКорректировкаКоличества = errorMessage &&
    (расхождение || /уменьшен|скорректирован|максимальный объём заказа/i.test(errorMessage));

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
    infoMessage: инфоСообщение || null,
    baseNotSelected: базаНеВыбрана,
  };
}

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

/**
 * После ввода читаем значение поля обратно. Для т — #tonns, для м/шт при видимом поле метров — #meters.
 * Если значение отличается от введённого больше чем на 25% — сообщаем (иначе в корзине тихо окажется
 * другое количество, как было с «150 кг» → 20).
 */
async function проверитьВведённое(iframe, quantity, unit) {
  try {
    const поле = unit === "м" || unit === "шт" ? "#meters" : "#tonns";
    const данные = await iframe.$eval(поле, (el) => ({ тип: el.type, значение: el.value }));
    if (данные.тип === "hidden") return null;
    const факт = parseFloat(String(данные.значение).replace(",", "."));
    const хотели = Number(quantity);
    if (!Number.isFinite(факт) || !(хотели > 0)) return null;
    if (Math.abs(факт - хотели) / хотели > 0.25) {
      return `сайт изменил количество: вводили ${хотели} ${unit}, в поле осталось ${факт}`;
    }
  } catch (e) {
    // не критично
  }
  return null;
}

async function ввестиКоличество(iframe, quantity, unit, variant = {}) {
  if (unit === "м" || unit === "шт") {
    const metersType = await iframe.$eval("#meters", (el) => el.type).catch(() => "hidden");
    if (metersType !== "hidden") {
      await iframe.click("#meters", { clickCount: 3 });
      await delay(200);
      await iframe.type("#meters", String(quantity), { delay: 40 });
    } else {
      // Поля метров на карточке нет (например катанка в мотках) — можно вводить
      // только тонны. ВАЖНО: метры в поле тонн вводить НЕЛЬЗЯ (78 м превратились бы
      // в 78 т). Тонны берём из расчёта по весу метра (считает /order заранее).
      const тонны = Number(variant && variant._тоннЭквивалент);
      if (!(тонны > 0)) {
        throw new Error(
          `WARNING:${variant && variant.название}|на карточке нет поля метров, а перевести ${quantity} ${unit} в тонны не удалось — ` +
            `укажите эту позицию в тоннах`
        );
      }
      logger.warn("Поле метров скрыто — вводим пересчитанные тонны", { запрошено: `${quantity} ${unit}`, тонны });
      await iframe.click("#tonns", { clickCount: 3 });
      await delay(200);
      await iframe.type("#tonns", String(тонны), { delay: 40 });
    }
  } else {
    await iframe.click("#tonns", { clickCount: 3 });
    await delay(200);
    await iframe.type("#tonns", String(quantity), { delay: 40 });
  }
  await delay(1500);
}

/**
 * Информационные сообщения модалки (не ошибки): p.infometers,
 * span.inputinfo и фразы про погрешность из p.error. Возвращает текст
 * или null. Добавление в корзину они не останавливают — только
 * показываются менеджеру.
 */
async function прочитатьИнформацию(iframe) {
  return await iframe
    .evaluate(() => {
      const чисто = (el) => (el.innerText || "").replace(/\s+/g, " ").trim();
      const тексты = [
        ...document.querySelectorAll("p.infometers, span.inputinfo"),
        ...[...document.querySelectorAll("p.error")].filter((el) => /погрешност/i.test(чисто(el))),
      ]
        .map(чисто)
        .filter(Boolean);
      return тексты.length > 0 ? [...new Set(тексты)].join(" ") : null;
    })
    .catch(() => null);
}

async function проверитьОшибки(iframe) {
  return await iframe
    .evaluate(() => {
      // Ошибки/ограничения mc.ru — в <p class="error"> (например «Максимальный
      // объём заказа: 20 т. Количество уменьшено до 20 т»). Информационные
      // строки («* Количество метров указано с погрешностью согласно
      // ГОСТу», блоки p.infometers / span.inputinfo) ошибкой НЕ считаются —
      // их читает прочитатьИнформацию и они не останавливают добавление.
      const этоИнформация = (t) => /погрешност/i.test(t);
      const ошибки = [...document.querySelectorAll("p.error")]
        .map((el) => (el.innerText || "").replace(/\s+/g, " ").trim())
        .filter((t) => t && !этоИнформация(t));
      if (ошибки.length > 0) {
        return [...new Set(ошибки)].join(" ");
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


const КОДЫ_БАЗ = { 'Карачарово': '3', 'Очаково': '4', 'Коровино': 'H7', 'Балашиха': '3O' };

async function найтиКнопкуДляБазы(page, база) {
  return await page.evaluate(({ база, коды }) => {
    const кнопки = Array.from(document.querySelectorAll('button[id^="btn_"], button._basket'));
    const инфо = кнопки.map((b) => ({ id: b.id, видима: b.getClientRects().length > 0 }));
    const строки = Array.from(document.querySelectorAll('table#tab_main1 tbody tr'));
    const строка = строки.find((r) => (r.getAttribute('data-base') || '').trim() === база);
    const атрибуты = строка ? Array.from(строка.attributes).map((a) => `${a.name}=${a.value}`) : null;
    const ответ = (btn, способ) => ({ id: btn ? btn.id : null, способ, кнопки: инфо, атрибутыСтроки: атрибуты });

    // 1. кнопка внутри строки выбранной базы
    if (строка) {
      const b = строка.querySelector('button[id^="btn_"], button._basket');
      if (b) return ответ(b, 'в строке базы');
      // 2. код базы из атрибутов строки = суффикс id кнопки
      for (const a of Array.from(строка.attributes)) {
        const код = (a.value || '').trim();
        if (код && код.length <= 3) {
          const m = кнопки.find((b) => b.id.endsWith('_' + код));
          if (m) return ответ(m, 'по коду из атрибутов строки');
        }
      }
    }
    // 3. известный код базы
    const код = коды[база];
    if (код) {
      const m = кнопки.find((b) => b.id.endsWith('_' + код));
      if (m) return ответ(m, 'по известному коду базы');
    }
    // 4. единственная видимая кнопка
    const видимые = кнопки.filter((b) => b.getClientRects().length > 0);
    if (видимые.length === 1) return ответ(видимые[0], 'единственная видимая');
    return ответ(null, 'не найдена');
  }, { база, коды: КОДЫ_БАЗ });
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

  return baseFound;
}

module.exports = { addToCart };