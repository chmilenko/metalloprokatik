/**
 * order.js
 * 
 * Оформление заказа на mc.ru и скачивание PDF счёта.
 */

const logger = require('../utils/logger')
const { getPage } = require('./browser')
const { authorize } = require('./auth')
const { getBasePriority } = require('../utils/basePriorityStore')
const path = require('path')
const fs = require('fs')

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Ищет в странице и во ВСЕХ её фреймах ВИДИМОЕ сообщение отказа mc.ru при
 * выписке счёта, например: «Создание счета отменено. По некоторым позициям
 * превышен лимит по выставленным счетам.» (реальная вёрстка:
 * <div class="page"><p>…</p> + кнопка «Вернуться в корзину», окно лежит в
 * iframe). Возвращает текст причины или null, если окна нет.
 *
 * ВАЖНО: ищем именно ВИДИМЫЙ абзац с этой фразой. Нельзя опираться на
 * наличие кнопки data-modal-close="submitBasket" или контейнера .page —
 * скрытая разметка модалки есть на странице корзины всегда, а .page
 * оказывается всей страницей (первая версия так «нашла» отказ в подвале
 * сайта и остановила заказ без причины).
 */
async function прочитатьОтказОформления(page) {
  for (const frame of page.frames()) {
    try {
      const текст = await frame.evaluate(() => {
        const абзац = Array.from(document.querySelectorAll('p')).find((p) =>
          /Создание сч[её]та отменено/i.test(p.innerText || '') &&
          p.getClientRects().length > 0 // видим на экране, не display:none
        )
        return абзац ? абзац.innerText.replace(/\s+/g, ' ').trim() : null
      })
      if (текст) return текст
    } catch (e) {
      // фрейм мог закрыться или перейти на другой адрес — пропускаем
    }
  }
  return null
}

/**
 * Читает чекбоксы позиций в корзине mc.ru (реальная вёрстка:
 * <input type="checkbox" id="chk1" name="chk1" checked> внутри
 * <div class="_nm">, название — ссылка в div._namet). После выбора базы
 * позиции, которых нет на этой базе, становятся неактивными — и в счёт
 * не попадают.
 */
async function прочитатьПозицииКорзины(page) {
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input[type="checkbox"]'))
      .filter((inp) => /^chk\d+$/.test(inp.id || ''))
      .map((inp) => {
        const блок = inp.closest('._nm')
        const ссылка = блок ? блок.querySelector('._namet a') : null
        return {
          id: inp.id,
          база: (() => { const tr = inp.closest('tr'); const td = tr && tr.querySelector('td.base_name'); return td ? td.innerText.replace(/\s+/g, ' ').trim() : null })(),
          название: ссылка ? ссылка.innerText.replace(/\s+/g, ' ').trim() : inp.id,
          включена: inp.checked && !inp.disabled,
          checked: inp.checked,
          disabled: inp.disabled,
          количество: (() => {
            // поле «Количество» лежит в той же строке корзины; если не нашли — null
            let узел = inp.parentElement
            for (let i = 0; i < 6 && узел; i++, узел = узел.parentElement) {
              const поле = Array.from(узел.querySelectorAll('input')).find(
                (x) => x !== inp && x.type !== 'checkbox' && x.type !== 'hidden' && x.value !== '' && !isNaN(parseFloat(String(x.value).replace(',', '.')))
              )
              if (поле) return parseFloat(String(поле.value).replace(',', '.'))
            }
            return null
          })(),
        }
      })
  })
}

/**
 * Читает информационное сообщение mc.ru в корзине (реальная вёрстка:
 * <div class="pageBasketError">На следующие товары превышен лимит по
 * неоплаченным счетам:<br>…<br>Количество изменено на максимально
 * допустимое.</div>). Появляется при оформлении: сайт сам уменьшает
 * количество, и заказ может не создаться, пока менеджер не нажмёт
 * «Оформить заказ» ещё раз. Возвращает видимый текст или null.
 */
