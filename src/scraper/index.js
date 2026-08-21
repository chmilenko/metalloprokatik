const { authorize } = require("./auth");
const { searchPosition } = require("./search");
const { addToCart } = require("./cart");
const { placeOrder, clearCart, screenshotCart } = require("./order");
const { getPage } = require("./browser");
const { askAI } = require("../agent/llm");
const { saveMapping } = require("../agent/searchMapManager");
const logger = require("../utils/logger");
const { saveOrder, logOrder } = require('../utils/orderLogger');
const { построитьТаблицу, сохраниТаблицу } = require('./decisionTable');
const { подбериБазу } = require('./baseOptimizer');
const { getBasePriority } = require('../utils/basePriorityStore');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Компактное представление варианта для логов — только то, что нужно
// для разбора неожиданного выбора, без лишних полей
function краткоДляЛога(v) {
  return {
    название: v.название,
    марка: v.марка || null,
    длина: v.длина || null,
    смц: v.смц,
    цена_от_1т: v.цена_от_1т,
  };
}

async function findPosition(position, onProgress) {
  let result = await searchPosition(position.поисковый_запрос, position);
  let lastRawRows = result.rawRows || [];
  if (result.found) return { result, usedQuery: position.поисковый_запрос, rawRows: lastRawRows };

  await onProgress(
    `⚠️ Не нашёл по запросу "${position.поисковый_запрос}". Пробую альтернативы...`
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
    if (result.rawRows?.length) lastRawRows = result.rawRows;
    if (result.found) {
      await onProgress(`✅ Нашёл по запросу "${alt}"`);
      return { result, usedQuery: alt, rawRows: lastRawRows };
    }
  }

  return { result: { found: false }, usedQuery: null, needsHelp: true, rawRows: lastRawRows };
}

/**
 * Проверяет, что у варианта чётко определена длина (например "6000"),
 * а не "н/д", диапазон вроде "1000-6000" или что-то ещё неопределённое.
 */
function имеетОпределённуюДлину(v) {
  const длина = String(v.длина || '').trim()
  return /^\d+$/.test(длина)
}

/**
 * Выбирает лучший вариант из найденных — БЕЗ учёта базы, только по цене.
 * Используется как резервный вариант, если по какой-то причине подбор
 * базы не дал варианта для конкретной позиции (не должно случаться при
 * нормальной работе baseOptimizer, но на всякий случай не роняем заказ).
 * Приоритет: ГОСТ > ТУ, чёткая длина > "н/д", минимальная цена внутри группы.
 */
function selectBestVariant(variants) {
  const гостВарианты = variants.filter(v =>
    v.название.toLowerCase().includes('гост')
  )

  let источник = гостВарианты.length > 0 ? гостВарианты : variants

  const сОпределённойДлиной = источник.filter(имеетОпределённуюДлину)
  if (сОпределённойДлиной.length > 0) {
    источник = сОпределённойДлиной
  }

  return источник.reduce((min, v) =>
    v.цена_от_1т < min.цена_от_1т ? v : min
  )
}

/**
 * Фаза 1 — поиск всех позиций. Ничего не добавляет в корзину, только
 * ищет и фильтрует. Отдельная функция, потому что после поиска нужно
 * подобрать базу (см. baseOptimizer) и, возможно, спросить менеджера —
 * а уже потом (в finalizeOrder) заполнять корзину.
 */
