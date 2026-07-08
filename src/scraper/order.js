/**
 * order.js
 * 
 * Оформление заказа на mc.ru и скачивание PDF счёта.
 */

const logger = require('../utils/logger')
const { getPage } = require('./browser')
const path = require('path')
const fs = require('fs')

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function placeOrder() {
  const page = await getPage()

  // Запоминаем время ДО оформления — чтобы потом найти новый заказ
  const orderTime = new Date()
  orderTime.setSeconds(0, 0)
  logger.info('Время оформления заказа', { time: orderTime })

  logger.info('Переходим в корзину')
  await page.goto('https://mc.ru/auction/page.asp/q/mymc/tab/shop/tab1/inf1')
  await page.waitForLoadState('domcontentloaded')
  await delay(2000)

  // Шаг 1 — читаем доступные базы в dropdown
  const availableBases = await page.evaluate(() => {
    const items = document.querySelectorAll('.dropdown-menu a[data-name="base"]')
    return Array.from(items).map(a => ({
      name: a.textContent.trim(),
      baseName: a.dataset.baseName
    }))
  })

  console.log('Доступные базы в корзине:', availableBases)

  // Шаг 2 — если есть выбор базы, выбираем первую
  // (все базы в dropdown покрывают все позиции корзины)
  if (availableBases.length > 0) {
    const selectedBase = availableBases[0].name
    logger.info('Выбираем базу', { база: selectedBase })

    // Открываем dropdown
    await page.evaluate(() => {
      document.querySelector('#FactorySel').click()
    })
    await delay(500)

    // Выбираем базу
    await page.evaluate((name) => {
      const items = document.querySelectorAll('.dropdown-menu a[data-name="base"]')
      const target = Array.from(items).find(a => a.textContent.trim() === name)
      if (target) target.click()
    }, selectedBase)

    await delay(1000)
    logger.info('База выбрана', { база: selectedBase })
  }

  // Шаг 3 — первая кнопка оформления
  await page.waitForSelector('#submitBasket', { state: 'visible', timeout: 15000 })
  await page.evaluate(() => {
    document.querySelector('#submitBasket').click()
  })
  await delay(1500)

  // Шаг 4 — кнопка в модалке (Оформить заказ или Выписать счета)
  await delay(1000)
  await page.evaluate(() => {
    const btn = document.querySelector('#submitBasket3')
    if (btn) btn.click()
  })
  await delay(2000)

  // Шаг 5 — идём в список заказов
  logger.info('Переходим в список заказов')
  await page.goto('https://mc.ru/partner/zak')
  await page.waitForLoadState('domcontentloaded')
  await delay(2000)

  // Шаг 6 — ждём появления нового заказа по времени
  const accountUrl = await waitForOrderReady(page, orderTime)

  // Шаг 7 — получаем PDF
  const pdfPath = await getPdfUrlAndDownload(page, accountUrl)
  logger.info('PDF скачан', { path: pdfPath })
  return pdfPath
}

async function waitForOrderReady(page, orderTime) {
  logger.info('Ждём появления нового заказа...')

  const maxAttempts = 15

  for (let i = 0; i < maxAttempts; i++) {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await delay(2000)

    const newOrderUrl = await page.evaluate((timeStr) => {
      const orderTime = new Date(timeStr)
      const rows = document.querySelectorAll('table tbody tr')

      for (const row of rows) {
        const dateCell = row.querySelector('td:nth-child(2)')
        if (!dateCell) continue

        const dateText = dateCell.innerText.trim()
        // Формат: "07.07.2026 19:21"
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
          return link ? link.href : null
        }
      }
      return null
    }, orderTime.toISOString())

    if (newOrderUrl) {
      logger.info('Новый заказ найден', { url: newOrderUrl })
      return newOrderUrl
    }

    logger.info(`Новый заказ ещё не появился, попытка ${i + 1}/${maxAttempts}`)
    await delay(3000)
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
  logger.info('Корзина очищена')
}

module.exports = { placeOrder, clearCart }