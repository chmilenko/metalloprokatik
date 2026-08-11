/**
 * search.js
 *
 * Поиск позиции на mc.ru.
 * Два режима: глобальный поиск и поиск по URL категории.
 */

const logger = require("../utils/logger");
const { getPage } = require("./browser");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Проверяет, что "слово" входит в "текст" как ЦЕЛОЕ слово
function естьЦелоеСлово(текст, слово) {
  const idx = текст.indexOf(слово);
  if (idx === -1) return false;
  const before = текст[idx - 1];
  const after = текст[idx + слово.length];
  const этоБуква = (ch) => !!ch && /[a-zа-яё]/i.test(ch);
  return !этоБуква(before) && !этоБуква(after);
}

// Компактное представление варианта для логов
function краткоДляЛога(v) {
  return {
    название: v.название,
    размер: v.размер || null,
    марка: v.марка || null,
    длина: v.длина || null,
    смц: v.смц,
    цена_от_1т: v.цена_от_1т,
  };
}

// Группы эквивалентных обозначений марок стали
const MARK_GROUPS = [
  {
    canon: "3",
    patterns: [
      /^ст ?1-3/,
      /^ст ?3(?!\d)/,
      /^с ?3(?!\d)/,
      /^3(пс|сп)?$/,
      /^с ?255/,
      /^с ?245/,
    ],
  },
  { canon: "08", patterns: [/^ст ?08/, /^08(пс|сп)?$/] },
  { canon: "a3", patterns: [/^а ?3$/, /^а ?400/, /^а ?500/] },
  { canon: "a1", patterns: [/^а ?1$/, /^а ?240/] },
  { canon: "nl3", patterns: [/^09г2с/, /^с ?345/, /^с ?355/] },
];

function нормализуйМарку(марка) {
  const базовая = (марка || "").toLowerCase().replace(/\s+/g, " ").trim();
  for (const группа of MARK_GROUPS) {
    if (группа.patterns.some((p) => p.test(базовая))) {
      return группа.canon;
    }
  }
  return базовая.replace(/ст/g, "").replace(/\s/g, "").trim();
}

// Паттерны URL для листов
const CATEGORY_URLS = {
  "лист г/к": (толщина) =>
    `https://mc.ru/metalloprokat/stal_listovaya_g_k/r1/${толщина}`,
  "лист х/к": (толщина) =>
    `https://mc.ru/metalloprokat/stal_listovaya_h_k/r1/${толщина}`,
  "лист рифленый": (толщина) =>
    `https://mc.ru/metalloprokat/list_riflenyj/r1/${толщина}`,
};

function этоЛистКатегории(текст, тип) {
  if (!естьЦелоеСлово(текст, "лист")) return false;
  if (тип === "г/к") {
    return (
      текст.includes("г/к") ||
      естьЦелоеСлово(текст, "горячекатаный") ||
      естьЦелоеСлово(текст, "горячекатаная") ||
      естьЦелоеСлово(текст, "горячекатанный")
    );
  }
  if (тип === "х/к") {
    return (
      текст.includes("х/к") ||
      естьЦелоеСлово(текст, "холоднокатаный") ||
      естьЦелоеСлово(текст, "холоднокатаная")
    );
  }
  return текст.includes("рифлен");
}

// Паттерны URL для сортового проката
const SHAPE_CATEGORY_URLS = {
  швеллер: (номер) => `https://mc.ru/metalloprokat/shveller_katan/r1/${номер}`,
  квадрат: (номер) =>
    `https://mc.ru/metalloprokat/kvadrat_goryachekatanyj/r1/${номер}`,
  полоса: (ширина) => `https://mc.ru/metalloprokat/polosa_g_k/r1/${ширина}`,
};

function extractShapeNumber(текст, ключ) {
  const регулярка = new RegExp(`${ключ}[^0-9]*([\\d.]+)`, "i");
  const match = текст.match(регулярка);
  return match ? match[1] : null;
}

// Паттерны URL для арматуры
const ARMATURE_CATEGORY_URLS = {
  a3: (диаметр) =>
    `https://mc.ru/metalloprokat/armatura_riflenaya_a3/r1/${диаметр}`,
  a1: (диаметр) =>
    `https://mc.ru/metalloprokat/armatura_gladkaya_a1/r1/${диаметр}`,
};

