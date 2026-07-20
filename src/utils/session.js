/**
 * session.js
 * 
 * Хранит состояние диалога каждого пользователя.
 * Нужно чтобы бот помнил контекст между сообщениями.
 */

const sessions = new Map()

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {})
  }
  return sessions.get(userId)
}

function setSession(userId, data) {
  sessions.set(userId, { ...getSession(userId), ...data })
}

function clearSession(userId) {
  sessions.delete(userId)
}

module.exports = { getSession, setSession, clearSession }