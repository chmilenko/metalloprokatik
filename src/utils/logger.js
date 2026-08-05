/**
 * logger.js
 *
 * Простой логгер для отслеживания работы бота.
 * Пишет время, уровень и сообщение в консоль И в файл (logs/bot.log).
 *
 * Запись в файл — в явной UTF-8, независимо от того, в какой кодировке
 * работает терминал/PowerShell. Раньше логи через `| tee bot.log` в
 * PowerShell превращались в кракозябры (Tee-Object пишет в своей
 * кодировке, не в той, что настроена через chcp) — теперь это не имеет
 * значения, файл всегда читаемый.
 */

const fs = require('fs')
const path = require('path')

const LOG_DIR = path.join(__dirname, '..', '..', 'logs')
const LOG_FILE = path.join(LOG_DIR, 'bot.log')

// Создаём папку logs, если её ещё нет
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
} catch (err) {
  // Если не получилось создать папку — не роняем бота из-за этого,
  // просто логи будут только в консоли
  console.error('Не удалось создать папку logs:', err.message)
}

function writeToFile(line) {
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', { encoding: 'utf8' })
  } catch (err) {
    // Не роняем бота, если вдруг файл недоступен для записи (занят,
    // нет прав и т.п.) — просто выводим ошибку один раз в консоль
    console.error('Не удалось записать лог в файл:', err.message)
  }
}

function log(level, message, data = {}) {
  const time = new Date().toISOString()
  const dataStr = Object.keys(data).length
    ? JSON.stringify(data)
    : ''
  const line = `[${time}] [${level}] ${message} ${dataStr}`

  console.log(line)
  writeToFile(line)
}

module.exports = {
  info: (msg, data) => log('INFO', msg, data),
  error: (msg, data) => log('ERROR', msg, data),
  warn: (msg, data) => log('WARN', msg, data),
}