const КРУГ_CATEGORY_URL = (диаметр) =>
  `https://mc.ru/metalloprokat/krug_g_k/r1/${диаметр}`;

const BALKA_CATEGORY_URLS = {
  3: (номер) => `https://mc.ru/metalloprokat/balki_dvutavrovye/r1/${номер}`,
  nl3: (номер) =>
    `https://mc.ru/metalloprokat/balki_dvutavrovye_nizkolegirovannye/r1/${номер}`,
};

function определиФормуБалки(текст) {
  if (естьЦелоеСлово(текст, "балка")) return "балка";
  if (естьЦелоеСлово(текст, "двутавр")) return "балка";
  return null;
}

// ============================================================
// ГЛАВНАЯ ФУНКЦИЯ — ОПРЕДЕЛЕНИЕ URL КАТЕГОРИИ
// ============================================================

function getCategoryUrl(position) {
  const название = (position.название || "").toLowerCase();
  const запрос = (position.поисковый_запрос || "").toLowerCase();
  const текст = `${запрос} ${название}`;
  const толщина = position.параметры?.толщина;
  const диаметр = position.параметры?.диаметр;

  // Листы
  if (толщина) {
    for (const [ключ, urlFn] of Object.entries(CATEGORY_URLS)) {
      const тип = ключ.replace("лист ", "");
      const совпадает =
        этоЛистКатегории(название, тип) || этоЛистКатегории(запрос, тип);
      if (совпадает) return urlFn(толщина);
    }
  }

  // Арматура
  const этоАрматура =
    название.includes("арматура") || запрос.includes("арматура");
  if (этоАрматура && диаметр) {
    const класс = нормализуйМарку(position.параметры?.марка);
    const urlFn = ARMATURE_CATEGORY_URLS[класс];
    if (urlFn) return urlFn(диаметр);
  }

  // Круг
  const этоКруг =
    (естьЦелоеСлово(название, "круг") || естьЦелоеСлово(запрос, "круг")) &&
    !этоАрматура;
  if (этоКруг) {
    const диаметрКруга =
      диаметр ||
      extractShapeNumber(
        естьЦелоеСлово(запрос, "круг") ? запрос : название,
        "круг",
      );
    if (диаметрКруга) return КРУГ_CATEGORY_URL(диаметрКруга);
  }

  // Балка
  const формаБалкиЗапроса = определиФормуБалки(запрос);
  const формаБалкиНазвания = определиФормуБалки(название);
  if (формаБалкиЗапроса || формаБалкиНазвания) {
    let номерБалки = position.параметры?.номер || null;
    if (!номерБалки) {
      const источникБалки = формаБалкиНазвания ? название : запрос;
      const ключевоеСлово = естьЦелоеСлово(источникБалки, "балка")
        ? "балка"
        : "двутавр";
      номерБалки = extractShapeNumber(источникБалки, ключевоеСлово);
    }
    if (номерБалки) {
      let классБалки = нормализуйМарку(position.параметры?.марка);
      if (классБалки !== "3" && классБалки !== "nl3") {
        const весьТекст = `${запрос} ${название}`;
        классБалки = /низколегир|09г2с|с ?345|с ?355/i.test(весьТекст)
          ? "nl3"
          : "3";
      }
      const urlFn = BALKA_CATEGORY_URLS[классБалки];
      if (urlFn) return urlFn(номерБалки);
    }
  }

  // Сортовой прокат (швеллер, квадрат, полоса)
  for (const [ключ, urlFn] of Object.entries(SHAPE_CATEGORY_URLS)) {
    const источник = естьЦелоеСлово(запрос, ключ)
      ? запрос
      : естьЦелоеСлово(название, ключ)
      ? название
      : null;
    if (!источник) continue;

    let параметр;
    if (ключ === "полоса") {
      параметр = position.параметры?.ширина || extractShapeNumber(источник, ключ);
    } else {
      параметр = position.параметры?.номер || extractShapeNumber(источник, ключ);
    }
    if (параметр) return urlFn(параметр);
  }

  return null;
}

// ============================================================
// ПОИСК
// ============================================================

async function searchPosition(query, position = {}) {
  const page = await getPage();
  const categoryUrl = getCategoryUrl(position);

  if (categoryUrl) {
    logger.info("Ищем по URL категории", { url: categoryUrl });
    const result = await searchByUrl(categoryUrl, position, page);
    if (result.found) return result;
    logger.warn("По URL категории не найдено — пробуем глобальный поиск", {
      query,
      url: categoryUrl,
    });
    return await searchByGlobal(query, position, page);
  }

  logger.info("Ищем позицию", { query });
  return await searchByGlobal(query, position, page);
}

