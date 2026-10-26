/**
 * llm.js
 *
 * Абстрактный слой для работы с AI моделями.
 * По умолчанию — Claude Sonnet; модель можно переопределить:
 *   ANTHROPIC_MODEL — для всех вызовов;
 *   PARSER_MODEL    — только для разбора заявки (см. parser.js).
 *
 * Экономия: askAI(prompt, { system }) кладёт статичную инструкцию в system
 * с cache_control — Anthropic кэширует её на 5 минут, повторные вызовы
 * читают её из кэша (≈10% цены входных токенов). Использование токенов
 * пишется в лог и копится в статистика().
 */

const Anthropic = require('@anthropic-ai/sdk')

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

const МОДЕЛЬ_ПО_УМОЛЧАНИЮ = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'

// ── Учёт токенов (по моделям) ─────────────────────────────────────────
const итоги = {}
function учесть(модель, usage) {
  if (!usage) return
  const и = (итоги[модель] ||= { вызовов: 0, вход: 0, выход: 0, кэшЧтение: 0, кэшЗапись: 0 })
  и.вызовов++
  и.вход += usage.input_tokens || 0
  и.выход += usage.output_tokens || 0
  и.кэшЧтение += usage.cache_read_input_tokens || 0
  и.кэшЗапись += usage.cache_creation_input_tokens || 0
}
function статистика() {
  return JSON.parse(JSON.stringify(итоги))
}

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

/**
 * @param {string} prompt - сообщение пользователя
 * @param {object} [опции]
 * @param {string} [опции.system] - статичная инструкция (кэшируется)
 * @param {string} [опции.model] - переопределить модель для этого вызова
 * @param {number} [опции.maxTokens]
 */
async function askAI(prompt, опции = {}) {
  const модель = опции.model || МОДЕЛЬ_ПО_УМОЛЧАНИЮ
  const запрос = {
    model: модель,
    // Было 4000 — не хватало на заявки от ~20 позиций (особенно после
    // того, как добавили поле параметры.спецификация к каждой позиции,
    // это увеличило размер ответа). Ответ модели обрывался посреди JSON,
    // парсинг падал с ошибкой на весь текст (который к тому же ещё и не
    // помещался в сообщение Telegram — см. фикс в exportToExcel.js).
    max_tokens: опции.maxTokens || 8000,
    messages: [{ role: 'user', content: prompt }]
  }
  if (опции.system) {
    запрос.system = [{ type: 'text', text: опции.system, cache_control: { type: 'ephemeral' } }]
  }

  let response
  try {
    response = await client.messages.create(запрос)
  } catch (err) {
    await уведомитьОбОшибке(err)
    throw err
  }

  учесть(модель, response.usage)
  if (response.usage) {
    const u = response.usage
    console.log(`[LLM] ${модель}: вход ${u.input_tokens || 0}, кэш-чтение ${u.cache_read_input_tokens || 0}, кэш-запись ${u.cache_creation_input_tokens || 0}, выход ${u.output_tokens || 0}`)
  }

  return response.content[0].text
}

module.exports = { askAI, настроитьОтправителя, классифицироватьОшибку, статистика }