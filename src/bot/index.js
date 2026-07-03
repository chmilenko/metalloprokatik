/**
 * bot/index.js
 * 
 * Точка входа Telegram бота.
 * Инициализирует бота и подключает обработчики сообщений.
 */

require('dotenv').config()
const { Telegraf } = require('telegraf')
const logger = require('../utils/logger')
const { handleMessage } = require('./handlers/message')
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN)

// Обработка текстовых сообщений
bot.on('text', handleMessage)

// Обработка ошибок
bot.catch((err, ctx) => {
  logger.error('Ошибка бота', { error: err.message })
  ctx.reply('Что-то пошло не так. Попробуйте снова.')
})

// Запуск
bot.launch()
logger.info('Бот запущен')

// Корректное завершение при остановке
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