async function прочитатьПредупреждениеКорзины(page) {
  for (const frame of page.frames()) {
    try {
      const текст = await frame.evaluate(() => {
        const блок = Array.from(document.querySelectorAll('.pageBasketError')).find(
          (el) => el.getClientRects().length > 0 && (el.innerText || '').trim()
        )
        if (!блок) return null
        return блок.innerText
          .split('\n')
          .map((строка) => строка.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join('\n')
      })
      if (текст) return текст
    } catch (e) {
      // фрейм мог закрыться — пропускаем
    }
  }
  return null
}

// Сверка названия товара из заказа с названием в корзине. Точное сравнение строк не годится:
// корзина дописывает марку/длину и меняет «х» на «x», а в названии из таблицы бывают «г/к»,
// «ГОСТ» и т.п. Поэтому: совпадает первое слово и ВСЕ «числовые» части названия (размеры, серии).
function названиеСовпадает(ожидаемое, фактическое) {
  const части = (т) =>
    String(т || '').toLowerCase().replace(/x/g, 'х').replace(/ё/g, 'е').split(/[^0-9a-zа-я]+/).filter(Boolean)
  const о = части(ожидаемое)
  const ф = части(фактическое)
  if (о.length === 0 || ф.length === 0) return false
  if (!ф.includes(о[0]) && !ф.some((x) => x.startsWith(о[0].slice(0, 5)))) return false
  const числовые = о.filter((x) => /\d/.test(x))
  return числовые.every((x) => ф.includes(x))
}

function добавитьПроблему(список, ожидаемая, причина) {
  список.push({ ключ: ожидаемая.ключ, название: ожидаемая.название, причина })
}

const ЛИМИТ_RE = /лимит|неоплач/i
const URL_КОРЗИНЫ = 'https://mc.ru/auction/page.asp/q/mymc/tab/shop/tab1/inf1'

/**
 * Красная цифра у пункта «Корзина» в шапке = в корзине остались товары
 * (после успешного счёта корзина обнуляется). Селектор значка неизвестен,
 * поэтому ищем по смыслу: элемент из одних цифр внутри ссылки/блока со
 * словом «Корзина» или ссылкой на вкладку корзины. Запасной признак —
 * на странице корзины всё ещё есть чекбоксы позиций.
 */
async function корзинаНеПуста(page) {
  try {
    return await page.evaluate(() => {
      const значок = document.querySelector('.headerBasket .headerBasketCount')
      if (значок) {
        const n = parseInt((значок.textContent || '').trim(), 10)
        return n > 0 ? { есть: true, число: n, источник: 'значок' } : { есть: false }
      }
      const цифры = Array.from(document.querySelectorAll('a, span, div, i, b, em, sup')).filter(
        (el) => el.children.length === 0 && /^\s*\d{1,3}\s*$/.test(el.textContent || '') && el.getClientRects().length > 0
      )
      for (const el of цифры) {
        const родитель = el.closest('a, li, .headerBasket, [class*="asket"], [class*="art"]')
        if (!родитель) continue
        const t = родитель.textContent || ''
        const href = родитель.getAttribute && (родитель.getAttribute('href') || '')
        if (/Корзин/i.test(t) || /tab\/shop/.test(href)) return { есть: true, число: parseInt(el.textContent, 10), источник: 'значок' }
      }
      const чекбоксы = document.querySelectorAll('._nm input[type="checkbox"]').length
      if (чекбоксы > 0) return { есть: true, число: чекбоксы, источник: 'позиции' }
      return { есть: false }
    })
  } catch (e) {
    return { есть: false, ошибка: e.message }
  }
}

/** Из текста «превышен лимит…» достаёт названия позиций (строки между заголовком и «Количество изменено»). */
function позицииИзЛимита(текст) {
  return String(текст || '')
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x && !/превышен лимит|Количество изменено|Внимание/i.test(x))
}

function ошибкаЛимита(текст) {
  const поз = позицииИзЛимита(текст)
  const err = new Error(
    'Превышен лимит по неоплаченным счетам' + (поз.length ? `: ${поз.join('; ')}` : '') +
    '. Сайт срезал количество (скорее всего до 0), счёт не создан. Оплатите или удалите старые неоплаченные счета на mc.ru.'
  )
  err.лимит = true
  err.позицииЛимита = поз
  err.остальных = null
  return err
}

