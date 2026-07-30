/**
 * feedback.js
 * Сохраняет обратную связь от пользователей.
 */

const fs = require('fs')
const path = require('path')

const FEEDBACK_PATH = path.join(__dirname, '../../logs/feedback.json')

function saveFeedback(userId, username, text) {
  const dir = path.dirname(FEEDBACK_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  let feedback = []
  if (fs.existsSync(FEEDBACK_PATH)) {
    try { feedback = JSON.parse(fs.readFileSync(FEEDBACK_PATH, 'utf-8')) } catch { feedback = [] }
  }

  feedback.push({
    время: new Date().toISOString(),
    userId,
    username: username || 'неизвестен',
    текст: text
  })

  fs.writeFileSync(FEEDBACK_PATH, JSON.stringify(feedback, null, 2))
}

function getFeedback() {
  if (!fs.existsSync(FEEDBACK_PATH)) return []
  try { return JSON.parse(fs.readFileSync(FEEDBACK_PATH, 'utf-8')) } catch { return [] }
}

module.exports = { saveFeedback, getFeedback }