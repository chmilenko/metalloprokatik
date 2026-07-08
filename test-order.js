require('dotenv').config()
const { authorize } = require('./src/scraper/auth')
const { placeOrder } = require('./src/scraper/order')
const { closeBrowser } = require('./src/scraper/browser')

async function test() {
  try {
    await authorize()

    // Товар уже в корзине с прошлого теста
    const pdfPath = await placeOrder()
    console.log('✅ PDF скачан:', pdfPath)

    await new Promise(resolve => setTimeout(resolve, 3000))
  } catch (err) {
    console.error('❌ Ошибка:', err.message)
  } finally {
    await closeBrowser()
  }
}

test()