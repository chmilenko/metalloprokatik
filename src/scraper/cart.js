/**
 * cart.js
 * 
 * Работа с корзиной на mc.ru.
 * Добавляет позиции в корзину через модальное окно (iframe).
 */

const logger = require('../utils/logger')
const { getPage } = require('./browser')

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function addToCart(variant, quantity, unit = 'т') {
  const page = await getPage()

  logger.info('Добавляем в корзину', {
    название: variant.название,
    смц: variant.смц,
    количество: quantity,
    единица: unit
  })

  // Переходим на главную и ищем через поисковую строку
  await page.goto('https://mc.ru')
  await page.waitForLoadState('domcontentloaded')
  await delay(1000)

  // Открываем поиск
  await page.evaluate(() => {
    document.querySelector('#searchField').click()
  })
  await delay(300)

  // Вводим запрос
  await page.waitForSelector('input[name="referal"]', { state: 'visible' })
  await page.fill('input[name="referal"]', variant.поисковый_запрос)
  await delay(300)

  await page.press('input[name="referal"]', 'Enter')
  await page.waitForLoadState('domcontentloaded')
  await delay(2000)

  // Ждём таблицу
  await page.waitForSelector('table tbody tr', { state: 'visible', timeout: 10000 })
  await delay(500)

  // Находим нужную строку по названию и СМЦ
  const rows = await page.$$('table tbody tr')

  let targetRow = null

  for (const row of rows) {
    const смц = await row.$eval('td:nth-child(5)', el => el.innerText.trim()).catch(() => '')
    const название = await row.$eval('td:nth-child(1)', el => el.innerText.trim()).catch(() => '')

    if (смц === variant.смц && название === variant.название) {
      targetRow = row
      break
    }
  }

  if (!targetRow) {
    throw new Error(`Не нашли строку: ${variant.название} на базе ${variant.смц}`)
  }

  // Кликаем на иконку корзины
  await targetRow.$eval('button._basket', btn => btn.click())
  await delay(1000)

  // Ждём появления iframe внутри модалки
  await page.waitForSelector('#addbasket', { state: 'visible' })
  await delay(500)

  // Переключаемся на iframe
  const iframeElement = await page.$('#addbasket')
  const iframe = await iframeElement.contentFrame()

  // Ждём загрузки содержимого iframe
  await iframe.waitForSelector('#tonns', { state: 'visible' })
  await delay(300)

  // Вводим количество
  if (unit === 'м') {
    await iframe.fill('#meters', String(quantity))
  } else {
    await iframe.fill('#tonns', String(quantity))
  }

  await delay(500)

  // Нажимаем кнопку — "Добавить в корзину" или "Обновить в корзине"
  await iframe.evaluate(() => {
    const buttons = document.querySelectorAll('button')
    const btn = Array.from(buttons).find(b =>
      b.textContent.trim().toLowerCase().includes('добавить в корзину') ||
      b.textContent.trim().toLowerCase().includes('обновить в корзине')
    )
    if (btn) btn.click()
  })

  await delay(1000)
  logger.info('Добавлено в корзину', { название: variant.название, смц: variant.смц })
}

module.exports = { addToCart }