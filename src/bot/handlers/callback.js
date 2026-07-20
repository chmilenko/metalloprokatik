/**
 * callback.js
 * 
 * Обрабатывает нажатия на inline кнопки.
 */

const logger = require('../../utils/logger')
const { getSession, clearSession } = require('../../utils/session')
const { placeOrder } = require('../../scraper/order')

async function handleCallback(ctx) {
  const data = ctx.callbackQuery.data
  const userId = ctx.from.id
  const session = getSession(userId)

  await ctx.answerCbQuery()

  if (data === 'confirm_order') {
    if (!session.awaitingConfirmation) {
      await ctx.reply('❌ Нет активного заказа для оформления.')
      return
    }

    await ctx.editMessageReplyMarkup({ inline_keyboard: [] })
    await ctx.reply('📋 Оформляю заказ...')

    try {
      const pdfPath = await placeOrder()
      clearSession(userId)

      await ctx.replyWithDocument(
        { source: pdfPath, filename: 'Счет_mc.ru.pdf' },
        { caption: '✅ Заказ оформлен! Счёт во вложении.' }
      )
    } catch (err) {
      logger.error('Ошибка оформления заказа', { userId, error: err.message })
      await ctx.reply(`❌ Ошибка при оформлении: ${err.message}`)
    }

  } else if (data === 'cancel_order') {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] })
    clearSession(userId)
    await ctx.reply('❌ Заказ отменён. Корзина очищена.')

    // Очищаем корзину
    try {
      const { clearCart } = require('../../scraper/order')
      const { getPage } = require('../../scraper/browser')
      const page = await getPage()
      await clearCart(page)
    } catch (err) {
      logger.error('Ошибка очистки корзины', { error: err.message })
    }
  }
}

module.exports = { handleCallback }