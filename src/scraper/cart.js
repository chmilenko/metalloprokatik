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

  if (variant.sourceUrl) {
    // Вариант уже был найден на конкретной странице (категория или
    // результаты поиска) — переходим сразу туда. Это надёжнее повторного
    // поиска с нуля: на разных страницах СМЦ может форматироваться
    // по-разному (склады объединяются в одну ячейку по-разному), из-за
    // чего повторный поиск не находил строку с тем же СМЦ буквально.
    await page.goto(variant.sourceUrl);
    await page.waitForLoadState("domcontentloaded");
    await delay(1000);
  } else {
    // Старое поведение — ищем заново через строку поиска (для вариантов
    // без sourceUrl, на случай обратной совместимости)
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
  }

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
    // Марка — критично сверять и её: у сортового проката (круг, квадрат
    // и т.п.) разные марки стали одного диаметра часто имеют ИДЕНТИЧНЫЕ
    // название и СМЦ (например Ст35/Ст20/Ст45 круг 40мм — все "горячекатаный
    // круг из конструкционной сортовой стали 40" на одной базе Карачарово).
    // Без сверки марки код мог кликнуть на первую попавшуюся строку с
    // совпадающими название+смц — не обязательно ту, что реально выбрана.
    const марка = await row
      .$eval("td:nth-child(3)", (el) => el.innerText.trim())
      .catch(() => "");

    const маркаСовпадает = !variant.марка || марка === variant.марка;

    if (смц === variant.смц && название === variant.название && маркаСовпадает) {
      targetRow = row;
      break;
    }
  }

  if (!targetRow) {
    throw new Error(
      `Не нашли строку: ${variant.название} (марка: ${variant.марка || "любая"}) на базе ${variant.смц}`,
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

  // Читаем сообщения об ошибках из iframe. Не полагаемся только на
  // конкретный селектор p.error — предупреждение о нехватке на складе
  // может рендериться другой разметкой. Дополнительно сканируем весь текст
  // модалки на характерные фразы.
  const errorMessage = await iframe
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

  // Сообщение вида "Максимальный объём заказа: 9 т. Количество уменьшено
  // до 9 т" — НЕ блокирующая ошибка, а уведомление: сайт сам скорректировал
  // количество и готов добавить товар в меньшем объёме. В этом случае
  // нужно продолжать (кликать "Добавить в корзину"), а не прерываться —
  // но обязательно передать текст наверх, чтобы менеджер его увидел.
  const этоКорректировкаКоличества = errorMessage &&
    /уменьшен|скорректирован|максимальный объём заказа/i.test(errorMessage);

  if (errorMessage && !этоКорректировкаКоличества) {
    logger.warn("Предупреждение при добавлении в корзину", {
      название: variant.название,
      сообщение: errorMessage,
    });
    // Блокирующая ошибка — не падаем молча, просто сообщаем и прерываем
    throw new Error(`WARNING:${variant.название}|${errorMessage}`);
  }

  if (этоКорректировкаКоличества) {
    logger.warn("Количество скорректировано сайтом — продолжаем добавление", {
      название: variant.название,
      сообщение: errorMessage,
    });
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

  // Раньше здесь была проверка "модалка должна закрыться в течение 5с,
  // иначе считаем что не добавилось" — убрал её: она давала ложные
  // срабатывания (репортила NOT_ADDED даже когда товар реально попадал
  // в корзину), т.к. предположение о видимости #addbasket после успеха
  // оказалось неверным. Раз ошибки уже отлавливаются через p.error выше —
  // после клика просто ждём и считаем успехом.
  await delay(1000);

  logger.info("Добавлено в корзину", {
    название: variant.название,
    смц: variant.смц,
    ...(этоКорректировкаКоличества ? { скорректировано: errorMessage } : {}),
  });

  // Возвращаем информацию о том, было ли количество скорректировано сайтом —
  // вызывающий код (processOrder) может использовать это, чтобы показать
  // менеджеру точный текст предупреждения вместо молчаливого "успеха"
  return {
    adjusted: !!этоКорректировкаКоличества,
    adjustmentMessage: этоКорректировкаКоличества ? errorMessage : null,
  };
}

module.exports = { addToCart };