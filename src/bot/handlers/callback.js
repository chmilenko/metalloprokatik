/**
 * callback.js
 *
 * Обрабатывает нажатия на inline кнопки.
 */

const fs = require('fs')
const logger = require('../../utils/logger')
const { getSession, setSession, clearSession } = require('../../utils/session')
const { placeOrder } = require('../../scraper/order')
const { finalizeOrder, вариантПоПозицииИзРекомендации } = require('../../scraper/index')
const { подбериБазу } = require('../../scraper/baseOptimizer')
const { sendOrderSummary, askBaseConfirmation } = require('./message')
const { handleBasePriorityCallback } = require('./basePriority')
const { getBasePriority } = require('../../utils/basePriorityStore')

// Сколько раз подряд можно отказаться от предложенной базы, прежде чем
// бот перестанет предлагать новые варианты и попросит разобраться вручную
const МАКС_ОТКАЗОВ_ПО_БАЗЕ = 3

async function handleCallback(ctx) {
  const data = ctx.callbackQuery.data
  const userId = ctx.from.id
  const session = getSession(userId)

  // Настройка приоритета баз (/bases) — отдельный, независимый флоу
  if (data.startsWith('baseprio:')) {
    return handleBasePriorityCallback(ctx)
  }

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
        { source: fs.createReadStream(pdfPath), filename: 'Счет_mc.ru.pdf' },
        { caption: '✅ Заказ оформлен! Счёт во вложении.' }
      )
    } catch (err) {
      logger.error('Ошибка оформления заказа', { userId, error: err.message })
      await ctx.reply(`❌ Ошибка при оформлении: ${err.message}`)
    }

  } else if (data === 'cancel_order') {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] })
    clearSession(userId)
    await ctx.reply('❌ Заказ отменён.')

    try {
      const { clearCart } = require('../../scraper/order')
      const { getPage } = require('../../scraper/browser')
      const page = await getPage()
      await clearCart(page)
    } catch (err) {
      logger.error('Ошибка очистки корзины', { error: err.message })
    }

  } else if (data === 'base_yes') {
    if (!session.awaitingBaseConfirmation) {
      await ctx.reply('❌ Нет активного вопроса про базу.')
      return
    }

    await ctx.editMessageReplyMarkup({ inline_keyboard: [] })
    await ctx.reply('🛒 Собираю корзину...')

    const {
      baseFound: found,
      baseNotFound: notFound,
      baseNeedHelp: needHelp,
      baseRecommendation,
      baseOrder: order,
      needHelpList,
    } = session

    try {
      const вариантПоПозиции = вариантПоПозицииИзРекомендации(baseRecommendation)
      const result = await finalizeOrder(
        found,
        вариантПоПозиции,
        notFound,
        needHelp,
        async (message) => { await ctx.reply(message) },
        order
      )

      const всегоПозиций = found.length + notFound.length + needHelp.length
      await sendOrderSummary(ctx, userId, order, result, всегоПозиций, needHelpList)
    } catch (err) {
      logger.error('Ошибка при заполнении корзины после подтверждения базы', {
        userId, error: err.message, stack: err.stack,
      })
      await ctx.reply(`❌ Ошибка: ${err.message}`)
      clearSession(userId)
    }

  } else if (data === 'base_no') {
    if (!session.awaitingBaseConfirmation) {
      await ctx.reply('❌ Нет активного вопроса про базу.')
      return
    }

    await ctx.editMessageReplyMarkup({ inline_keyboard: [] })

    const исключённые = [...(session.baseExcluded || [])]
    const отклонённаяБаза = session.baseRecommendation.тип === 'одна_база'
      ? session.baseRecommendation.база
      : null
    if (отклонённаяБаза) исключённые.push(отклонённаяБаза)

    if (исключённые.length >= МАКС_ОТКАЗОВ_ПО_БАЗЕ) {
      await ctx.reply(
        '🤷 Больше вариантов баз для автоматического подбора нет. ' +
        'Разберите заказ вручную на mc.ru — корзина пока не заполнена.'
      )
      clearSession(userId)
      return
    }

    const новаяРекомендация = подбериБазу(session.baseFound, исключённые, getBasePriority())

    if (новаяРекомендация.тип === 'нет_позиций' ||
        (новаяРекомендация.тип === 'несколько_баз' && новаяРекомендация.непокрытыеПозиции?.length > 0 && исключённые.length > 0)) {
      // Совсем не осталось вариантов — просим разобраться вручную
      await ctx.reply(
        '🤷 Не получается подобрать базу автоматически. ' +
        'Разберите заказ вручную на mc.ru — корзина пока не заполнена.'
      )
      clearSession(userId)
      return
    }

    setSession(userId, {
      ...session,
      baseRecommendation: новаяРекомендация,
      baseExcluded: исключённые,
    })

    await askBaseConfirmation(ctx, новаяРекомендация)
  }
}

module.exports = { handleCallback }