async function searchPositions(positions, onProgress, onNeedHelp, order) {
  await authorize();

  const found = [];
  const notFound = [];
  const needHelp = [];

  for (let i = 0; i < positions.length; i++) {
    const position = positions[i];
    await onProgress(`🔍 Ищу ${i + 1}/${positions.length}: ${position.название}...`);

    const searchLog = {
      название: position.название,
      запрос: position.поисковый_запрос,
      до_фильтрации: 0,
      после_фильтрации: 0,
      альтернативы: [],
      выбран: null,
      статус: 'не найдено'
    };

    try {
      const { result, usedQuery, needsHelp, rawRows } = await findPosition(position, onProgress);

      // Таблица решения — строится ВСЕГДА, когда есть с чем сравнивать
      // (даже если ничего не найдено — важно видеть, что было и почему
      // отклонено). Не роняем обработку заявки, если тут что-то пойдёт не так.
      try {
        if (rawRows && rawRows.length > 0) {
          const таблица = построитьТаблицу(position, rawRows);
          сохраниТаблицу(order.id, таблица);
        }
      } catch (auditErr) {
        logger.warn('Не удалось построить таблицу решения', {
          название: position.название,
          error: auditErr.message,
        });
      }

      if (needsHelp) {
        needHelp.push(position);
        searchLog.статус = 'нужна помощь';
        await onNeedHelp(position);
      } else if (!result.found) {
        notFound.push(position);
        searchLog.статус = 'не найдено';
        await onProgress(`❌ Не найдено: ${position.название}`);
      } else {
        found.push({ position, variants: result.variants, usedQuery });
        searchLog.статус = 'найдено';
        searchLog.после_фильтрации = result.variants.length;
        await onProgress(`✅ ${position.название} — найдено ${result.variants.length} вариантов`);
      }
    } catch (err) {
      notFound.push(position);
      searchLog.статус = 'ошибка';
      searchLog.ошибка = err.message;
    }

    order.поиск.push(searchLog);
    saveOrder(order);

    if (i < positions.length - 1) {
      await delay(Math.random() * 2000 + 1500);
    }
  }

  return { found, notFound, needHelp };
}

/**
 * Фаза 2-5 — очищает корзину и заполняет её. Принимает УЖЕ подобранные
 * варианты (по одному на позицию, привязанные к выбранной базе/базам —
 * см. baseOptimizer.подбериБазу). Если для какой-то позиции вариант не
 * передан (не должно случаться, но на всякий случай) — берёт резервный
 * через selectBestVariant.
 *
 * @param {Array<{position, variants}>} found - результат searchPositions
 * @param {Map<string, object>} вариантПоПозиции - название позиции → выбранный вариант
 * @param {object[]} notFound
 * @param {object[]} needHelp
 * @param {Function} onProgress
 * @param {object} order
 */
async function finalizeOrder(found, вариантПоПозиции, notFound, needHelp, onProgress, order) {
  const startTime = Date.now();

  if (found.length === 0) {
    order.итог.статус = 'не найдено ничего';
    order.итог.время_обработки_сек = Math.round((Date.now() - startTime) / 1000);
    saveOrder(order);
    logOrder(order);

    return {
      cartScreenshot: null,
      selection: [],
      notFound,
      needHelp,
      bases: [],
      order
    };
  }

  await onProgress('💰 Собираю позиции по выбранной базе...');
  const selection = found.map(r => {
    const best = вариантПоПозиции.get(r.position.название) || selectBestVariant(r.variants);

    logger.info('Выбор варианта', {
      позиция: r.position.название,
      кандидаты: r.variants.map(краткоДляЛога),
      выбрано: краткоДляЛога(best),
    });

    const searchLog = order.поиск.find(s => s.название === r.position.название);
    if (searchLog) {
      searchLog.выбран = {
        название: best.название,
        смц: best.смц,
        цена: best.цена_от_1т,
        гост: best.название.toLowerCase().includes('гост')
      };
      searchLog.кандидаты = r.variants.map(краткоДляЛога);
    }

    return {
      position: r.position,
      variant: { ...best, поисковый_запрос: r.usedQuery || r.position.поисковый_запрос }
    };
  });

  const bases = [...new Set(selection.map(s => s.variant.смц))];
  await onProgress(`💰 Базы: ${bases.join(', ')}`);

  // Фаза 3 — очищаем корзину
  await onProgress('🧹 Очищаю корзину...');
  const page = await getPage();
  await clearCart(page);

  // Фаза 4 — добавляем в корзину
  await onProgress('🛒 Добавляю позиции в корзину...');
  const успешноДобавлено = [];

  for (const { position, variant } of selection) {
    await onProgress(`🛒 Добавляю: ${position.название} → ${variant.смц}`);
    try {
      const addResult = await addToCart(variant, position.количество, position.единица);
      успешноДобавлено.push({ position, variant });

      const запись = {
        название: position.название,
        смц: variant.смц,
        статус: 'добавлено'
      };

      if (addResult?.adjusted) {
        await onProgress(`⚠️ ${position.название}: ${addResult.adjustmentMessage}`);
        запись.предупреждение = addResult.adjustmentMessage;
      }

      order.корзина.push(запись);
    } catch (err) {
      if (err.message.startsWith('PHONE_ONLY:')) {
        await onProgress(`📞 ${position.название} — только по звонку, добавьте вручную`);
        order.корзина.push({
          название: position.название,
          смц: variant.смц,
          статус: 'звонок'
        });
        continue;
      }

      if (err.message.startsWith('WARNING:')) {
        const parts = err.message.replace('WARNING:', '').split('|');
        const сообщение = parts[1];
        await onProgress(`❌ Не удалось добавить: ${position.название} — ${сообщение}`);
        order.корзина.push({
          название: position.название,
          смц: variant.смц,
          статус: 'ошибка',
          ошибка: сообщение
        });
        continue;
      }

      logger.error('Не удалось добавить в корзину', {
        название: position.название,
        error: err.message
      });
      await onProgress(`❌ Не удалось добавить: ${position.название}`);
      order.корзина.push({
        название: position.название,
        смц: variant.смц,
        статус: 'ошибка',
        ошибка: err.message
      });
    }
    saveOrder(order);
    await delay(Math.random() * 1000 + 500);
  }

  const cartScreenshot = await screenshotCart();

  order.итог.найдено = успешноДобавлено.length;
  order.итог.не_найдено = notFound.length + needHelp.length;
  order.итог.всего = found.length + notFound.length + needHelp.length;
  order.итог.время_обработки_сек = Math.round((Date.now() - startTime) / 1000);
  order.итог.статус = 'ожидает подтверждения';
  saveOrder(order);

  return { cartScreenshot, selection: успешноДобавлено, notFound, needHelp, bases, order };
}