async function placeOrder(предпочтительныеБазы = [], опции = {}) {
  const сообщить = typeof опции.приПредупреждении === 'function' ? опции.приПредупреждении : async () => {}
  const page = await getPage()

  // Проверяем/восстанавливаем сессию ПЕРЕД тем, как лезть в корзину —
  // сама authorize() ничего не делает, если мы уже залогинены (проверяет
  // .headerCabinet[data-auth-link]), так что это безопасная подстраховка,
  // а не лишний шаг при каждом вызове.
  try {
    await authorize()
  } catch (err) {
    logger.error('Не удалось авторизоваться на mc.ru перед оформлением заказа', { error: err.message })
    throw new Error(`Не удалось войти на mc.ru: ${err.message}`)
  }

  // Запоминаем время ДО оформления — чтобы потом найти новый заказ
  const orderTime = new Date()
  orderTime.setSeconds(0, 0)
  logger.info('Время оформления заказа', { time: orderTime })
  // Вызывающий код запоминает время: если счёт не появится сразу (бывает, что mc.ru
  // выписывает его с задержкой), по нему можно найти заказ позже
  if (typeof опции.приСтартеОформления === 'function') опции.приСтартеОформления(orderTime.toISOString())

  logger.info('Переходим в корзину')
  await page.goto('https://mc.ru/auction/page.asp/q/mymc/tab/shop/tab1/inf1')
  await page.waitForLoadState('domcontentloaded')
  await delay(2000)

  // ФИКС: перед оформлением убеждаемся, что в корзине ЕСТЬ позиции.
  // Раньше при пустой корзине mc.ru создавал заказ-пустышку «не оформлен»
  // на сумму 0, а бот потом 15 раз перезагружал список заказов впустую.
  // Признак «в корзине есть позиции» — тот же, что использует clearCart.
  if (!page.url().includes('/auction/page.asp/q/mymc/tab/shop/tab1/inf1')) {
    throw new Error(`Не попали на страницу корзины mc.ru (url: ${page.url()}) — возможно, потеряна авторизация`)
  }
  const позицииВКорзине = await page.$('a[data-dropdown-toggle="removeHint"]')
  if (!позицииВКорзине) {
    throw new Error('Корзина mc.ru пуста — оформлять нечего (позиции не добавились в корзину?)')
  }

  // Шаг 1 — читаем доступные базы в dropdown
  const availableBases = await page.evaluate(() => {
    const items = document.querySelectorAll('.dropdown-menu a[data-name="base"]')
    return Array.from(items).map(a => ({
      name: a.textContent.trim(),
      baseName: a.dataset.baseName
    }))
  })

  console.log('Доступные базы в корзине:', availableBases)

  // Шаг 2 — если есть выбор базы, выбираем по нашему приоритету
  let выбраннаяБаза = null
  if (availableBases.length > 0 && !опции.смешанныеБазы) {
    const приоритет = getBasePriority()
    const желаемые = Array.isArray(предпочтительныеБазы) ? предпочтительныеБазы : []
    // Сначала базы, которые менеджер выбрал для позиций заказа; остальные —
    // по общему приоритету, как и раньше.
    const ранг = (имя) => {
      const иЖ = желаемые.indexOf(имя)
      if (иЖ !== -1) return иЖ
      const иП = приоритет.indexOf(имя)
      return 1000 + (иП === -1 ? 999 : иП)
    }
    const отсортированные = [...availableBases].sort((a, b) => ранг(a.name) - ранг(b.name))
    const selectedBase = отсортированные[0].name
    выбраннаяБаза = selectedBase
    logger.info('Выбираем базу', { база: selectedBase, доступные: availableBases.map(b => b.name), желаемые, приоритет })

    // Если база уже выбрана (в выпадающем списке она единственная или стоит текущей) —
    // повторно по ней НЕ кликаем: клик перезагружает страницу (переход на /q/zakaz/m/1),
    // и кнопка «Оформить заказ» не успевала появиться (ошибка по таймауту #submitBasket).
    const текущая = await page.evaluate(() => {
      const el = document.querySelector('#FactorySel')
      return el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : ''
    }).catch(() => '')
    const ужеВыбрана = текущая.includes(selectedBase)
    if (ужеВыбрана) {
      logger.info('База уже выбрана — клик не нужен', { база: selectedBase })
    } else {
      await page.evaluate(() => {
        document.querySelector('#FactorySel').click()
      })
      await delay(500)

      await page.evaluate((name) => {
        const items = document.querySelectorAll('.dropdown-menu a[data-name="base"]')
        const target = Array.from(items).find(a => a.textContent.trim() === name)
        if (target) target.click()
      }, selectedBase)

      // выбор базы может перезагрузить страницу — ждём, пока она догрузится
      await page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {})
      await delay(1000)
    }
    logger.info('База выбрана', { база: selectedBase })
  }

  // Сообщения mc.ru в корзине (например, превышен лимит по неоплаченным
  // счетам, количество изменено сайтом) — показываем менеджеру ОДИН раз,
  // каждое новое. Само по себе оформление они не останавливают.
  let предупреждениеКорзины = null
  const сообщитьПредупреждениеКорзины = async () => {
    const текст = await прочитатьПредупреждениеКорзины(page).catch(() => null)
    if (текст && текст !== предупреждениеКорзины) {
      предупреждениеКорзины = текст
      logger.warn('Сообщение mc.ru в корзине', { текст })
      // про лимит менеджера спросим отдельным вопросом — в общий список не дублируем
      if (ЛИМИТ_RE.test(текст) && !опции.продолжитьБезЛимитных) return
      await сообщить(`⚠️ Сообщение mc.ru в корзине:\n${текст}`)
    }
  }

  // Окно отказа («Создание счёта отменено… превышен лимит по выставленным счетам»).
  // При лимите возвращаемся в корзину: сайт обнулил проблемные позиции, их названия
  // читаем из .pageBasketError, а при его отсутствии — по нулевому количеству.
  const обработатьОтказ = async (отказ) => {
    if (!ЛИМИТ_RE.test(отказ) || (опции.продолжитьБезЛимитных && !опции.повторПослеЛимита)) {
      throw new Error(`mc.ru отменил создание счёта: ${отказ}`)
    }
    await page.goto(URL_КОРЗИНЫ, { timeout: 60000 }).catch(() => {})
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await delay(2500)
    const текст = (await прочитатьПредупреждениеКорзины(page).catch(() => null)) || предупреждениеКорзины
    const строки = await прочитатьПозицииКорзины(page).catch(() => [])
    let проблемные = текст && ЛИМИТ_RE.test(текст) ? позицииИзЛимита(текст) : []
    if (проблемные.length === 0) проблемные = строки.filter((p) => p.количество === 0).map((p) => p.название)
    if (опции.повторПослеЛимита) {
      // Менеджер согласился оформить без этих позиций: сайт уже обнулил их —
      // снимаем с них галочки и выписываем счёт на остальные.
      const нулевые = строки.filter((p) => p.включена && p.количество === 0).map((p) => p.id)
      const остальные = строки.filter((p) => p.включена && p.количество !== 0 && !нулевые.includes(p.id))
      if (нулевые.length === 0 || остальные.length === 0) {
        throw new Error('Нет позиций, которые можно оформить без позиций с превышенным лимитом')
      }
      await page.evaluate((ids) => {
        for (const id of ids) {
          const el = document.getElementById(id)
          if (el && el.checked) el.click()
        }
      }, нулевые)
      await delay(800)
      logger.info('Лимит: сняты позиции с нулевым количеством, оформляю остальные', { нулевые })
      await page.evaluate(() => { const b = document.querySelector('#submitBasket'); if (b) b.click() })
      await delay(2500)
      await page.evaluate(() => { const b = document.querySelector('#submitBasket3'); if (b) b.click() })
      await delay(3000)
      return 'повторено'
    }
    const err = ошибкаЛимита(`превышен лимит по неоплаченным счетам:\n${проблемные.join('\n')}`)
    err.позицииЛимита = проблемные
    err.остальных = строки.filter((p) => p.количество !== 0 && p.количество !== null).length
    logger.warn('mc.ru: лимит по счетам', { отказ, проблемные, остальных: err.остальных })
    throw err
  }

  // Шаг 3 — первая кнопка оформления
  try {
    await page.waitForSelector('#submitBasket', { state: 'visible', timeout: 30000 })
  } catch (e) {
    // страница могла застрять посреди перехода — перезагружаем корзину и ждём ещё раз
    logger.warn('Кнопка «Оформить заказ» не появилась — перезагружаю корзину', { url: page.url(), error: e.message.split('\n')[0] })
    await page.goto('https://mc.ru/auction/page.asp/q/mymc/tab/shop/tab1/inf1', { timeout: 60000 })
    await page.waitForLoadState('domcontentloaded')
    await delay(2000)
    await page.waitForSelector('#submitBasket', { state: 'visible', timeout: 30000 })
  }
  await сообщитьПредупреждениеКорзины()

  // ФИКС: после выбора базы смотрим, какие позиции остались активными.
  // Неактивные (их нет на выбранной базе) в счёт не войдут — раньше это
  // происходило молча: счёт выписывался на одну позицию из двух, а если
  // не было ни одной активной — получался пустой заказ «не оформлен».
  let позицииКорзины = []
  try {
    позицииКорзины = await прочитатьПозицииКорзины(page)
  } catch (e) {
    await delay(1500)
    try {
      позицииКорзины = await прочитатьПозицииКорзины(page)
    } catch (e2) {
      logger.warn('Не удалось прочитать чекбоксы позиций в корзине', { error: e2.message })
    }
  }
  if (опции.продолжитьБезЛимитных) {
    // Продолжение после вопроса о лимите: сайт уже обнулил позиции с превышенным
    // лимитом — снимаем с них галочки, чтобы счёт выписался на остальные.
    const нулевые = позицииКорзины.filter((p) => p.включена && p.количество === 0).map((p) => p.id)
    if (нулевые.length > 0) {
      await page.evaluate((ids) => {
        for (const id of ids) {
          const el = document.getElementById(id)
          if (el && el.checked) el.click()
        }
      }, нулевые)
      await delay(800)
      позицииКорзины = await прочитатьПозицииКорзины(page).catch(() => позицииКорзины)
      logger.info('Сняты позиции с нулевым количеством', { ids: нулевые })
    }
  }
  logger.info('Позиции в корзине перед оформлением', { база: выбраннаяБаза, позиции: позицииКорзины })

  // Сверяем корзину с тем, что бот добавлял: пропавшие позиции и нулевое количество
  // (например, сайт срезал до 0 из-за лимита по неоплаченным счетам) — сообщаем.
  if (Array.isArray(опции.ожидаемые) && опции.ожидаемые.length > 0 && позицииКорзины.length > 0) {
    const проблемы = []
    for (const ож of опции.ожидаемые) {
      const строка = позицииКорзины.find((p) => названиеСовпадает(ож.название, p.название))
      if (!строка) добавитьПроблему(проблемы, ож, 'в корзине mc.ru такой позиции нет (не добавилась или пропала)')
      else if (строка.количество === 0) добавитьПроблему(проблемы, ож, 'в корзине количество 0 (сайт мог срезать его из-за лимита по неоплаченным счетам)')
    }
    if (проблемы.length > 0) {
      logger.warn('Корзина mc.ru не совпадает с заказом', { проблемы })
      if (typeof опции.приПроверкеКорзины === 'function') await опции.приПроверкеКорзины(проблемы)
    }
  }

  const выключены = позицииКорзины.filter((p) => !p.включена)
  if (позицииКорзины.length > 0 && выключены.length === позицииКорзины.length) {
    throw new Error(
      `После выбора базы${выбраннаяБаза ? ` «${выбраннаяБаза}»` : ''} в корзине mc.ru нет активных позиций ` +
      `(${выключены.map((p) => p.название).join('; ')}) — счёт был бы пустым`
    )
  }
  if (выключены.length > 0) {
    await сообщить(
      `⚠️ В корзине mc.ru на базе${выбраннаяБаза ? ` «${выбраннаяБаза}»` : ''} неактивны и в счёт НЕ войдут:\n` +
      выключены.map((p) => `• ${p.название}`).join('\n')
    )
  }
  await page.evaluate(() => {
    document.querySelector('#submitBasket').click()
  })
  await delay(1500)

  // Сообщение корзины могло появиться после клика «Оформить заказ».
  // Лимит по неоплаченным счетам: сайт показывает его ЗДЕСЬ (.pageBasketError) и
  // обнуляет позицию в корзине. Дальше не идём — менеджер решает, оформлять ли без неё.
  for (let i = 0; i < 4; i++) {
    await сообщитьПредупреждениеКорзины()
    if (предупреждениеКорзины) break
    await delay(1000)
  }

  // Отказ может появиться уже после первого клика
  let счётУжеПовторён = false
  const отказПослеШага3 = await прочитатьОтказОформления(page)
  if (отказПослеШага3) {
    logger.warn('mc.ru отменил создание счёта (после шага 3)', { причина: отказПослеШага3 })
    const р3 = await обработатьОтказ(отказПослеШага3)
    if (р3 === 'повторено') счётУжеПовторён = true
  }

  // Шаг 4 — кнопка в модалке
  await delay(1000)
  const кнопкаШага4Нажата = счётУжеПовторён || await page.evaluate(() => {
    const btn = document.querySelector('#submitBasket3')
    if (!btn) return false
    btn.click()
    return true
  })
  if (!кнопкаШага4Нажата) {
    logger.warn('Кнопка #submitBasket3 не найдена в модалке — шаг 4 пропущен')
  }

  // Вместо слепого ожидания 2 с — опрашиваем до 5 с: если mc.ru покажет
  // окно отказа (например, превышен лимит по выставленным счетам),
  // сразу сообщаем причину, а не ищем несуществующий новый заказ.
  for (let i = 0; i < 5; i++) {
    await delay(1000)
    const отказ = await прочитатьОтказОформления(page)
    if (отказ) {
      logger.warn('mc.ru отменил создание счёта', { причина: отказ })
      const р4 = await обработатьОтказ(отказ)
      if (р4 === 'повторено') break
    }
  }

  // Последний шанс увидеть сообщение корзины, пока мы ещё на её странице
  await сообщитьПредупреждениеКорзины()

  // Проверка по красной цифре у «Корзины»: если после оформления корзина не
  // обнулилась — счёт не создан. Лимит по неоплаченным счетам — сразу понятная
  // ошибка; иначе перезагружаем корзину (свежее состояние, чтобы не оформить
  // счёт дважды) и пробуем нажать кнопки ещё раз.
  // (после «оформить без позиций с лимитом» в корзине остаются обнулённые — не проверяем)
  for (let попытка = 0; попытка < (опции.повторПослеЛимита ? 0 : 2); попытка++) {
    await page.goto(URL_КОРЗИНЫ, { timeout: 60000 }).catch(() => {})
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await delay(2000)
    const флаг = await корзинаНеПуста(page)
    logger.info('Проверка корзины после оформления', { флаг, попытка })
    if (!флаг.есть) break // корзина пуста — счёт, скорее всего, создан
    const текстКорзины = (await прочитатьПредупреждениеКорзины(page).catch(() => null)) || предупреждениеКорзины
    if (!опции.продолжитьБезЛимитных && текстКорзины && ЛИМИТ_RE.test(текстКорзины)) throw ошибкаЛимита(текстКорзины)
    if (попытка === 1) break
    logger.warn('Корзина не обнулилась — повторяю оформление', { флаг })
    const нажат = await page.evaluate(() => {
      const b = document.querySelector('#submitBasket')
      if (!b) return false
      b.click()
      return true
    }).catch(() => false)
    if (!нажат) break
    await delay(2500)
    await page.evaluate(() => {
      const b = document.querySelector('#submitBasket3')
      if (b) b.click()
    }).catch(() => {})
    await delay(4000)
    await сообщитьПредупреждениеКорзины()
  }

  // Шаг 5 — идём в список заказов
  logger.info('Переходим в список заказов')
  await page.goto('https://mc.ru/partner/zak')
  await page.waitForLoadState('domcontentloaded')
  await delay(2000)

  // Шаг 6 — ждём появления нового заказа по времени. Если корзина
  // выдала сообщение (лимит и т.п.), заказ, скорее всего, не создался —
  // не ждём все 15 попыток и показываем сообщение в тексте ошибки.
  let accountUrl
  try {
    accountUrl = await waitForOrderReady(page, orderTime, { сокращённо: !!предупреждениеКорзины, несколько: !!опции.смешанныеБазы })
  } catch (err) {
    // «не оформлен» / «не появился»: заказ мог появиться на сайте позже — разрешаем повторный поиск
    if (/не оформлен|не появился/i.test(err.message)) err.можноПовторить = true
    if (предупреждениеКорзины && /лимит|неоплач/i.test(предупреждениеКорзины)) throw ошибкаЛимита(предупреждениеКорзины)
    if (предупреждениеКорзины) {
      throw new Error(
        `${err.message}\nСообщение mc.ru в корзине: ${предупреждениеКорзины.replace(/\n/g, ' ')}\n` +
        'Количество в корзине уже изменено сайтом — проверьте корзину и нажмите «Оформить заказ» вручную.'
      )
    }
    // Заказ не появился, а сообщения корзины мы не видели — заглядываем в корзину ещё раз:
    // причина (например «превышен лимит по неоплаченным счетам») обычно написана там.
    let причинаСайта = null
    try {
      await page.goto('https://mc.ru/auction/page.asp/q/mymc/tab/shop/tab1/inf1', { timeout: 60000 })
      await page.waitForLoadState('domcontentloaded')
      await delay(2000)
      причинаСайта = await прочитатьПредупреждениеКорзины(page)
    } catch (e2) {
      // не критично — отдадим исходную ошибку
    }
    if (причинаСайта && /лимит|неоплач/i.test(причинаСайта)) throw ошибкаЛимита(причинаСайта)
    if (причинаСайта) {
      const лимит = false
      throw new Error(
        `Счёт не создан. Сообщение mc.ru: ${причинаСайта.replace(/\n/g, ' ')}` +
          (лимит ? '\nОплатите или удалите старые неоплаченные счета в кабинете mc.ru и повторите.' : '')
      )
    }
    throw err
  }

  // Шаг 7 — получаем PDF. Если не вышло, прикладываем ссылки на счета к ошибке:
  // по ним PDF можно скачать позже, не оформляя заказ заново.
  const ссылки = Array.isArray(accountUrl) ? accountUrl : [accountUrl]
  try {
    if (Array.isArray(accountUrl)) {
      const пути = []
      for (const u of accountUrl) {
        const путь = await getPdfUrlAndDownload(page, u)
        logger.info('PDF скачан', { path: путь })
        пути.push(путь)
      }
      return пути
    }
    const pdfPath = await getPdfUrlAndDownload(page, accountUrl)
    logger.info('PDF скачан', { path: pdfPath })
    return pdfPath
  } catch (err) {
    err.счётUrls = ссылки
    err.можноПовторить = true
    throw err
  }
}

