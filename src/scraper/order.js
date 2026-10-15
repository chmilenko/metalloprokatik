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
  if (availableBases.length > 0) {
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
      await сообщить(`⚠️ Сообщение mc.ru в корзине:\n${текст}`)
    }
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

  // Сообщение корзины могло появиться после клика «Оформить заказ»
  await сообщитьПредупреждениеКорзины()

  // Отказ может появиться уже после первого клика
  const отказПослеШага3 = await прочитатьОтказОформления(page)
  if (отказПослеШага3) {
    logger.warn('mc.ru отменил создание счёта (после шага 3)', { причина: отказПослеШага3 })
    throw new Error(`mc.ru отменил создание счёта: ${отказПослеШага3}`)
  }

  // Шаг 4 — кнопка в модалке
  await delay(1000)
  const кнопкаШага4Нажата = await page.evaluate(() => {
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
      throw new Error(`mc.ru отменил создание счёта: ${отказ}`)
    }
  }

  // Последний шанс увидеть сообщение корзины, пока мы ещё на её странице
  await сообщитьПредупреждениеКорзины()

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
    accountUrl = await waitForOrderReady(page, orderTime, { сокращённо: !!предупреждениеКорзины })
  } catch (err) {
    if (предупреждениеКорзины) {
      throw new Error(
        `${err.message}\nСообщение mc.ru в корзине: ${предупреждениеКорзины.replace(/\n/g, ' ')}\n` +
        'Количество в корзине уже изменено сайтом — проверьте корзину и нажмите «Оформить заказ» вручную.'
      )
    }
    throw err
  }

  // Шаг 7 — получаем PDF
  const pdfPath = await getPdfUrlAndDownload(page, accountUrl)
  logger.info('PDF скачан', { path: pdfPath })
  return pdfPath
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
          if (link) return { url: link.href, неОформлен: null }

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
      return { url: null, неОформлен }
    }, orderTime.toISOString())

    if (найдено.url) {
      logger.info('Новый заказ найден', { url: найдено.url })
      return найдено.url
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
  await newPage.goto(accountUrl)

  let finalUrl = null
  for (let i = 0; i < 15; i++) {
    await delay(2000)
    const currentUrl = newPage.url()
    console.log(`Попытка ${i + 1}, URL:`, currentUrl)

    if (currentUrl.includes('save_doc')) {
      finalUrl = currentUrl
      break
    }
  }

  await newPage.close()

  if (!finalUrl) {
    throw new Error('PDF не сформировался за 30 секунд')
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

module.exports = { placeOrder, clearCart, screenshotCart  }