const { authorize } = require("./auth");
const { searchPosition } = require("./search");
const { addToCart } = require("./cart");
const { placeOrder, clearCart, screenshotCart } = require("./order");
const { getPage } = require("./browser");
const { askAI } = require("../agent/llm");
const { saveMapping } = require("../agent/searchMapManager");
const logger = require("../utils/logger");
const { saveOrder, logOrder } = require('../utils/orderLogger');

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
  if (result.found) return { result, usedQuery: position.поисковый_запрос };

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
    if (result.found) {
      await onProgress(`✅ Нашёл по запросу "${alt}"`);
      return { result, usedQuery: alt };
    }
  }

  return { result: { found: false }, usedQuery: null, needsHelp: true };
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
 * Выбирает лучший вариант из найденных.
 * Приоритет: ГОСТ > ТУ, минимальная цена внутри каждой группы.
 */
function selectBestVariant(variants) {
  // Сначала ищем ГОСТ варианты
  const гостВарианты = variants.filter(v =>
    v.название.toLowerCase().includes('гост')
  )

  // Если есть ГОСТ — берём минимальную цену среди ГОСТ
  // Если нет ГОСТ — берём минимальную цену среди всех
  let источник = гостВарианты.length > 0 ? гостВарианты : variants

  // Предпочитаем варианты с чётко определённой длиной прутка (6000/11700
  // и т.п.), а не "н/д" или диапазоны вроде "1000-6000" — на практике
  // именно у таких "неопределённых по длине" позиций чаще случается
  // нехватка на складе (см. фидбэк по арматуре). Если таких вариантов
  // нет вообще — не сужаем, берём из всех как раньше.
  const сОпределённойДлиной = источник.filter(имеетОпределённуюДлину)
  if (сОпределённойДлиной.length > 0) {
    источник = сОпределённойДлиной
  }

  return источник.reduce((min, v) =>
    v.цена_от_1т < min.цена_от_1т ? v : min
  )
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
      const { result, usedQuery, needsHelp } = await findPosition(position, onProgress);

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

  // Фаза 2 — выбираем лучший вариант (ГОСТ приоритет)
  await onProgress('💰 Выбираю лучшие цены...');
  const selection = found.map(r => {
    const best = selectBestVariant(r.variants)

    // Логируем ВСЕХ кандидатов и выбранный вариант — это ключевое место
    // для разбора "почему выбралось именно это", без похода на сайт вручную
    logger.info('Выбор варианта', {
      позиция: r.position.название,
      кандидаты: r.variants.map(краткоДляЛога),
      выбрано: краткоДляЛога(best),
    });

    // Логируем выбранный вариант
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

      // Сайт мог сам скорректировать количество (например, при нехватке
      // на складе) — это не ошибка, товар реально добавлен, но нужно
      // показать менеджеру точный текст, что именно скорректировано
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
        // WARNING теперь бросается ДО клика по кнопке "Добавить в корзину"
        // и означает блокирующий отказ (например "нет в наличии") —
        // это реальная неудача добавления, а не успех с предупреждением
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

  // Фаза 5 — скриншот
  const cartScreenshot = await screenshotCart();

  // Обновляем итог
  order.итог.найдено = успешноДобавлено.length;
  order.итог.не_найдено = notFound.length + needHelp.length;
  order.итог.всего = positions.length;
  order.итог.время_обработки_сек = Math.round((Date.now() - startTime) / 1000);
  order.итог.статус = 'ожидает подтверждения';
  saveOrder(order);

  return { cartScreenshot, selection: успешноДобавлено, notFound, needHelp, bases, order };
}

module.exports = { processOrder };