/**
 * Ищет в списке заказов mc.ru счета, выписанные в промежутке [время, до] (по умолчанию
 * +20 минут). Нужна для повторного получения счёта, который появился на сайте с задержкой.
 * Возвращает [{ url, номерСчёта, номерЗаказа }] — пустой список, если счетов ещё нет.
 */
async function найтиСчетаПоВремени(времяISO, опции = {}) {
  const page = await getPage()
  try {
    await authorize()
  } catch (err) {
    throw new Error(`Не удалось войти на mc.ru: ${err.message}`)
  }
  const t0 = new Date(времяISO)
  const t1 = опции.до ? new Date(опции.до) : new Date(t0.getTime() + 20 * 60000)
  const попыток = опции.попыток || 8

  for (let i = 0; i < попыток; i++) {
    // reload иногда обрывается (ERR_ABORTED, пока сайт сам перенаправляет) — тогда открываем список заново
    if (i === 0) await page.goto('https://mc.ru/partner/zak')
    else await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => page.goto('https://mc.ru/partner/zak'))
    await page.waitForLoadState('domcontentloaded')
    await delay(2000)

    const найдено = await page.evaluate(({ от, до }) => {
      const a = new Date(от)
      const b = new Date(до)
      const res = []
      const диагн = { строк: 0, сДатой: 0, примерыДат: [], ссылок: 0 }
      for (const row of document.querySelectorAll('table tbody tr')) {
        диагн.строк++
        const c = row.querySelector('td:nth-child(2)')
        const m = c && c.innerText.trim().match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/)
        if (!m) continue
        диагн.сДатой++
        if (row.querySelector('td a[href*="main.asp"]')) диагн.ссылок++
        if (диагн.примерыДат.length < 3) диагн.примерыДат.push(m[0] + ' → ' + new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]).toISOString())
        const d = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5])
        if (d < a || d >= b) continue
        const ссылка = row.querySelector('td a[href*="main.asp"]')
        if (!ссылка) continue
        const первая = row.querySelector('td:nth-child(1)')
        res.push({
          url: ссылка.href,
          номерСчёта: ((ссылка.innerText || '').match(/\d{4,}/) || [null])[0],
          номерЗаказа: ((первая && первая.innerText || '').match(/\d{4,}/) || [null])[0],
        })
      }
      return { res, диагн }
    }, { от: t0.toISOString(), до: t1.toISOString() })

    logger.info('Повторный поиск счетов в списке заказов', {
      попытка: i + 1, найдено: найдено.res.length, окно: [t0.toISOString(), t1.toISOString()], url: page.url(), ...найдено.диагн,
    })
    if (найдено.res.length > 0) return найдено.res
    await delay(6000)
  }
  return []
}

