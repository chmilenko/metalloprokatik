/**
 * auth.js
 * 
 * Проверка доступа пользователя к боту.
 * Только пользователи из ALLOWED_USERS могут использовать бота.
 */

function isAllowed(userId) {
  const allowed = process.env.ALLOWED_USERS
    ? process.env.ALLOWED_USERS.split(',').map(id => id.trim())
    : []
  return allowed.includes(String(userId))
}

module.exports = { isAllowed }