// Сравнение моделей на разборе заявок. Запуск из корня проекта:
//   node test_parser_models.js zayavki.txt
// zayavki.txt — реальные заявки, разделённые строкой из трёх дефисов (---).
// Для каждой заявки разбор идёт на Sonnet (эталон) и Haiku; печатаются расхождения
// по ключевым полям и примерная стоимость. Нужен ANTHROPIC_API_KEY (.env подхватывается, если есть dotenv).
try { require('dotenv').config() } catch (_) {}
const fs = require('fs')

const ЭТАЛОН = process.env.REF_MODEL || 'claude-sonnet-4-6'
const ДЕШЁВАЯ = process.env.CHEAP_MODEL || 'claude-haiku-4-5-20251001'
// $ за 1 млн токенов (ориентировочно): [вход, выход]
const ЦЕНЫ = { 'claude-sonnet-4-6': [3, 15], 'claude-haiku-4-5-20251001': [1, 5] }

const файл = process.argv[2]
if (!файл) { console.error('Укажите файл с заявками: node test_parser_models.js zayavki.txt'); process.exit(1) }
const заявки = fs.readFileSync(файл, 'utf8').split(/\r?\n-{3,}\r?\n/).map((s) => s.trim()).filter(Boolean)

const { parseOrder } = require('./src/agent/parser')
const llm = require('./src/agent/llm')
const статистика = typeof llm.статистика === 'function' ? llm.статистика : null

const ПОЛЯ = ['поисковый_запрос', 'количество', 'единица']
const ПАРАМЕТРЫ = ['ду', 'диаметр', 'стенка', 'толщина', 'ширина', 'длина_листа', 'длина', 'номер', 'марка']
const норм = (v) => (v === undefined || v === '' ? null : v)

function сравни(a, b) {
  const расх = []
  if (a.length !== b.length) расх.push(`число позиций: ${a.length} vs ${b.length}`)
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    for (const п of ПОЛЯ) if (String(норм(a[i][п])).toLowerCase() !== String(норм(b[i][п])).toLowerCase()) расх.push(`#${i + 1} ${п}: "${a[i][п]}" vs "${b[i][п]}"`)
    for (const п of ПАРАМЕТРЫ) {
      const x = норм((a[i].параметры || {})[п]), y = норм((b[i].параметры || {})[п])
      if (String(x).toLowerCase() !== String(y).toLowerCase()) расх.push(`#${i + 1} параметры.${п}: ${x} vs ${y}`)
    }
  }
  return расх
}

;(async () => {
  const log = console.log
  let всегоРасхождений = 0
  for (const [n, текст] of заявки.entries()) {
    console.log = () => {} // глушим подробный лог парсера
    let a, b
    try {
      process.env.PARSER_MODEL = ЭТАЛОН; a = await parseOrder(текст)
      process.env.PARSER_MODEL = ДЕШЁВАЯ; b = await parseOrder(текст)
    } catch (e) { console.log = log; log(`Заявка ${n + 1}: ошибка ${e.message}`); continue }
    console.log = log
    const р = сравни(a, b)
    всегоРасхождений += р.length
    log(`\nЗаявка ${n + 1} (${a.length} поз.): ${р.length ? р.length + ' расхождений' : 'совпадает'}`)
    р.forEach((x) => log('   ' + x))
  }
  if (!статистика) {
    log('\nsrc/agent/llm.js старой версии (нет учёта токенов и кэша) — положите новый llm.js и parser.js из последней отправки, тогда здесь появится стоимость.')
    return
  }
  const ст = статистика()
  log('\n=== Токены и примерная стоимость ===')
  for (const [м, и] of Object.entries(ст)) {
    const [pi, po] = ЦЕНЫ[м] || [0, 0]
    const $ = (и.вход * pi + и.кэшЗапись * pi * 1.25 + и.кэшЧтение * pi * 0.1 + и.выход * po) / 1e6
    log(`${м}: вызовов ${и.вызовов}, вход ${и.вход}, кэш-чтение ${и.кэшЧтение}, кэш-запись ${и.кэшЗапись}, выход ${и.выход} → ~$${$.toFixed(4)}`)
  }
  log(всегоРасхождений ? `\nИтого расхождений: ${всегоРасхождений}` : '\nРасхождений нет')
})()