/** Скачивает PDF по ссылкам на счета (из найтиСчетаПоВремени или из ошибки placeOrder). */
async function скачатьСчёт(ссылки) {
  const page = await getPage()
  try {
    await authorize()
  } catch (err) {
    throw new Error(`Не удалось войти на mc.ru: ${err.message}`)
  }
  const пути = []
  for (const u of ссылки) {
    const путь = await getPdfUrlAndDownload(page, u)
    logger.info('PDF скачан (повторно)', { path: путь })
    пути.push(путь)
  }
  return пути
}

async function waitForOrderReady(page, orderTime, опции = {}) {
  logger.info('Ждём появления нового заказа...')
  const maxAttempts = опции.сокращённо ? 4 : 15
  // Заказ-пустышка «не оформлен» (без ссылки на счёт, сумма 0) сам не
  // оформится: после стольких подряд наблюдений сдаёмся сразу, а не
  // крутим все 15 попыток.
  const ПОРОГ_НЕ_ОФОРМЛЕН = 4
  let подрядНеОформлен = 0
  let последнийНеОформлен = null

  for (let i = 0; i < maxAttempts; i++) {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await delay(2000)

    const найдено = await page.evaluate((timeStr) => {
      const orderTime = new Date(timeStr)
      const rows = document.querySelectorAll('table tbody tr')
      let неОформлен = null
      const urls = []

      for (const row of rows) {
        const dateCell = row.querySelector('td:nth-child(2)')
        if (!dateCell) continue

        const dateText = dateCell.innerText.trim()
        const parts = dateText.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/)
        if (!parts) continue

        const orderDate = new Date(
          parseInt(parts[3]),
          parseInt(parts[2]) - 1,
          parseInt(parts[1]),
          parseInt(parts[4]),
          parseInt(parts[5])
        )

        if (orderDate >= orderTime) {
          const link = row.querySelector('td a[href*="main.asp"]')
          if (link) { urls.push(link.href); continue }

          // Нет ссылки на счёт. Если в строке «не оформлен» — запоминаем
          // (реальная вёрстка: статус «не оформлен» в первой и последней
          // ячейках, «#номер» в последней, сумма — в 3-й ячейке).
          const текст = (row.innerText || '').replace(/\s+/g, ' ').trim()
          if (/не оформлен/i.test(текст)) {
            const суммаЯчейка = row.querySelector('td:nth-child(3)')
            const номер = текст.match(/#(\d+)/)
            неОформлен = {
              номер: номер ? номер[1] : null,
              сумма: суммаЯчейка ? суммаЯчейка.innerText.trim() : null,
            }
          }
        }
      }
      return { url: urls[0] || null, urls, неОформлен }
    }, orderTime.toISOString())

    if (найдено.url) {
      logger.info('Новый заказ найден', { url: найдено.url })
      if (!опции.несколько) return найдено.url
      // Несколько баз в одном заказе: mc.ru может выписать несколько счетов — даём им появиться
      await delay(4000)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await delay(2000)
      const все = await page.evaluate((timeStr) => {
        const t0 = new Date(timeStr)
        const res = []
        for (const row of document.querySelectorAll('table tbody tr')) {
          const c = row.querySelector('td:nth-child(2)')
          const m = c && c.innerText.trim().match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/)
          if (!m) continue
          const d = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5])
          const a = row.querySelector('td a[href*="main.asp"]')
          if (d >= t0 && a) res.push(a.href)
        }
        return res
      }, orderTime.toISOString()).catch(() => [найдено.url])
      const уникальные = Array.from(new Set(все.length ? все : [найдено.url]))
      logger.info('Новые счета', { количество: уникальные.length, urls: уникальные })
      return уникальные
    }

    if (найдено.неОформлен) {
      подрядНеОформлен += 1
      последнийНеОформлен = найдено.неОформлен
      logger.warn('В списке заказов есть заказ «не оформлен»', {
        ...найдено.неОформлен,
        наблюдений: подрядНеОформлен,
      })
      if (подрядНеОформлен >= ПОРОГ_НЕ_ОФОРМЛЕН) {
        const { номер, сумма } = найдено.неОформлен
        throw new Error(
          `mc.ru создал заказ${номер ? ` #${номер}` : ''}, но он остался «не оформлен»` +
          `${сумма !== null ? ` (сумма ${сумма})` : ''} — счёт не сформирован. ` +
          'Проверьте корзину и заказ на сайте.'
        )
      }
    } else {
      подрядНеОформлен = 0
    }

    logger.info(`Новый заказ ещё не появился, попытка ${i + 1}/${maxAttempts}`)
    await delay(3000)
  }

  if (последнийНеОформлен) {
    throw new Error(
      `mc.ru создал заказ${последнийНеОформлен.номер ? ` #${последнийНеОформлен.номер}` : ''}, но он остался «не оформлен» — счёт не сформирован.`
    )
  }
  throw new Error('Новый заказ не появился за отведённое время')
}

