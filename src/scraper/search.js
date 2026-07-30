/**
 * search.js
 *
 * Поиск позиции на mc.ru.
 * Вводит поисковый запрос → возвращает список найденных вариантов с ценами.
 */

const logger = require("../utils/logger");
const { getPage } = require("./browser");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function searchPosition(query, position = {}) {
  const page = await getPage();

  logger.info("Ищем позицию", { query });

  // Возвращаемся на главную перед каждым поиском
  await page.goto("https://mc.ru");
  await page.waitForLoadState("domcontentloaded");
  await delay(500);

  // Открываем поиск
  await page.evaluate(() => {
    document.querySelector("#searchField").click();
  });
  await delay(300);

  // Вводим запрос
  await page.waitForSelector('input[name="referal"]', { state: "visible" });
  await page.fill('input[name="referal"]', query);
  await delay(300);

  // Нажимаем Enter
  await page.press('input[name="referal"]', "Enter");
  await page.waitForLoadState("domcontentloaded");
  await delay(2000);

  // Проверяем нашлось ли что-то
  const notFound = await page.$("text=Наименование не найдено в каталоге");
  if (notFound) {
    logger.warn("Позиция не найдена", { query });
    return { found: false, query };
  }

  // Проверяем есть ли таблица
  const tableExists = await page.$("table tbody tr").catch(() => null);
  if (!tableExists) {
    logger.warn("Таблица не найдена", { query });
    return { found: false, query };
  }

  // Парсим таблицу результатов
  const rows = await page.$$eval("table tbody tr", (rows) => {
    function parsePrice(text) {
      if (!text) return null;
      const match = text.match(/[\d\s]+/);
      if (!match) return null;
      return parseInt(match[0].replace(/\s/g, ""), 10);
    }

    return rows
      .map((row) => {
        const cells = row.querySelectorAll("td");
        return {
          название: cells[0]?.innerText?.trim(),
          марка: cells[2]?.innerText?.trim(),
          длина: cells[3]?.innerText?.trim(),
          смц: cells[4]?.innerText?.trim(),
          остаток: cells[5]?.innerText?.trim(),
          цена_от_1т: parsePrice(cells[8]?.innerText),
          цена_от_5т: parsePrice(cells[9]?.innerText),
          цена_от_10т: parsePrice(cells[10]?.innerText),
        };
      })
      .filter((row) => row.название && row.цена_от_1т);
  });

  console.log("Найденные строки до фильтрации:");
  rows
    .slice(0, 3)
    .forEach((r) => console.log(r.название, "|", r.марка, "|", r.смц));

  logger.info("Найдено вариантов", { query, count: rows.length });

  const filtered = filterVariants(rows, position);

  logger.info("Найдено вариантов после фильтрации", {
    query,
    total: rows.length,
    filtered: filtered.length,
  });

  return { found: filtered.length > 0, query, variants: filtered };
}

