/**
 * basePriorityStore.js
 *
 * Хранит настраиваемый менеджером приоритет баз (складов) в
 * data/basePriority.json. Раньше приоритет был жёстко зашит в
 * baseOptimizer.js — теперь менеджер сам может его переставлять через
 * команду /bases (см. bot/handlers/basePriority.js), например сегодня
 * "в первую очередь Очаково", а завтра "в первую очередь Электроугли".
 */

const fs = require('fs')
const path = require('path')

const FILE_PATH = path.join(__dirname, '..', '..', 'data', 'basePriority.json')

// Дефолт — тот же порядок, что менеджер называл изначально
const ДЕФОЛТНЫЙ_ПРИОРИТЕТ = ['Карачарово', 'Очаково', 'Балашиха', 'Электроугли']

// Полный список баз, которые реально встречаются в заявках — из них
// менеджер выбирает и расставляет порядок через /bases
const ИЗВЕСТНЫЕ_БАЗЫ = [
  'Карачарово', 'Очаково', 'Балашиха', 'Электроугли',
  'Подольск', 'Лобня', 'Коровино', 'Капотня', 'Софийская'
]

function getBasePriority() {
  try {
    if (!fs.existsSync(FILE_PATH)) return [...ДЕФОЛТНЫЙ_ПРИОРИТЕТ]
    const данные = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'))
    if (Array.isArray(данные.приоритет) && данные.приоритет.length > 0) {
      return данные.приоритет
    }
    return [...ДЕФОЛТНЫЙ_ПРИОРИТЕТ]
  } catch (err) {
    console.error('Не удалось прочитать приоритет баз, использую дефолт:', err.message)
    return [...ДЕФОЛТНЫЙ_ПРИОРИТЕТ]
  }
}

function setBasePriority(список) {
  try {
    const dir = path.dirname(FILE_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    fs.writeFileSync(
      FILE_PATH,
      JSON.stringify({ приоритет: список, обновлено: new Date().toISOString() }, null, 2),
      'utf8'
    )
    return true
  } catch (err) {
    console.error('Не удалось сохранить приоритет баз:', err.message)
    return false
  }
}

module.exports = { getBasePriority, setBasePriority, ИЗВЕСТНЫЕ_БАЗЫ, ДЕФОЛТНЫЙ_ПРИОРИТЕТ }