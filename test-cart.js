require('dotenv').config()
const { authorize } = require('./src/scraper/auth')
const { searchPosition } = require('./src/scraper/search')
const { addToCart } = require('./src/scraper/cart')
const { closeBrowser } = require('./src/scraper/browser')

async function test() {
  try {
    await authorize()

    // Ищем трубу ВГП ДУ15 стенка 2
    const result = await searchPosition('ВГП', {
      параметры: { ду: 15, стенка: 2 }
    })

    if (!result.found) {
      console.log('❌ Позиция не найдена')
      return
    }

    console.log('Найдено вариантов:', result.variants.length)
    console.log('Берём первый вариант:', result.variants[0].смц)

    // Добавляем первый вариант в корзину — 1 тонна
    await addToCart(result.variants[0], 1, 'т')
    console.log('✅ Добавлено в корзину')

    await new Promise(resolve => setTimeout(resolve, 3000))
  } catch (err) {
    console.error('❌ Ошибка:', err.message)
  } finally {
    await closeBrowser()
  }
}

test()