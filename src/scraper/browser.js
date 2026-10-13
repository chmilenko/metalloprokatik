/**
 * browser.js
 *
 * Инициализация и управление браузером Playwright.
 * Один браузер на всё приложение — открываем один раз.
 *
 * ДОБАВЛЕНО (для КТЗ): setPage() — позволяет "подставить" уже готовую
 * (например, авторизованную) страницу как текущую общую. Нужно потому,
 * что auth-ktz.js создаёт СВОЙ собственный контекст/страницу с уже
 * загруженной сессией (через context.newPage() с storageState) — без
 * этой функции cart-ktz.js/order-ktz.js, вызывая обычный getPage(),
 * получали бы ДРУГУЮ, неавторизованную страницу, и вся авторизация
 * оказывалась бы бесполезной. Для существующей логики mc.ru эта
 * функция никак не используется и ничего не меняет — чисто добавление.
 */

const { chromium } = require('playwright')
const logger = require('../utils/logger')

let browser = null
let page = null

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: false,
      channel: undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    })
    page = null
    logger.info('Браузер запущен')

    // ФИКС: вешаем ПОСЛЕ запуска, на конкретный экземпляр браузера —
    // а не на переменную browser, которая в момент загрузки модуля
    // ещё null (было бы TypeError при старте бота)
    browser.on('disconnected', () => {
      logger.error('КРИТИЧНО: браузер отключился/умер неожиданно')
    })
  }
  return browser
}

async function getPage() {
  const br = await getBrowser()
  if (!page || page.isClosed()) {
    const context = await br.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      acceptDownloads: true
    })
    page = await context.newPage()
  }
  return page
}

function setPage(newPage) {
  page = newPage
  logger.info('Текущая страница заменена (setPage)')
}

async function closeBrowser() {
  if (browser) {
    await browser.close()
    browser = null
    page = null
    logger.info('Браузер закрыт')
  }
}

module.exports = { getBrowser, getPage, setPage, closeBrowser }