// ============================================================
// СКРАПИНГ ТАБЛИЦЫ
// ============================================================

async function scrapeTableRows(page) {
  return await page.$$eval("table tbody tr", (rows) => {
    function parsePrice(text) {
      if (!text) return null;
      const match = text.match(/[\d\s]+/);
      if (!match) return null;
      return parseInt(match[0].replace(/\s/g, ""), 10);
    }

    return rows
      .map((row) => {
        const cells = row.querySelectorAll("td");
        const заКг = /за\s*кг|руб\s*\/\s*кг|\/\s*кг\b/i.test(
          row.innerText || "",
        );
        return {
          название: cells[0]?.innerText?.trim(),
          размер: cells[1]?.innerText?.trim(),
          марка: cells[2]?.innerText?.trim(),
          длина: cells[3]?.innerText?.trim(),
          смц: cells[4]?.innerText?.trim(),
          остаток: cells[5]?.innerText?.trim(),
          цена_от_1т: parsePrice(cells[8]?.innerText),
          цена_от_5т: parsePrice(cells[9]?.innerText),
          цена_от_10т: parsePrice(cells[10]?.innerText),
          заКг,
        };
      })
      .filter((row) => row.название && row.цена_от_1т);
  });
}

// ============================================================
// ПАГИНАЦИЯ
// ============================================================

async function getPaginationLinks(page) {
  const hrefs = await page.evaluate(() => {
    const links = Array.from(
      document.querySelectorAll(".catalogPaginator ul li a[href]"),
    );
    return links.map((a) => a.getAttribute("href")).filter(Boolean);
  });
  return Array.from(
    new Set(hrefs.map((href) => new URL(href, "https://mc.ru").toString())),
  );
}

// ============================================================
// ПОИСК ПО URL КАТЕГОРИИ
// ============================================================

