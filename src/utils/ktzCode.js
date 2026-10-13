/**
 * ktzCode.js
 *
 * Получение кода подтверждения КТЗ через Telegram.
 *
 * Как это работает:
 *   1. auth-ktz.js видит, что КТЗ показал форму кода → вызывает
 *      запроситьКод(): админу уходит сообщение "пришли код", а вызов
 *      ждёт (с таймаутом) — НЕ вечно.
 *   2. Админ отвечает сообщением с цифрами → bot/index.js передаёт текст
 *      в передатьКод() → ожидание завершается, auth-ktz вводит код в форму.
 *   3. Если код не пришёл за таймаут — запроситьКод() бросает ошибку, и
 *      обработчик /order честно сообщает "не удалось авторизоваться на КТЗ"
 *      (mc.ru оформляется дальше), а не зависает.
 *
 * Отправитель сообщений задаёт bot/index.js (настроитьОтправителя), чтобы
 * этот модуль не зависел от Telegraf.
 */

const logger = require('./logger')

let ожидание = null // { promise, resolve, reject, timer }
let отправитель = null

function настроитьОтправителя(fn) {
  отправитель = typeof fn === 'function' ? fn : null
}

function доступенTelegram() {
  return отправитель !== null
}

function ждётКод() {
  return ожидание !== null
}

async function запроситьКод({ сообщение, таймаутМс = 5 * 60 * 1000 } = {}) {
  if (!отправитель) throw new Error('Отправитель сообщений в Telegram не настроен')

  // Уже ждём код (например, второй запрос подряд) — присоединяемся к тому же ожиданию
  if (ожидание) return ожидание.promise

  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })

  const timer = setTimeout(() => {
    if (ожидание && ожидание.promise === promise) ожидание = null
    reject(new Error(`код подтверждения КТЗ не получен за ${Math.round(таймаутМс / 60000)} мин`))
  }, таймаутМс)

  ожидание = { promise, resolve, reject, timer }

  try {
    await отправитель(сообщение)
    logger.info('КТЗ: запросили код подтверждения у администратора в Telegram')
  } catch (err) {
    clearTimeout(timer)
    ожидание = null
    reject(new Error(`не удалось отправить запрос кода в Telegram: ${err.message}`))
  }

  return promise
}

/**
 * Вызывается из bot/index.js для КАЖДОГО текстового сообщения админа,
 * пока ждём код. Возвращает true, если текст принят как код (сообщение
 * "съедено"), false — если это не код и его надо обработать как обычно.
 */
function передатьКод(текст) {
  if (!ожидание) return false
  const строка = String(текст || '').trim()
  // Принимаем только сообщения, состоящие из цифр/пробелов/дефисов —
  // обычный текст (например, команду) не считаем кодом
  if (!/^[\s\d-]+$/.test(строка)) return false
  const цифры = строка.replace(/\D/g, '')
  if (!/^\d{4,8}$/.test(цифры)) return false

  const { resolve, timer } = ожидание
  clearTimeout(timer)
  ожидание = null
  resolve(цифры)
  return true
}

module.exports = { настроитьОтправителя, доступенTelegram, ждётКод, запроситьКод, передатьКод }