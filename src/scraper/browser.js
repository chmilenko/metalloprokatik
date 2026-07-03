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
  if (!browser) {
    browser = await chromium.launch({
      headless: false, // false чтобы видеть что происходит во время разработки
    })
    logger.info('Браузер запущен')
  }
  return browser
}

async function getPage() {
  if (!page) {
    const br = await getBrowser()
    const context = await br.newContext({
      // Притворяемся обычным пользователем
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
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

module.exports = { getBrowser, getPage, closeBrowser }