function filterVariants(variants, position) {
  const запросНижний = (position.поисковый_запрос || "").toLowerCase();
  const названиеПозиции = (position.название || "").toLowerCase();
  const маркаПозиции = (position.параметры?.марка || "").toLowerCase();

  const нужнаНержавейка =
    запросНижний.includes("нержавеющ") ||
    запросНижний.includes("aisi") ||
    запросНижний.includes("нерж");
  const нужнаНизколег =
    запросНижний.includes("низколегир") ||
    маркаПозиции.includes("09г2с") ||
    маркаПозиции.includes("с355");

  return variants.filter((v) => {
    const название = v.название.toLowerCase();
    const маркаВарианта = (v.марка || "").toLowerCase();

    // Убираем нержавейку если не нужна
    const этоНержавейка =
      название.includes("нержавеющ") ||
      название.includes("aisi") ||
      название.includes("нерж");
    if (этоНержавейка && !нужнаНержавейка) return false;

    // Убираем низколегированные если не нужны
    const этоНизколег = название.includes("низколегир");
    if (этоНизколег && !нужнаНизколег) return false;

    // Убираем соединительные детали и фитинги если ищем трубы
    const искомТрубу =
      запросНижний.includes("труб") ||
      запросНижний.includes("эсв") ||
      названиеПозиции.includes("труб");
    if (искомТрубу) {
      const этоФитинг =
        название.includes("тройник") ||
        название.includes("соединительные детали") ||
        название.includes("фитинг") ||
        название.includes("муфта") ||
        название.includes("переход") ||
        название.includes("патрубок") ||
        название.includes("отвод");
      if (этоФитинг) return false;
    }

    // Фильтр по марке стали если указана
    if (маркаПозиции) {
      // Нормализуем марку для сравнения
      const маркаНорм = маркаПозиции
        .replace("ст", "ст")
        .replace("с255", "с255")
        .trim();

      // Проверяем марку в названии или в отдельной колонке марки
      const маркаВНазвании = название.includes(маркаНорм);
      const маркаВКолонке =
        маркаВарианта.includes(маркаНорм) ||
        маркаВарианта.replace("ст", "").trim() ===
          маркаНорм.replace("ст", "").trim();

      if (!маркаВНазвании && !маркаВКолонке) return false;
    }

    // Фильтр для сортового проката по номеру
    if (
      запросНижний.includes("швеллер") ||
      запросНижний.includes("уголок") ||
      запросНижний.includes("балка") ||
      запросНижний.includes("круг") ||
      запросНижний.includes("полоса") ||
      запросНижний.includes("катанка")
    ) {
      const номерЗапроса = запросНижний
        .replace(
          /швеллер|уголок|балка|круг|полоса|катанка|низколегированный/g,
          "",
        )
        .trim();

      if (номерЗапроса) {
        const номерБезБуквы = номерЗапроса.replace(/[пу]/g, "").trim();
        const буква = номерЗапроса.replace(/[^пу]/g, "").trim();

        const регулярка = new RegExp(
          `(^|\\s|\\()${номерБезБуквы}(\\s|п|у|х|x|$|\\))`,
        );
        if (!регулярка.test(название)) return false;

        if (буква) {
          if (
            !название.includes(` ${буква}`) &&
            !название.includes(`${номерБезБуквы}${буква}`)
          )
            return false;
        }
      }

      return true;
    }

    // Фильтр по ДУ
    if (position.параметры?.ду) {
      if (!название.includes(`${position.параметры.ду}`)) return false;
    }

    // Фильтр по диаметру
    if (position.параметры?.диаметр) {
      if (!название.includes(`${position.параметры.диаметр}`)) return false;
    }

    // Фильтр по стенке — ТОЧНОЕ совпадение
    if (position.параметры?.стенка) {
      const стенка = String(position.параметры.стенка);
      const стенкаВНазвании =
        название.includes(`x${стенка}`) ||
        название.includes(`х${стенка}`) ||
        название.includes(`*${стенка}`);
      // Проверяем точное совпадение марки со стенкой
      const стенкаВМарке = v.марка === стенка;
      if (!стенкаВНазвании && !стенкаВМарке) return false;
    }

    // Фильтр по толщине листа
    if (position.параметры?.толщина) {
      const толщина = String(position.параметры.толщина);
      // Проверяем что толщина стоит в начале или после пробела/буквы
      // но не является частью большего числа (например 16 не должно совпадать с 6)
      const регулярка = new RegExp(`(^|\\s|[^\\d])${толщина}(х|x)`);
      if (!регулярка.test(название)) return false;
    }

    if (position.параметры?.ширина) {
      if (!название.includes(`${position.параметры.ширина}`)) return false;
    }

    if (position.параметры?.длина_листа) {
      if (!название.includes(`${position.параметры.длина_листа}`)) return false;
    }

    return true;
  });
}

module.exports = { searchPosition };