async function searchByUrl(url, position, page) {
  const MAX_PAGES = 10;
  let allRows = [];
  const visited = new Set([url]);
  const queue = [url];
  let i = 0;

  while (i < queue.length && i < MAX_PAGES) {
    const currentUrl = queue[i];

    await page.goto(currentUrl);
    await page.waitForLoadState("domcontentloaded");
    await delay(1500);

    const tableExists = await page.$("table tbody tr").catch(() => null);
    if (!tableExists) {
      if (i === 0) {
        logger.warn("Таблица не найдена по URL", { url });
        return { found: false, query: url };
      }
      i++;
      continue;
    }

    const rows = await scrapeTableRows(page);
    allRows.push(...rows);

    // ✅ СНАЧАЛА ФИЛЬТРУЕМ
    const filtered = filterVariants(rows, position);

    // ✅ ПОТОМ ОБОГАЩАЕМ ТОЛЬКО ПРОШЕДШИХ
    for (const variant of filtered) {
      try {
        const rowsWithVariant = await page.$$("tr");
        let targetRow = null;
        for (const row of rowsWithVariant) {
          const nameCell = await row.$("td.TovName");
          if (nameCell) {
            const text = await nameCell.textContent();
            if (text && text.trim() === variant.название) {
              targetRow = row;
              break;
            }
          }
        }
        if (!targetRow) continue;

        const titleLink = await targetRow.$("td.TovName a");
        if (!titleLink) continue;

        // Открываем карточку в новой вкладке
        const [newPage] = await Promise.all([
          page.context().waitForEvent("page"),
          titleLink.click({ button: "middle" }),
        ]);

        await newPage.waitForLoadState("domcontentloaded");
        await delay(1500);

        let allBases = [];

        // 🔥 СПОСОБ 1: Таблица с базами (круг, балка)
        const baseRows = await newPage.$$("table#tab_main1 tbody tr");
        for (const row of baseRows) {
          const baseName = await row.getAttribute("data-base");
          if (baseName) {
            // ✅ ПРОВЕРЯЕМ НАЛИЧИЕ КНОПКИ КОРЗИНЫ (НЕ ТЕЛЕФОНА)
            const hasBasket = await row.$(
              'button.catIcon._basket._bas, button._basket'
            );
            if (hasBasket) {
              allBases.push(baseName);
            }
          }
        }

        // 🔥 СПОСОБ 2: Список баз (полоса, квадрат)
        if (allBases.length === 0) {
          const baseItems = await newPage.$$("ul.packs li.ipacks");
          for (const item of baseItems) {
            const text = await item.textContent();
            if (text) {
              // проверяем, что элемент не заблокирован и не disabled
              const isDisabled = await item.evaluate(
                (el) =>
                  el.classList.contains("disabled") ||
                  el.hasAttribute("disabled")
              );
              if (!isDisabled) {
                allBases.push(text.trim());
              }
            }
          }
        }

        // 🔥 СПОСОБ 3: Блок "Отгрузка"
        if (allBases.length === 0) {
          const baseElements = await newPage.$$(
            ".base-item, .warehouse-item, .stock-item"
          );
          for (const el of baseElements) {
            const text = await el.textContent();
            if (text) {
              const isDisabled = await el.evaluate(
                (node) =>
                  node.classList.contains("disabled") ||
                  node.hasAttribute("disabled")
              );
              if (!isDisabled) {
                const cleanBase = text.trim();
                if (cleanBase && !allBases.includes(cleanBase)) {
                  allBases.push(cleanBase);
                }
              }
            }
          }
        }

        // ✅ УНИКАЛЬНЫЕ БАЗЫ
        if (allBases.length > 0) {
          const uniqueBases = [...new Set(allBases)];
          variant.смц = uniqueBases.join(", ");
          variant._allBases = uniqueBases;
          logger.info("Обогащён базами из карточки", {
            название: variant.название,
            базы: uniqueBases,
          });
        }

        await newPage.close();
      } catch (e) {
        logger.warn("Не удалось обогатить базами", {
          название: variant.название,
          error: e.message,
        });
      }
    }

    logger.info("Страница обработана", {
      url: currentUrl,
      page: i + 1,
      count: rows.length,
      filtered: filtered.length,
      варианты: filtered.map(краткоДляЛога),
      ...(filtered.length === 0 && rows.length > 0
        ? { сэмплДоФильтрации: rows.slice(0, 5).map(краткоДляЛога) }
        : {}),
    });

    if (filtered.length > 0) {
      const withSourceUrl = filtered.map((v) => ({
        ...v,
        sourceUrl: currentUrl,
      }));
      return {
        found: true,
        query: url,
        variants: withSourceUrl,
        rawRows: rows,
      };
    }

    const paginationLinks = await getPaginationLinks(page);
    for (const link of paginationLinks) {
      if (!visited.has(link)) {
        visited.add(link);
        queue.push(link);
      }
    }

    i++;
  }

  const filteredAll = filterVariants(allRows, position);
  const filteredAllWithSourceUrl = filteredAll.map((v) => ({
    ...v,
    sourceUrl: url,
  }));

  logger.info("После перебора всех страниц", {
    url,
    totalPages: queue.length,
    totalRows: allRows.length,
    filtered: filteredAll.length,
  });

  return {
    found: filteredAllWithSourceUrl.length > 0,
    query: url,
    variants: filteredAllWithSourceUrl,
    rawRows: allRows,
  };
}

// ============================================================
// ГЛОБАЛЬНЫЙ ПОИСК
// ============================================================

async function searchByGlobal(query, position, page) {
  await page.goto("https://mc.ru");
  await page.waitForLoadState("domcontentloaded");
  await delay(500);

  await page.evaluate(() => {
    document.querySelector("#searchField").click();
  });
  await delay(300);

  await page.waitForSelector('input[name="referal"]', { state: "visible" });
  await page.fill('input[name="referal"]', query);
  await delay(300);

  await page.press('input[name="referal"]', "Enter");
  await page.waitForLoadState("domcontentloaded");
  await delay(2000);

  const notFound = await page.$("text=Наименование не найдено в каталоге");
  if (notFound) {
    logger.warn("Позиция не найдена", { query });
    return { found: false, query };
  }

  const tableExists = await page.$("table tbody tr").catch(() => null);
  if (!tableExists) {
    logger.warn("Таблица не найдена", { query });
    return { found: false, query };
  }

  const rows = await scrapeTableRows(page);

  console.log("Найденные строки до фильтрации:");
  rows.slice(0, 3).forEach((r) =>
    console.log(r.название, "|", r.марка, "|", r.смц)
  );

  logger.info("Найдено вариантов", { query, count: rows.length });

  const filtered = filterVariants(rows, position);
  const resultsPageUrl = page.url();
  const filteredWithSourceUrl = filtered.map((v) => ({
    ...v,
    sourceUrl: resultsPageUrl,
  }));

  logger.info("Найдено вариантов после фильтрации", {
    query,
    total: rows.length,
    filtered: filteredWithSourceUrl.length,
    варианты: filteredWithSourceUrl.map(краткоДляЛога),
    ...(filteredWithSourceUrl.length === 0 && rows.length > 0
      ? { сэмплДоФильтрации: rows.slice(0, 5).map(краткоДляЛога) }
      : {}),
  });

  return {
    found: filteredWithSourceUrl.length > 0,
    query,
    variants: filteredWithSourceUrl,
    rawRows: rows,
  };
}

