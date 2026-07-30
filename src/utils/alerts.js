/**
 * alerts.js
 * Отправляет алерты об ошибках администратору в Telegram.
 */

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID

async function sendAlert(bot, message) {
  if (!ADMIN_ID || !bot) return
  try {
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `🚨 *Ошибка в боте*\n\n${message}`,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    console.error('Не смог отправить алерт:', err.message)
  }
}

module.exports = { sendAlert }