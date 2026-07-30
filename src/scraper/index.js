const { authorize } = require("./auth");
const { searchPosition } = require("./search");
const { addToCart } = require("./cart");
const { placeOrder, clearCart, screenshotCart } = require("./order");
const { getPage } = require("./browser");
const { askAI } = require("../agent/llm");
const { saveMapping } = require("../agent/searchMapManager");
const logger = require("../utils/logger");
const { saveOrder, logOrder } = require("../utils/orderLogger");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPosition(position, onProgress) {
  let result = await searchPosition(position.поисковый_запрос, position);
  if (result.found) return { result, usedQuery: position.поисковый_запрос };

  await onProgress(
    `⚠️ Не нашёл по запросу "${position.поисковый_запрос}". Пробую альтернативы...`,
  );

  const alternativesRaw = await askAI(`
Запрос "${position.поисковый_запрос}" не нашёл результатов на сайте металлопроката mc.ru.
Позиция: ${position.название}

Предложи 3 альтернативных коротких поисковых запроса для поиска на сайте.
Верни ТОЛЬКО JSON массив строк без markdown.
Пример: ["трубы х/д", "труба холоднодеформированная", "х/д"]
`);

  let alternatives = [];
  try {
    const clean = alternativesRaw.replace(/```json|```/g, "").trim();
    alternatives = JSON.parse(clean);
  } catch {
    alternatives = [];
  }

  for (const alt of alternatives) {
    await onProgress(`🔄 Пробую запрос: "${alt}"...`);
    result = await searchPosition(alt, position);
    if (result.found) {
      // НЕ сохраняем автоматически — только через подтверждение менеджера
      // saveMapping(position.поисковый_запрос, alt)
      await onProgress(`✅ Нашёл по запросу "${alt}"`);
      return { result, usedQuery: alt };
    }
  }

  return { result: { found: false }, usedQuery: null, needsHelp: true };
}

async function processOrder(positions, onProgress, onNeedHelp, order) {
  await authorize();

  const startTime = Date.now();
  const found = [];
  const notFound = [];
  const needHelp = [];

  // Фаза 1 — поиск всех позиций
  for (let i = 0; i < positions.length; i++) {
    const position = positions[i];
    await onProgress(
      `🔍 Ищу ${i + 1}/${positions.length}: ${position.название}...`,
    );

    const searchLog = {
      название: position.название,
      запрос: position.поисковый_запрос,
      до_фильтрации: 0,
      после_фильтрации: 0,
      альтернативы: [],
      выбран: null,
      статус: "не найдено",
    };

    try {
      const { result, usedQuery, needsHelp } = await findPosition(
        position,
        onProgress,
      );

      if (needsHelp) {
        needHelp.push(position);
        searchLog.статус = "нужна помощь";
        await onNeedHelp(position);
      } else if (!result.found) {
        notFound.push(position);
        searchLog.статус = "не найдено";
        await onProgress(`❌ Не найдено: ${position.название}`);
      } else {
        found.push({ position, variants: result.variants, usedQuery });
        searchLog.статус = "найдено";
        searchLog.после_фильтрации = result.variants.length;
        await onProgress(
          `✅ ${position.название} — найдено ${result.variants.length} вариантов`,
        );
      }
    } catch (err) {
      notFound.push(position);
      searchLog.статус = "ошибка";
      searchLog.ошибка = err.message;
    }

    order.поиск.push(searchLog);
    saveOrder(order);

    if (i < positions.length - 1) {
      await delay(Math.random() * 2000 + 1500);
    }
  }

  if (found.length === 0) {
    order.итог.статус = "не найдено ничего";
    order.итог.время_обработки_сек = Math.round(
      (Date.now() - startTime) / 1000,
    );
    saveOrder(order);
    logOrder(order);

    // Не бросаем исключение — возвращаем пустой результат
    return {
      cartScreenshot: null,
      selection: [],
      notFound,
      needHelp,
      bases: [],
      order,
    };
  }

  // Фаза 2 — выбираем лучшую цену
  await onProgress("💰 Выбираю лучшие цены...");
  const selection = found.map((r) => {
    const best = r.variants.reduce((min, v) =>
      v.цена_от_1т < min.цена_от_1т ? v : min,
    );

    const searchLog = order.поиск.find(
      (s) => s.название === r.position.название,
    );
    if (searchLog) {
      searchLog.выбран = {
        название: best.название,
        смц: best.смц,
        цена: best.цена_от_1т,
      };
    }

    return {
      position: r.position,
      variant: {
        ...best,
        поисковый_запрос: r.usedQuery || r.position.поисковый_запрос,
      },
    };
  });

  const bases = [...new Set(selection.map((s) => s.variant.смц))];
  await onProgress(`💰 Базы: ${bases.join(", ")}`);

  // Фаза 3 — очищаем корзину
  await onProgress("🧹 Очищаю корзину...");
  const page = await getPage();
  await clearCart(page);

  // Фаза 4 — добавляем в корзину
  await onProgress("🛒 Добавляю позиции в корзину...");
  const успешноДобавлено = [];

  for (const { position, variant } of selection) {
    await onProgress(`🛒 Добавляю: ${position.название} → ${variant.смц}`);
    try {
      await addToCart(variant, position.количество, position.единица);
      успешноДобавлено.push({ position, variant });
      order.корзина.push({
        название: position.название,
        смц: variant.смц,
        статус: "добавлено",
      });
    } catch (err) {
      if (err.message.startsWith("PHONE_ONLY:")) {
        await onProgress(
          `📞 ${position.название} — только по звонку, добавьте вручную`,
        );
        order.корзина.push({
          название: position.название,
          смц: variant.смц,
          статус: "звонок",
        });
        continue;
      }
      // Не падаем — логируем и продолжаем
      logger.error("Не удалось добавить в корзину", {
        название: position.название,
        error: err.message,
      });
      await onProgress(`❌ Не удалось добавить: ${position.название}`);
      order.корзина.push({
        название: position.название,
        смц: variant.смц,
        статус: "ошибка",
        ошибка: err.message,
      });
    }
    saveOrder(order);
    await delay(Math.random() * 1000 + 500);
  }

  // Фаза 5 — скриншот
  const cartScreenshot = await screenshotCart();

  // Обновляем итог — только реально добавленные
  order.итог.найдено = успешноДобавлено.length;
  order.итог.не_найдено = notFound.length + needHelp.length;
  order.итог.всего = positions.length;
  order.итог.время_обработки_сек = Math.round((Date.now() - startTime) / 1000);
  order.итог.статус = "ожидает подтверждения";
  saveOrder(order);

  return {
    cartScreenshot,
    selection: успешноДобавлено,
    notFound,
    needHelp,
    bases,
    order,
  };
}

module.exports = { processOrder };
