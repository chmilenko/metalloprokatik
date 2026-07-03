require('dotenv').config()
const { authorize } = require('./src/scraper/auth')
const { closeBrowser } = require('./src/scraper/browser')

async function test() {
  try {
    await authorize()
    console.log('✅ Авторизация прошла успешно')
    
    // Ждём 3 секунды чтобы увидеть результат в браузере
    await new Promise(resolve => setTimeout(resolve, 3000))
  } catch (err) {
    console.error('❌ Ошибка:', err.message)
  } finally {
    await closeBrowser()
  }
}

test()