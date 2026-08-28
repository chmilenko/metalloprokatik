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

function краткоДляЛога(v) {
  return {
    название: v.название,
    марка: v.марка || null,
    длина: v.длина || null,
    смц: v.смц,
    цена_от_1т: v.цена_от_1т,
  };
}

// Проверяет — есть ли среди сырых (ещё не отфильтрованных) строк
// кандидаты С ТЕМ ЖЕ размером/шириной/диаметром, что и запрошено, но
// другой стенкой. Если да — это высокая уверенность, что нужного товара
// просто нет в наличии у этого размера: категория на сайте одна и та
// же, переформулировка запроса не покажет данных, которых там физически
// нет. Возвращает массив доступных стенок (для подсказки менеджеру) или
// null, если сигнала недостаточно (тогда идём в обычный AI-перебор).
function доступныеСтенкиПриТомЖеРазмере(position, rawRows) {
  const стенкаЗапроса = position.параметры?.стенка;
  if (стенкаЗапроса == null || !rawRows || rawRows.length === 0) return null;

  const ожидаемыйРазмер =
    position.параметры?.диаметр ?? position.параметры?.ширина ?? position.параметры?.номер;
  if (ожидаемыйРазмер == null) return null;

  const совпаденияПоРазмеру = rawRows.filter((r) => {
    const размерСтроки = String(r.размер || '').trim().replace(',', '.');
    if (размерСтроки !== String(ожидаемыйРазмер).trim()) return false;

    // Для прямоугольной трубы (задана вторая сторона отдельно от первой)
    // нужно совпадение и по ВТОРОЙ стороне тоже — иначе смешаются стенки
    // от совсем другого размера (например "40х20хK" при запросе "40х25хK").
    // Вторую сторону приходится доставать из названия (в сырых данных
    // отдельного структурного поля под неё нет), она идёт ВТОРЫМ числом.
    const втораяСторонаЗапроса = position.параметры?.длина_листа;
    if (втораяСторонаЗапроса == null) return true; // круглая труба или квадратная — второй стороны нет вовсе

    const перваяСтрокаНазвания = String(r.название || '').split('\n')[0];
    const числаНазвания = перваяСтрокаНазвания.match(/[\d.,]+/g);
    if (!числаНазвания || числаНазвания.length < 3) return false; // не прямоугольная строка — нечего сравнивать
    const втораяСторонаСтроки = числаНазвания[1].replace(',', '.');
    return втораяСторонаСтроки === String(втораяСторонаЗапроса).trim();
  });

  if (совпаденияПоРазмеру.length === 0) return null; // размера вообще нет — тут неопределённость выше, пусть AI попробует переформулировать

  // ВАЖНО: стенку берём из НАЗВАНИЯ, а не из поля "марка" — у поля
  // "марка" разный смысл в разных категориях труб (у круглых — реально
  // стенка, у профильных — вторая сторона Б, не стенка вообще). А вот
  // последнее число в первой строке названия ("...NхMхK") — это всегда
  // стенка, что для круглой ("60х1.5"), что для профильной ("40х20х0.8") трубы.
  const стенки = new Set();
  for (const r of совпаденияПоРазмеру) {
    const перваяСтрока = String(r.название || '').split('\n')[0];
    const числа = перваяСтрока.match(/[\d.,]+/g);
    if (!числа || числа.length < 2) continue;
    const последнее = числа[числа.length - 1].replace(',', '.');
    if (/^\d+(\.\d+)?$/.test(последнее)) стенки.add(последнее);
  }

  if (стенки.size === 0) return null;
  return [...стенки].sort((a, b) => parseFloat(a) - parseFloat(b));
}

async function findPosition(position, onProgress) {
  let result = await searchPosition(position.поисковый_запрос, position);
  let lastRawRows = result.rawRows || [];
  if (result.found) return { result, usedQuery: position.поисковый_запрос, rawRows: lastRawRows };

  // Короткое замыкание: если размер/ширина/диаметр УЖЕ найдены на
  // странице категории, но именно стенка не совпала — переформулировка
  // запроса ничего не даст (это та же самая база данных сайта, только
  // спрошенная иначе). Вместо 3-4 循环 AI-переформулировок (каждая — это
  // ещё один проход по URL-категории + глобальному поиску, десятки
  // секунд впустую) сразу возвращаем "не найдено" вместе со списком
  // РЕАЛЬНО доступных стенок — это и быстрее, и полезнее менеджеру.
  const доступныеСтенки = доступныеСтенкиПриТомЖеРазмере(position, lastRawRows);
  if (доступныеСтенки) {
    await onProgress(
      `❌ Не нашёл стенку ${position.параметры.стенка} — в наличии у этого размера есть: ${доступныеСтенки.join(', ')}`
    );
    return {
      result: { found: false },
      usedQuery: null,
      needsHelp: false,
      rawRows: lastRawRows,
      доступныеСтенки,
    };
  }

  await onProgress(
    `⚠️ Не нашёл по запросу "${position.поисковый_запрос}". Пробую альтернативы...`
  );

  // Если у позиции уже есть структурный размер (диаметр/ширина/номер) —
  // просим только ОДНУ альтернативу вместо трёх. Сайт ищет по цифрам,
  // а не по формулировке — "труба квадратная 32х3.2" и "профильная
  // 32х32х3.2" для текстового поиска почти эквивалентны, три круга
  // переформулировок тут почти никогда не помогают, только тратят
  // время (десятки секунд на честно отсутствующую позицию). Там, где
  // структурных параметров нет вообще — формулировка действительно
  // может решить, оставляем три попытки как раньше.
  const естьСтруктурныйРазмер =
    position.параметры?.диаметр != null ||
    position.параметры?.ширина != null ||
    position.параметры?.номер != null;
  const нужноАльтернатив = естьСтруктурныйРазмер ? 1 : 3;

  const alternativesRaw = await askAI(`
Запрос "${position.поисковый_запрос}" не нашёл результатов на сайте металлопроката mc.ru.
Позиция: ${position.название}

Предложи ${нужноАльтернатив} альтернативных коротких поисковых запроса для поиска на сайте.
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

function имеетОпределённуюДлину(v) {
  const длина = String(v.длина || '').trim()
  return /^\d+$/.test(длина)
}

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
      const { result, usedQuery, needsHelp, rawRows, доступныеСтенки } = await findPosition(position, onProgress);

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
        if (доступныеСтенки) position.доступныеСтенки = доступныеСтенки;
        notFound.push(position);
        searchLog.статус = 'не найдено';
        searchLog.доступныеСтенки = доступныеСтенки || null;
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

  await onProgress('🧹 Очищаю корзину...');
  const page = await getPage();
  await clearCart(page);

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

function вариантПоПозицииИзРекомендации(baseRecommendation) {
  const карта = new Map();
  for (const p of baseRecommendation.позиции) {
    if (p.вариант) карта.set(p.название, p.вариант);
  }
  return карта;
}

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