// ============================================================
// ФИЛЬТРАЦИЯ
// ============================================================

function оцениВариант(v, position, контекст) {
  const {
    запросНижний,
    названиеПозиции,
    маркаПозиции,
    нужнаНержавейка,
    нужнаНизколег,
    нуженМоток,
    нуженАлюминий,
    нуженКалиброванный,
  } = контекст;

  const название = v.название.toLowerCase().replace(/\s+/g, " ");
  const маркаВарианта = (v.марка || "").toLowerCase();

  if (v.заКг)
    return { ok: false, причина: "цена указана за кг, а не за тонну" };

  const этоАлюминий =
    название.includes("алюмини") ||
    маркаВарианта.includes("амг") ||
    маркаВарианта.includes("ад31") ||
    маркаВарианта.includes("д16") ||
    маркаВарианта.includes("в95");
  if (этоАлюминий && !нуженАлюминий)
    return { ok: false, причина: "алюминий, а не сталь" };

  const этоКалиброванный =
    название.includes("калиброван") || название.includes("холоднотянут");
  if (этоКалиброванный && !нуженКалиброванный) {
    return {
      ok: false,
      причина: "калиброванная/холоднотянутая сталь — другая товарная категория",
    };
  }

  const этоНержавейка =
    название.includes("нержавеющ") ||
    название.includes("aisi") ||
    название.includes("нерж");
  if (этоНержавейка && !нужнаНержавейка)
    return { ok: false, причина: "нержавеющая сталь не запрошена" };

  const этоНизколег = название.includes("низколегир");
  if (этоНизколег && !нужнаНизколег)
    return { ok: false, причина: "низколегированная сталь не запрошена" };

  const этоМоток =
    название.includes("моток") ||
    название.includes("мотк") ||
    название.includes("бухт");
  if (этоМоток && !нуженМоток)
    return { ok: false, причина: "моток/бухта, а не прямой пруток" };

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
    if (этоФитинг)
      return {
        ok: false,
        причина: "соединительная деталь (фитинг), а не труба",
      };
  }

  const нуженТУ = запросНижний.includes(" ту ") || запросНижний.includes("ту ");
  const этоТУ =
    маркаВарианта.startsWith("ту ") ||
    маркаВарианта.startsWith("ту38") ||
    маркаВарианта.startsWith("ту-");
  if (этоТУ && !нуженТУ)
    return {
      ok: false,
      причина: "ТУ-спецификация вместо ГОСТ (риск нулевого остатка)",
    };

  if (маркаПозиции) {
    const маркаНорм = нормализуйМарку(маркаПозиции);
    const этоКлассАрматуры = маркаНорм === "a3" || маркаНорм === "a1";

    if (!этоКлассАрматуры) {
      if (маркаВарианта) {
        const маркаВарНорм = нормализуйМарку(маркаВарианта);
        const маркиСовпадают =
          маркаВарНорм === маркаНорм ||
          маркаВарНорм.startsWith(`${маркаНорм}-`);
        if (!маркиСовпадают) {
          return {
            ok: false,
            причина: `марка не совпадает (запрошено "${маркаПозиции}", тут "${v.марка}")`,
          };
        }
      } else {
        const группа = MARK_GROUPS.find((г) => г.canon === маркаНорм);
        let найдено;
        if (группа) {
          найдено = группа.patterns.some((p) => {
            const source = p.source.replace(/^\^/, "").replace(/\$$/, "");
            const токенРегулярка = new RegExp(`(^|[^a-zа-я0-9])${source}`, "i");
            return токенРегулярка.test(название);
          });
        } else {
          const токенРегулярка = new RegExp(
            `(^|[^a-zа-я0-9])${маркаНорм}([^a-zа-я0-9]|$)`,
            "i"
          );
          найдено = токенРегулярка.test(название);
        }
        if (!найдено)
          return {
            ok: false,
            причина: `марка "${маркаПозиции}" не найдена в названии`,
          };
      }
    }
  }

  const ФОРМЫ_ПРОКАТА = [
    "швеллер",
    "уголок",
    "балка",
    "круг",
    "катанка",
    "квадрат",
    "полоса",
  ];
  const СИНОНИМЫ_ФОРМ = { двутавр: "балка" };

  function определиФорму(текст) {
    for (const ф of ФОРМЫ_ПРОКАТА) {
      if (естьЦелоеСлово(текст, ф)) return ф;
    }
    for (const [синоним, форма] of Object.entries(СИНОНИМЫ_ФОРМ)) {
      if (естьЦелоеСлово(текст, синоним)) return форма;
    }
    return null;
  }

  const формаЗапроса = определиФорму(запросНижний);
  const формаПозиции = определиФорму(названиеПозиции);
  const форма = формаЗапроса || формаПозиции;

  if (форма) {
    if (!естьЦелоеСлово(название, форма)) {
      return { ok: false, причина: `не та форма проката (нужен "${форма}")` };
    }

    if (форма === "полоса" && position.параметры?.толщина) {
      const нужнаяТолщина = String(position.параметры.толщина);
      if (
        !название.includes(`х${нужнаяТолщина}`) &&
        !название.includes(`x${нужнаяТолщина}`)
      ) {
        return {
          ok: false,
          причина: `толщина полосы не совпадает (нужна ${нужнаяТолщина})`,
        };
      }
    }

    const источникНомера =
      форма === "балка"
        ? формаПозиции
          ? названиеПозиции
          : запросНижний
        : формаЗапроса
        ? запросНижний
        : названиеПозиции;
    const очищенный = источникНомера
      .replace(
        /швеллер|уголок|балка|круг|полоса|катанка|квадрат|двутавр|низколегир[а-я]*/g,
        ""
      )
      .trim();

    const числоМатч = очищенный.match(/(\d+(?:[.,]\d+)?)\s*([а-я]\d{0,2})?/i);
    const номерБезБуквы =
      position.параметры?.номер != null
        ? String(position.параметры.номер)
        : числоМатч
        ? числоМатч[1]
        : null;
    const буква = ((числоМатч && числоМатч[2]) || "").trim();

    if (номерБезБуквы) {
      const регулярка = new RegExp(
        `(^|\\s|\\()${номерБезБуквы}(\\s|[а-я]|$|\\))`,
        "i"
      );
      const номерВНазвании = регулярка.test(название);
      const номерВРазмере =
        v.размер != null &&
        String(v.размер).trim().replace(/\s+/g, "") === номерБезБуквы;
      if (!номерВНазвании && !номерВРазмере) {
        return {
          ok: false,
          причина: `номер профиля не совпадает (нужен ${номерБезБуквы})`,
        };
      }

      if (буква) {
        if (
          !название.includes(` ${буква}`) &&
          !название.includes(`${номерБезБуквы}${буква}`)
        ) {
          return {
            ok: false,
            причина: `серия/буква не совпадает (нужна "${буква}")`,
          };
        }
      }
    }
  }

  if (position.параметры?.ду) {
    if (!название.includes(`${position.параметры.ду}`)) {
      return {
        ok: false,
        причина: `ДУ не совпадает (нужен ${position.параметры.ду})`,
      };
    }
  }

  if (position.параметры?.диаметр) {
    if (!название.includes(`${position.параметры.диаметр}`)) {
      return {
        ok: false,
        причина: `диаметр не совпадает (нужен ${position.параметры.диаметр})`,
      };
    }
  }

  if (position.параметры?.стенка) {
    const стенкаЭск = String(position.параметры.стенка).replace(".", "\\.");
    const стенкаРегулярка = new RegExp(`[x×хX]${стенкаЭск}(?!\\d|\\.)`);
    const стенкаВНазвании =
      стенкаРегулярка.test(название) ||
      название.includes(`*${position.параметры.стенка}`);
    const стенкаВМарке = v.марка === String(position.параметры.стенка);
    if (!стенкаВНазвании && !стенкаВМарке) {
      return {
        ok: false,
        причина: `стенка не совпадает (нужна ${position.параметры.стенка})`,
      };
    }
  }

  // Толщина — ТОЛЬКО для листов
  if (position.параметры?.толщина) {
    const этоЛист =
      естьЦелоеСлово(название, "лист") ||
      естьЦелоеСлово(запросНижний, "лист");
    if (этоЛист) {
      const толщина = String(position.параметры.толщина).replace(".", "\\.");
      const регулярка = new RegExp(`(^|\\s|[^\\d.])${толщина}(х|x)`);
      if (!регулярка.test(название)) {
        return {
          ok: false,
          причина: `толщина листа не совпадает (нужна ${position.параметры.толщина})`,
        };
      }
    }
  }

  if (position.параметры?.ширина) {
    const ширинаСтр = String(position.параметры.ширина);
    const этоПолоса =
      естьЦелоеСлово(название, "полоса") ||
      естьЦелоеСлово(запросНижний, "полоса");

    if (этоПолоса) {
      const найдено =
        название.includes(`${ширинаСтр}х`) ||
        название.includes(`${ширинаСтр}x`) ||
        название.includes(` ${ширинаСтр} `) ||
        название.startsWith(`${ширинаСтр}х`);
      if (!найдено) {
        return {
          ok: false,
          причина: `ширина полосы не совпадает (нужна ${ширинаСтр})`,
        };
      }
    } else {
      if (!название.includes(ширинаСтр)) {
        return {
          ok: false,
          причина: `ширина не совпадает (нужна ${ширинаСтр})`,
        };
      }
    }
  }

  if (position.параметры?.длина_листа) {
    if (!название.includes(`${position.параметры.длина_листа}`)) {
      return {
        ok: false,
        причина: `длина листа не совпадает (нужна ${position.параметры.длина_листа})`,
      };
    }
  }

  // Фильтр по длине прута/стержня (в мм)
  if (position.параметры?.длина) {
    const нужнаяДлина = Number(position.параметры.длина);
    const длинаВарианта = parseInt(String(v.длина || "").replace(/\D/g, ""), 10);
    if (!Number.isNaN(длинаВарианта) && длинаВарианта !== нужнаяДлина) {
      return {
        ok: false,
        причина: `длина не совпадает (нужна ${нужнаяДлина}, тут ${длинаВарианта})`,
      };
    }
  }

  return { ok: true };
}