async function getPdfUrlAndDownload(page, accountUrl) {
  console.log('URL счёта:', accountUrl)

  const newPage = await page.context().newPage()

  // mc.ru иногда формирует печатную форму дольше обычного: ждём 30 секунд, затем
  // открываем страницу счёта заново и ждём ещё 30 (раньше сдавались на первых 30)
  let finalUrl = null
  try {
    for (let заход = 0; заход < 2 && !finalUrl; заход++) {
      await newPage.goto(accountUrl)
      for (let i = 0; i < 15; i++) {
        await delay(2000)
        const currentUrl = newPage.url()
        console.log(`Заход ${заход + 1}, попытка ${i + 1}, URL:`, currentUrl)

        if (currentUrl.includes('save_doc')) {
          finalUrl = currentUrl
          break
        }
      }
    }
  } finally {
    await newPage.close().catch(() => {})
  }

  if (!finalUrl) {
    throw new Error('PDF не сформировался за 60 секунд')
  }

  return downloadPdf(page, finalUrl)
}

async function downloadPdf(page, url) {
  const outputDir = path.join(__dirname, '../../downloads')
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  const filename = `order_${Date.now()}.pdf`
  const filepath = path.join(outputDir, filename)

  const pdfBuffer = await page.evaluate(async (pdfUrl) => {
    const response = await fetch(pdfUrl, { credentials: 'include' })
    const buffer = await response.arrayBuffer()
    return Array.from(new Uint8Array(buffer))
  }, url)

  fs.writeFileSync(filepath, Buffer.from(pdfBuffer))
  return filepath
}

