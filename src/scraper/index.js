/**
 * scraper/index.js
 * 
 * Главный модуль скрапера.
 * Полный цикл: авторизация → очистка корзины → поиск → оптимизация баз → корзина → заказ → PDF
 */

const { authorize } = require('./auth')
const { searchPosition } = require('./search')
const { addToCart } = require('./cart')
const { placeOrder, clearCart } = require('./order')
const { getPage } = require('./browser')
const logger = require('../utils/logger')

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function optimizeBases(results) {
  const allBases = new Set()
  results.forEach(r => {
    r.variants.forEach(v => allBases.add(v.смц))
  })

  const bases = Array.from(allBases)

  // Шаг 1 — одна база покрывает всё
  for (const base of bases) {
    const covers = results.every(r =>
      r.variants.some(v => v.смц === base)
    )
    if (covers) {
      return buildSelection(results, [base])
    }
  }

  // Шаг 2 — комбинация из 2 баз
  for (let i = 0; i < bases.length; i++) {
    for (let j = i + 1; j < bases.length; j++) {
      const combo = [bases[i], bases[j]]
      const covers = results.every(r =>
        r.variants.some(v => combo.includes(v.смц))
      )
      if (covers) {
        return buildSelection(results, combo)
      }
    }
  }

  // Шаг 3 — комбинация из 3 баз
  for (let i = 0; i < bases.length; i++) {
    for (let j = i + 1; j < bases.length; j++) {
      for (let k = j + 1; k < bases.length; k++) {
        const combo = [bases[i], bases[j], bases[k]]
        const covers = results.every(r =>
          r.variants.some(v => combo.includes(v.смц))
        )
        if (covers) {
          return buildSelection(results, combo)
        }
      }
    }
  }

  // Берём минимальную цену для каждой позиции
  return buildSelection(results, bases)
}

function buildSelection(results, allowedBases) {
  return results.map(r => {
    const allowed = r.variants.filter(v => allowedBases.includes(v.смц))
    const best = allowed.reduce((min, v) =>
      v.цена_от_1т < min.цена_от_1т ? v : min
    )
    return {
      position: r.position,
      variant: { ...best, поисковый_запрос: r.position.поисковый_запрос },
      variants: allowed // все варианты для fallback
    }
  })
}

async function processOrder(positions, onProgress) {
  await authorize()

  const found = []
  const notFound = []

  // Фаза 1 — поиск всех позиций
  for (let i = 0; i < positions.length; i++) {
    const position = positions[i]

    await onProgress(`🔍 Ищу ${i + 1}/${positions.length}: ${position.название}...`)

    try {
      const result = await searchPosition(position.поисковый_запрос, position)

      if (!result.found) {
        notFound.push(position)
        await onProgress(`❌ Не найдено: ${position.название}`)
      } else {
        found.push({ position, variants: result.variants })
        await onProgress(`✅ ${position.название} — найдено ${result.variants.length} вариантов`)
      }
    } catch (err) {
      notFound.push(position)
      logger.error('Ошибка поиска', { название: position.название, error: err.message })
      await onProgress(`❌ Ошибка: ${position.название}`)
    }

    if (i < positions.length - 1) {
      await delay(Math.random() * 2000 + 1500)
    }
  }

  if (found.length === 0) {
    throw new Error('Ни одна позиция не найдена')
  }

// Фаза 2 — выбираем лучшую цену для каждой позиции
await onProgress('💰 Выбираю лучшие цены...')
const selection = found.map(r => {
  const best = r.variants.reduce((min, v) =>
    v.цена_от_1т < min.цена_от_1т ? v : min
  )
  return {
    position: r.position,
    variant: { ...best, поисковый_запрос: r.position.поисковый_запрос }
  }
})

selection.forEach(s => {
  console.log(`  ${s.position.название} → ${s.variant.смц} (${s.variant.цена_от_1т})`)
})

const bases = [...new Set(selection.map(s => s.variant.смц))]
await onProgress(`💰 Выбраны лучшие цены. Базы: ${bases.join(', ')}`)

  // Фаза 3 — очищаем корзину перед добавлением
  await onProgress('🧹 Очищаю корзину...')
  const page = await getPage()
  await clearCart(page)

  // Фаза 4 — добавляем в корзину
  await onProgress('🛒 Добавляю позиции в корзину...')

// В processOrder передаём все варианты для fallback
for (const { position, variant, variants } of selection) {
  await onProgress(`🛒 Добавляю: ${position.название} → ${variant.смц}`)
  await addToCart(variant, position.количество, position.единица, variants)
  await delay(Math.random() * 1000 + 500)
}

  // Фаза 5 — оформляем заказ
  await onProgress('📋 Оформляю заказ...')
  const pdfPath = await placeOrder()

  return { pdfPath, selection, notFound, bases }
}

module.exports = { processOrder }