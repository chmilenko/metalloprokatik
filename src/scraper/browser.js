/**
 * browser.js
 * 
 * Инициализация и управление браузером Playwright.
 * Один браузер на всё приложение — открываем один раз.
 */

const { chromium } = require('playwright')
const logger = require('../utils/logger')

let browser = null
let page = null

async function getBrowser() {
  // Проверяем что браузер живой
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: false
    })
    page = null // сбрасываем страницу при новом браузере
    logger.info('Браузер запущен')
  }
  return browser
}

async function getPage() {
  const br = await getBrowser()

  // Проверяем что страница живая
  if (!page || page.isClosed()) {
    const context = await br.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      acceptDownloads: true
    })
    page = await context.newPage()
  }

  return page
}

async function closeBrowser() {
  if (browser) {
    await browser.close()
    browser = null
    page = null
    logger.info('Браузер закрыт')
  }
}

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true, // на сервере всегда headless
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    })
    page = null
    logger.info('Браузер запущен')
  }
  return browser
}

module.exports = { getBrowser, getPage, closeBrowser }