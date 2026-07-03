/**
 * handlers/message.js
 * 
 * Обрабатывает входящие заявки от менеджера.
 * Парсит текст через Claude → показывает найденные позиции.
 */

const logger = require('../../utils/logger')
const { parseOrder } = require('../../agent/parser')

async function handleMessage(ctx) {
  const text = ctx.message.text
  const userId = ctx.from.id

  logger.info('Получена заявка', { userId, text })

  // Сообщаем что начали обработку
  await ctx.reply('🔍 Анализирую заявку...')

  try {
    const positions = await parseOrder(text)

    // Формируем ответ
    let reply = `✅ Нашёл ${positions.length} позиций:\n\n`

    positions.forEach((pos, i) => {
      reply += `${i + 1}. ${pos.название}\n`
      reply += `   Количество: ${pos.количество} ${pos.единица}\n`
      reply += `   Поиск на сайте: "${pos.поисковый_запрос}"\n\n`
    })

    await ctx.reply(reply)
    logger.info('Заявка распарсена', { userId, count: positions.length })

  } catch (err) {
    logger.error('Ошибка парсинга', { userId, error: err.message })
    await ctx.reply('❌ Не смог разобрать заявку. Попробуй написать позиции чётче.')
  }
}

module.exports = { handleMessage }