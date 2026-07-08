/**
 * auth.js
 * 
 * Авторизация на mc.ru.
 * Проверяет залогинен ли пользователь — если нет, логинится.
 */

const logger = require('../utils/logger')
const { getPage } = require('./browser')

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function authorize() {
  const page = await getPage()

  logger.info('Проверяем авторизацию на mc.ru')
  await page.goto('https://mc.ru')
  await delay(Math.random() * 1000 + 500)

  // Если нет data-auth-link — значит уже авторизованы
  const isLoggedIn = await page.$('.headerCabinet[data-auth-link]')
    .then(el => el ? false : true)
    .catch(() => false)

  if (isLoggedIn) {
    logger.info('Уже авторизованы')
    return
  }

  logger.info('Выполняем вход...')

  // Кликаем на "Личный кабинет"
  await page.click('.headerCabinet')
  await delay(Math.random() * 800 + 400)

  // Вводим логин
  await page.fill('#logmein', process.env.MC_LOGIN)
  await delay(Math.random() * 500 + 200)

  // Вводим пароль
  await page.fill('#pswrd', process.env.MC_PASSWORD)
  await delay(Math.random() * 500 + 200)

  // Нажимаем войти через JS
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button[type="submit"]')
    const loginBtn = Array.from(buttons).find(b => b.textContent.trim() === 'ВОЙТИ')
    if (loginBtn) loginBtn.click()
  })

  // Ждём 3 секунды пока страница обновится
  await delay(3000)

  logger.info('Авторизация успешна')
}

module.exports = { authorize }