async function clearCart(page) {
  logger.info('Очищаем корзину')

  await page.goto('https://mc.ru/auction/page.asp/q/mymc/tab/shop/tab1/inf1')
  await page.waitForLoadState('domcontentloaded')
  await delay(1000)

  // Если нас выкинуло с корзины (потеря сессии), «корзина пуста» ниже была
  // бы ложной — и старые позиции ушли бы в заказ. Лучше упасть громко.
  if (!page.url().includes('/auction/page.asp/q/mymc/tab/shop/tab1/inf1')) {
    throw new Error(`Не попали на страницу корзины mc.ru (url: ${page.url()}) — возможно, потеряна авторизация`)
  }

  const hasItems = await page.$('a[data-dropdown-toggle="removeHint"]')
  if (!hasItems) {
    logger.info('Корзина уже пуста')
    return
  }

  await page.click('a[data-dropdown-toggle="removeHint"]')
  await delay(500)

  await page.waitForSelector('.appDropdown.hintMsg', { state: 'visible' })
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('.appDropdown.hintMsg button')
    const yesBtn = Array.from(buttons).find(b => b.textContent.trim() === 'Да')
    if (yesBtn) yesBtn.click()
  })

  await delay(1000)

  // Проверяем результат: перезагружаем корзину и убеждаемся, что позиций нет
  await page.reload({ waitUntil: 'domcontentloaded' })
  await delay(1000)
  const остались = await page.$('a[data-dropdown-toggle="removeHint"]')
  if (остались) {
    throw new Error('Корзина mc.ru не очистилась — после подтверждения позиции остались')
  }

  logger.info('Корзина очищена')
}