// Строит Map<название, вариант> из рекомендации baseOptimizer — удобный
// формат для передачи в finalizeOrder
function вариантПоПозицииИзРекомендации(baseRecommendation) {
  const карта = new Map();
  for (const p of baseRecommendation.позиции) {
    if (p.вариант) карта.set(p.название, p.вариант);
  }
  return карта;
}

/**
 * Главная точка входа — как и раньше, но теперь может вернуться ДВУМЯ
 * разными способами:
 *  1. Обычный результат (как раньше) — если база подобралась без
 *     необходимости спрашивать менеджера (единая ПРИОРИТЕТНАЯ база на
 *     все позиции).
 *  2. { needsBaseConfirmation: true, found, notFound, needHelp,
 *       baseRecommendation, order } — если нужно подтверждение. Корзина
 *     в этом случае ЕЩЁ НЕ заполняется. Вызывающий код (handlers/message.js)
 *     должен спросить менеджера и потом вызвать finalizeOrder напрямую
 *     (см. handlers/callback.js) с итоговой картой вариантов.
 */
async function processOrder(positions, onProgress, onNeedHelp, order) {
  const { found, notFound, needHelp } = await searchPositions(positions, onProgress, onNeedHelp, order);

  if (found.length === 0) {
    return finalizeOrder(found, new Map(), notFound, needHelp, onProgress, order);
  }

  const baseRecommendation = подбериБазу(found, [], getBasePriority());

  logger.info('Подбор базы', {
    тип: baseRecommendation.тип,
    база: baseRecommendation.база || baseRecommendation.базы,
    требуетПодтверждения: baseRecommendation.требуетПодтверждения,
  });

  if (!baseRecommendation.требуетПодтверждения) {
    const вариантПоПозиции = вариантПоПозицииИзРекомендации(baseRecommendation);
    return finalizeOrder(found, вариантПоПозиции, notFound, needHelp, onProgress, order);
  }

  // Нужно подтверждение менеджера — НЕ заполняем корзину, отдаём всё
  // необходимое наверх, чтобы handlers/message.js мог спросить и
  // дождаться ответа через callback (см. handlers/callback.js)
  return {
    needsBaseConfirmation: true,
    found,
    notFound,
    needHelp,
    baseRecommendation,
    order,
  };
}

module.exports = { processOrder, searchPositions, finalizeOrder, findPosition, вариантПоПозицииИзРекомендации };