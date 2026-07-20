const { authorize } = require("./auth");
const { searchPosition } = require("./search");
const { addToCart } = require("./cart");
const { placeOrder, clearCart } = require("./order");
const { getPage } = require("./browser");
const { askAI } = require("../agent/llm");
const { saveMapping } = require("../agent/searchMapManager");
const logger = require("../utils/logger");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPosition(position, onProgress) {
  // Шаг 1 — пробуем основной запрос
  let result = await searchPosition(position.поисковый_запрос, position);
  if (result.found) return { result, usedQuery: position.поисковый_запрос };

  await onProgress(
    `⚠️ Не нашёл по запросу "${position.поисковый_запрос}". Пробую альтернативы...`,
  );

  // Шаг 2 — просим Claude предложить альтернативы
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

  // Шаг 3 — пробуем каждую альтернативу
  for (const alt of alternatives) {
    await onProgress(`🔄 Пробую запрос: "${alt}"...`);
    result = await searchPosition(alt, position);
    if (result.found) {
      saveMapping(position.поисковый_запрос, alt);
      await onProgress(`✅ Нашёл по запросу "${alt}" — сохранил в словарь`);
      return { result, usedQuery: alt };
    }
  }

  return { result: { found: false }, usedQuery: null, needsHelp: true };
}

async function processOrder(positions, onProgress, onNeedHelp) {
  await authorize();

  const found = [];
  const notFound = [];
  const needHelp = [];

  // Фаза 1 — поиск всех позиций
  for (let i = 0; i < positions.length; i++) {
    const position = positions[i];

    await onProgress(
      `🔍 Ищу ${i + 1}/${positions.length}: ${position.название}...`,
    );

    try {
      const { result, usedQuery, needsHelp } = await findPosition(
        position,
        onProgress,
      );

      if (needsHelp) {
        needHelp.push(position);
        await onNeedHelp(position);
      } else if (!result.found) {
        notFound.push(position);
        await onProgress(`❌ Не найдено: ${position.название}`);
      } else {
        // Сохраняем usedQuery — тот запрос который реально сработал
        found.push({ position, variants: result.variants, usedQuery });
        await onProgress(
          `✅ ${position.название} — найдено ${result.variants.length} вариантов`,
        );
      }
    } catch (err) {
      notFound.push(position);
      logger.error("Ошибка поиска", {
        название: position.название,
        error: err.message,
      });
      await onProgress(`❌ Ошибка: ${position.название}`);
    }

    if (i < positions.length - 1) {
      await delay(Math.random() * 2000 + 1500);
    }
  }

  if (found.length === 0) {
    throw new Error("Ни одна позиция не найдена");
  }

  // Фаза 2 — выбираем лучшую цену
  await onProgress("💰 Выбираю лучшие цены...");
  const selection = found.map((r) => {
    const best = r.variants.reduce((min, v) =>
      v.цена_от_1т < min.цена_от_1т ? v : min,
    );
    return {
      position: r.position,
      variant: {
        ...best,
        // Используем usedQuery — запрос который реально нашёл позицию
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
await onProgress('🛒 Добавляю позиции в корзину...')

let addedCount = 0
const phoneOnly = []

for (const { position, variant } of selection) {
  await onProgress(`🛒 Добавляю: ${position.название} → ${variant.смц}`)
  try {
    await addToCart(variant, position.количество, position.единица)
    addedCount++
  } catch (err) {
    if (err.message.startsWith('PHONE_ONLY:')) {
      phoneOnly.push(position)
      await onProgress(`📞 ${position.название} — только по звонку, добавьте вручную`)
      continue
    }
    throw err
  }
  await delay(Math.random() * 1000 + 500)
}

// Если ничего не добавилось — не идём дальше
if (addedCount === 0) {
  await onProgress('❌ Ни одна позиция не была добавлена в корзину')
  return { 
    cartScreenshot: null, 
    selection, 
    notFound, 
    needHelp, 
    bases,
    phoneOnly 
  }
}

// Фаза 5 — скриншот корзины
const { screenshotCart } = require('./order')
const cartScreenshot = await screenshotCart()

return { cartScreenshot, selection, notFound, needHelp, bases, phoneOnly }

  // Останавливаемся — ждём подтверждения от менеджера
  return {
    cartScreenshot,
    selection,
    notFound,
    needHelp,
    bases,
    awaitingConfirmation: true,
  };
}

module.exports = { processOrder };