function подготовьКонтекст(position) {
  const запросНижний = (position.поисковый_запрос || "").toLowerCase();
  const названиеПозиции = (position.название || "").toLowerCase();
  const маркаПозиции = (position.параметры?.марка || "").toLowerCase();

  return {
    запросНижний,
    названиеПозиции,
    маркаПозиции,
    нужнаНержавейка:
      запросНижний.includes("нержавеющ") ||
      запросНижний.includes("aisi") ||
      запросНижний.includes("нерж"),
    нужнаНизколег:
      запросНижний.includes("низколегир") ||
      маркаПозиции.includes("09г2с") ||
      маркаПозиции.includes("с355"),
    нуженМоток:
      запросНижний.includes("моток") ||
      запросНижний.includes("мотк") ||
      запросНижний.includes("бухт"),
    нуженАлюминий:
      запросНижний.includes("алюмини") ||
      названиеПозиции.includes("алюмини") ||
      маркаПозиции.includes("амг") ||
      маркаПозиции.includes("ад31") ||
      маркаПозиции.includes("д16") ||
      маркаПозиции.includes("в95"),
    нуженКалиброванный:
      запросНижний.includes("калиброван") ||
      запросНижний.includes("холоднотянут") ||
      названиеПозиции.includes("калиброван") ||
      названиеПозиции.includes("холоднотянут"),
  };
}

function filterVariants(variants, position) {
  const контекст = подготовьКонтекст(position);
  return variants.filter((v) => оцениВариант(v, position, контекст).ok);
}

function оцениВсеВарианты(variants, position) {
  const контекст = подготовьКонтекст(position);
  return variants.map((v) => {
    const { ok, причина } = оцениВариант(v, position, контекст);
    return { вариант: v, прошёл: ok, причина: причина || null };
  });
}

module.exports = { searchPosition, оцениВсеВарианты, нормализуйМарку };