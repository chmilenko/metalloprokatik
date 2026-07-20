/**
 * search.js
 * 
 * Поиск позиции на mc.ru.
 * Вводит поисковый запрос → возвращает список найденных вариантов с ценами.
 */

const logger = require('../utils/logger')
const { getPage } = require('./browser')

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function searchPosition(query,  position = {}) {
  const page = await getPage()

  logger.info('Ищем позицию', { query })
// Всегда возвращаемся на главную перед поиском
await page.goto('https://mc.ru')
await page.waitForLoadState('domcontentloaded')
await delay(500)
  // Кликаем на иконку лупы
  await page.click('.headerSearch')
  await delay(Math.random() * 500 + 300)

  // Ждём появления поля ввода
  await page.waitForSelector('input[name="referal"]', { state: 'visible' })

  // Вводим запрос
  await page.fill('input[name="referal"]', query)
  await delay(Math.random() * 500 + 300)

  // Нажимаем Enter
  await page.press('input[name="referal"]', 'Enter')
await page.waitForLoadState('domcontentloaded')
  await delay(2000)

  // Проверяем нашлось ли что-то
  const notFound = await page.$('text=Наименование не найдено в каталоге')
  if (notFound) {
    logger.warn('Позиция не найдена', { query })
    return { found: false, query }
  }

  // Парсим таблицу результатов
const rows = await page.$$eval('table tbody tr', rows => {
  // Функция очистки цены — оставляем только число
  function parsePrice(text) {
    if (!text) return null
    const match = text.match(/[\d\s]+/)
    if (!match) return null
    return parseInt(match[0].replace(/\s/g, ''), 10)
  }

  return rows.map(row => {
    const cells = row.querySelectorAll('td')
    return {
      название: cells[0]?.innerText?.trim(),
      марка: cells[2]?.innerText?.trim(),
      длина: cells[3]?.innerText?.trim(),
      смц: cells[4]?.innerText?.trim(),
      остаток: cells[5]?.innerText?.trim(),
      цена_от_1т: parsePrice(cells[8]?.innerText),
      цена_от_5т: parsePrice(cells[9]?.innerText),
      цена_от_10т: parsePrice(cells[10]?.innerText),
    }
  }).filter(row => row.название && row.цена_от_1т)
  // Фильтруем только строки где есть цена
})
  logger.info('Найдено вариантов', { query, count: rows.length })
// Временно добавь перед filterVariants
console.log('Найденные строки до фильтрации:')
rows.forEach(r => console.log(JSON.stringify(r)))
const filtered = filterVariants(rows, position)
  
  logger.info('Найдено вариантов после фильтрации', { 
    query, 
    total: rows.length,
    filtered: filtered.length 
  })

  return { found: filtered.length > 0, query, variants: filtered }
}

// После получения rows добавь фильтрацию
function filterVariants(variants, position) {
  const запросНижний = (position.поисковый_запрос || '').toLowerCase()
  const нужнаНержавейка = запросНижний.includes('нержавеющ') ||
                          запросНижний.includes('aisi') ||
                          запросНижний.includes('нерж')
  const нужнаНизколег = запросНижний.includes('низколегир') ||
                        (position.параметры?.марка || '').toLowerCase().includes('09г2с') ||
                        (position.параметры?.марка || '').toLowerCase().includes('с355')

  return variants.filter(v => {
    const название = v.название.toLowerCase()

    // Убираем нержавейку если не нужна
    const этоНержавейка = название.includes('нержавеющ') ||
                          название.includes('aisi') ||
                          название.includes('нерж')
    if (этоНержавейка && !нужнаНержавейка) return false

    // Убираем низколегированные если не нужны
    const этоНизколег = название.includes('низколегир')
    if (этоНизколег && !нужнаНизколег) return false

    // Фильтр для сортового проката по номеру
    if (запросНижний.includes('швеллер') || запросНижний.includes('уголок') ||
        запросНижний.includes('балка') || запросНижний.includes('круг') ||
        запросНижний.includes('полоса')) {

      const номерЗапроса = запросНижний
        .replace(/швеллер|уголок|балка|круг|полоса/g, '')
        .trim()

      if (номерЗапроса) {
        const номерБезБуквы = номерЗапроса.replace(/[пу]/g, '').trim()
        const буква = номерЗапроса.replace(/[^пу]/g, '').trim()

        const регулярка = new RegExp(`(^|\\s|\\()${номерБезБуквы}(\\s|п|у|х|x|$|\\))`)
        if (!регулярка.test(название)) return false

        if (буква) {
          if (!название.includes(` ${буква}`) &&
              !название.includes(`${номерБезБуквы}${буква}`)) return false
        }
      }

      return true
    }

    // Фильтр по ДУ
    if (position.параметры?.ду) {
      if (!название.includes(`${position.параметры.ду}`)) return false
    }

    // Фильтр по диаметру
    if (position.параметры?.диаметр) {
      if (!название.includes(`${position.параметры.диаметр}`)) return false
    }

    // Фильтр по стенке
    if (position.параметры?.стенка) {
      const стенка = String(position.параметры.стенка)
      const стенкаВНазвании = название.includes(`x${стенка}`) ||
                              название.includes(`х${стенка}`) ||
                              название.includes(`*${стенка}`)
      const стенкаВМарке = v.марка === стенка
      if (!стенкаВНазвании && !стенкаВМарке) return false
    }

    // Фильтр по толщине листа
    if (position.параметры?.толщина) {
      const толщина = String(position.параметры.толщина)
      if (!название.includes(`${толщина}х`) &&
          !название.includes(`${толщина}x`)) return false
    }

    if (position.параметры?.ширина) {
      if (!название.includes(`${position.параметры.ширина}`)) return false
    }

    if (position.параметры?.длина_листа) {
      if (!название.includes(`${position.параметры.длина_листа}`)) return false
    }

    return true
  })
}

module.exports = { searchPosition }