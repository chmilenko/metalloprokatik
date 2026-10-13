/**
 * utils/orderCheckpoint.js
 *
 * Персистентный чекпоинт заказа /order — переживает рестарт бота.
 * Пишется в downloads/order-checkpoint-<userId>.json ПОСЛЕ каждого
 * атомарного шага (добавление одной позиции в корзину, оформление
 * КП/счёта), поэтому даже "тихий" краш (unhandled reject, убитый
 * процесс) оставляет на диске точную картину — что уже сделано, что
 * осталось. Резюме подхватывает именно с этого места, а не с начала.
 */

const fs = require('fs')
const path = require('path')
const logger = require('./logger')

const ДИРЕКТОРИЯ = path.join(__dirname, '../../downloads')

function путьЧекпоинта(userId) {
  return path.join(ДИРЕКТОРИЯ, `order-checkpoint-${userId}.json`)
}

function сохраниЧекпоинт(userId, чекпоинт) {
  if (!fs.existsSync(ДИРЕКТОРИЯ)) fs.mkdirSync(ДИРЕКТОРИЯ, { recursive: true })
  const данные = { ...чекпоинт, userId, обновлён: Date.now() }
  // Пишем во временный файл и переименовываем — атомарно на уровне ФС,
  // чтобы краш ПОСЕРЕДИНЕ записи не оставил битый/половинный JSON,
  // который потом не распарсится при попытке резюме.
  const финальныйПуть = путьЧекпоинта(userId)
  const временныйПуть = `${финальныйПуть}.tmp`
  fs.writeFileSync(временныйПуть, JSON.stringify(данные, null, 2))
  fs.renameSync(временныйПуть, финальныйПуть)
}

function получиЧекпоинт(userId) {
  const путь = путьЧекпоинта(userId)
  if (!fs.existsSync(путь)) return null
  try {
    return JSON.parse(fs.readFileSync(путь, 'utf-8'))
  } catch (err) {
    logger.error('Не удалось прочитать чекпоинт заказа — повреждён файл', {
      userId, error: err.message,
    })
    return null
  }
}

function удалиЧекпоинт(userId) {
  const путь = путьЧекпоинта(userId)
  if (fs.existsSync(путь)) fs.unlinkSync(путь)
}

// Для старта бота — найти ВСЕ незавершённые чекпоинты (могут быть от
// разных пользователей), чтобы предложить резюме каждому.
function найдиВсеЧекпоинты() {
  if (!fs.existsSync(ДИРЕКТОРИЯ)) return []
  return fs.readdirSync(ДИРЕКТОРИЯ)
    .filter((f) => f.startsWith('order-checkpoint-') && f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(ДИРЕКТОРИЯ, f), 'utf-8'))
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

module.exports = { сохраниЧекпоинт, получиЧекпоинт, удалиЧекпоинт, найдиВсеЧекпоинты }