async function screenshotCart() {
  const page = await getPage();

  const CART_URL = 'https://mc.ru/auction/page.asp/q/mymc/tab/shop/tab1/inf1';

  const currentUrl = page.url();
  if (!currentUrl.includes('/auction/page.asp/q/mymc/tab/shop/tab1/inf1')) {
    logger.info('Переходим в корзину для скриншота');
    await page.goto(CART_URL, {
      timeout: 30000,
      waitUntil: 'domcontentloaded'
    });
  } else {
    logger.info('Уже на странице корзины, обновляем');
    await page.reload({ waitUntil: 'domcontentloaded' });
  }

  await delay(1000);

  let реальныйUrl = page.url();
  if (!реальныйUrl.includes('/auction/page.asp/q/mymc/tab/shop/tab1/inf1')) {
    logger.warn('После перехода мы НЕ на странице корзины — похоже на потерю сессии, переавторизуемся и пробуем ещё раз', {
      ожидали: CART_URL,
      реальныйUrl,
    });

    try {
      await authorize();
    } catch (err) {
      logger.error('Не удалось переавторизоваться перед повтором скриншота', { error: err.message });
    }

    await page.goto(CART_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await delay(1000);

    реальныйUrl = page.url();
    if (!реальныйUrl.includes('/auction/page.asp/q/mymc/tab/shop/tab1/inf1')) {
      logger.error('Повторный переход тоже не попал на корзину — скриншот будет неверным', {
        реальныйUrl,
      });
    }
  }

  const outputDir = path.join(__dirname, '../../downloads');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const screenshotPath = path.join(outputDir, `cart_${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  logger.info('Скриншот корзины сохранён', { path: screenshotPath, url: page.url() });
  return screenshotPath;
}

/** Открывает корзину mc.ru и возвращает её позиции [{id, название, включена, количество}]. */
async function прочитатьКорзину() {
  const page = await getPage()
  await page.goto(URL_КОРЗИНЫ, { timeout: 60000 })
  await page.waitForLoadState('domcontentloaded')
  await delay(2000)
  return await прочитатьПозицииКорзины(page)
}

module.exports = { placeOrder, clearCart, screenshotCart, прочитатьКорзину, названиеСовпадает, найтиСчетаПоВремени, скачатьСчёт }