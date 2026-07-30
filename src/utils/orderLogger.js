/**
 * orderLogger.js
 * Детальное логирование каждой заявки с уникальным ID.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const LOG_DIR = path.join(__dirname, '../../logs')
const ORDERS_FILE = path.join(LOG_DIR, 'orders.json')

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
}

function generateOrderId() {
  return crypto.randomBytes(3).toString('hex')
}

function createOrder(userId, username, text) {
  const order = {
    id: generateOrderId(),
    время: new Date().toISOString(),
    userId,
    username: username || 'неизвестен',
    текст_заявки: text,
    парсинг: [],
    поиск: [],
    корзина: [],
    итог: {
      найдено: 0,
      не_найдено: 0,
      всего: 0,
      время_обработки_сек: 0,
      номер_заказа: null,
      статус: 'в процессе'
    }
  }
  saveOrder(order)
  return order
}

function saveOrder(order) {
  let orders = loadOrders()
  const index = orders.findIndex(o => o.id === order.id)
  if (index >= 0) {
    orders[index] = order
  } else {
    orders.push(order)
  }
  if (orders.length > 500) orders = orders.slice(-500)
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2))
}

function loadOrders() {
  if (!fs.existsSync(ORDERS_FILE)) return []
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8')) } catch { return [] }
}

function getOrder(orderId) {
  return loadOrders().find(o => o.id === orderId)
}

function getRecentOrders(limit = 10) {
  return loadOrders().slice(-limit).reverse()
}

function logOrder(order) {
  const logFile = path.join(LOG_DIR, `orders_${new Date().toISOString().split('T')[0]}.log`)
  const lines = [
    `═══════════════════════════════════════════`,
    `ЗАЯВКА #${order.id} | ${new Date(order.время).toLocaleString('ru')}`,
    `Пользователь: @${order.username} (${order.userId})`,
    `═══════════════════════════════════════════`,
    ``,
    `ПАРСИНГ: ${order.парсинг.length} позиций`,
    ...order.парсинг.map((p, i) => `  ${i + 1}. ${p.название} → "${p.поисковый_запрос}"`),
    ``,
    `ПОИСК:`,
    ...order.поиск.map(s => {
      const icon = s.статус === 'найдено' ? '✅' : '❌'
      const выбран = s.выбран ? ` → ${s.выбран.смц} | ${s.выбран.цена?.toLocaleString('ru')} руб/т` : ''
      return `  ${icon} ${s.название}${выбран}`
    }),
    ``,
    `ИТОГ: ${order.итог.найдено}/${order.итог.всего} | ${order.итог.время_обработки_сек}с | ${order.итог.статус}`,
    `═══════════════════════════════════════════`,
    ``
  ]
  fs.appendFileSync(logFile, lines.join('\n') + '\n')
}

module.exports = { createOrder, saveOrder, getOrder, getRecentOrders, logOrder }