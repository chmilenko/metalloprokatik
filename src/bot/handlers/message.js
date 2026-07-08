/**
 * handlers/message.js
 * 
 * Обрабатывает входящие заявки от менеджера.
 * Полный цикл: парсинг → оптимизация баз → корзина → PDF → отправка.
 */

const logger = require('../../utils/logger')
const { parseOrder } = require('../../agent/parser')
const { processOrder } = require('../../scraper/index')

async function handleMessage(ctx) {
  const text = ctx.message.text
  const userId = ctx.from.id

  logger.info('Получена заявка', { userId, text })

  await ctx.reply('🔍 Анализирую заявку...')

  try {
    // Шаг 1 — парсим заявку через AI
    const positions = await parseOrder(text)
    await ctx.reply(`✅ Нашёл ${positions.length} позиций. Начинаю поиск на mc.ru...`)

    // Шаг 2 — полный цикл обработки
    const { pdfPath, selection, notFound, bases } = await processOrder(
      positions,
      async (message) => {
        await ctx.reply(message)
      }
    )

    // Шаг 3 — итоговая сводка
    let summary = `📊 Итог:\n\n`

    selection.forEach((s, i) => {
      const total = (s.variant.цена_от_1т * s.position.количество).toLocaleString('ru')
      summary += `${i + 1}. ${s.position.название}\n`
      summary += `   ${s.position.количество} ${s.position.единица} × ${s.variant.цена_от_1т.toLocaleString('ru')} руб/т\n`
      summary += `   База: ${s.variant.смц}\n`
      summary += `   Сумма: ${total} руб\n\n`
    })

    if (notFound.length > 0) {
      summary += `❌ Не найдено (${notFound.length}):\n`
      notFound.forEach(p => {
        summary += `   • ${p.название}\n`
      })
    }

    await ctx.reply(summary)

    // Шаг 4 — отправляем PDF
    await ctx.replyWithDocument(
      { source: pdfPath, filename: 'Счет_mc.ru.pdf' },
      { caption: `✅ Счёт готов! Базы: ${bases.join(', ')}` }
    )

  } catch (err) {
    logger.error('Ошибка обработки заявки', { userId, error: err.message })
    await ctx.reply(`❌ Ошибка: ${err.message}`)
  }
}

module.exports = { handleMessage }