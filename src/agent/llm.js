/**
 * llm.js
 * 
 * Абстрактный слой для работы с AI моделями.
 * Сейчас используем Claude Sonnet — основная модель для прода.
 */

const Anthropic = require('@anthropic-ai/sdk')

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

// ── Уведомление админа о проблемах с Anthropic API ────────────────────
// Если кредиты закончились или ключ недействителен, заявки перестают
// разбираться, а менеджер видит лишь невнятную ошибку. Шлём админу
// понятное сообщение, но не чаще раза в 6 часов на один вид проблемы.
let отправитьАдмину = null
const последнийАлерт = {}
const ПАУЗА_АЛЕРТА_МС = 6 * 60 * 60 * 1000

function настроитьОтправителя(fn) {
  отправитьАдмину = fn
}

function классифицироватьОшибку(err) {
  const статус = err && err.status
  const текст = String(
    (err && err.error && err.error.error && err.error.error.message) ||
    (err && err.message) || ''
  ).toLowerCase()
  if (текст.includes('credit balance') || текст.includes('billing') ||
      текст.includes('purchase credits')) {
    return { вид: 'кредиты', текст: '💳 Закончились кредиты Anthropic API — заявки не разбираются. Пополните баланс: console.anthropic.com → Plans & Billing.' }
  }
  if (статус === 401 || статус === 403) {
    return { вид: 'ключ', текст: '🔑 Anthropic API отклонил ключ (ANTHROPIC_API_KEY недействителен или без доступа) — заявки не разбираются.' }
  }
  if (статус === 429) {
    return { вид: 'лимит', текст: '⏳ Anthropic API: превышен лимит запросов (429). Если повторяется — проверьте лимиты в консоли Anthropic.' }
  }
  return null
}

async function уведомитьОбОшибке(err) {
  const вид = классифицироватьОшибку(err)
  if (!вид || !отправитьАдмину) return
  const сейчас = Date.now()
  if (последнийАлерт[вид.вид] && сейчас - последнийАлерт[вид.вид] < ПАУЗА_АЛЕРТА_МС) return
  последнийАлерт[вид.вид] = сейчас
  try {
    await отправитьАдмину(вид.текст)
  } catch (e) {
    console.error('Не удалось отправить алерт про Anthropic:', e.message)
  }
}

async function askAI(prompt) {
  let response
  try {
    response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    // Было 4000 — не хватало на заявки от ~20 позиций (особенно после
    // того, как добавили поле параметры.спецификация к каждой позиции,
    // это увеличило размер ответа). Ответ модели обрывался посреди JSON,
    // парсинг падал с ошибкой на весь текст (который к тому же ещё и не
    // помещался в сообщение Telegram — см. фикс в exportToExcel.js).
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }]
    })
  } catch (err) {
    await уведомитьОбОшибке(err)
    throw err
  }

  return response.content[0].text
}

module.exports = { askAI, настроитьОтправителя, классифицироватьОшибку }