require('dotenv').config()
const { authorize } = require('./src/scraper/auth')
const {  } = require('./src/scraper/search')
const { closeBrowser, getPage } = require('./src/scraper/browser')

async function test() {
  try {
    await authorize()

    const result = await ('ВГП', {
  параметры: { ду: 15, стенка: 2 }
})
console.log('Варианты:', JSON.stringify(result.variants, null, 2))

    // Смотрим колонки таблицы
    const page = await getPage()
    const headers = await page.$$eval('table thead th', ths =>
      ths.map((th, i) => `${i}: ${th.innerText.trim()}`)
    )
    console.log('Колонки:', headers)
    console.log('Результат:', JSON.stringify(result.variants[0], null, 2))

    await new Promise(resolve => setTimeout(resolve, 3000))
  } catch (err) {
    console.error('❌ Ошибка:', err.message)
  } finally {
    await closeBrowser()
  }
}

test()