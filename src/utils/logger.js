/**
 * logger.js
 * 
 * Простой логгер для отслеживания работы бота.
 * Пишет время, уровень и сообщение в консоль.
 */

function log(level, message, data = {}) {
  const time = new Date().toISOString()
  const dataStr = Object.keys(data).length 
    ? JSON.stringify(data) 
    : ''
  console.log(`[${time}] [${level}] ${message} ${dataStr}`)
}

module.exports = {
  info: (msg, data) => log('INFO', msg, data),
  error: (msg, data) => log('ERROR', msg, data),
  warn: (msg, data) => log('WARN', msg, data),
}