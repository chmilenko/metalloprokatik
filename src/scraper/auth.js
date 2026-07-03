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

  // Проверяем залогинены ли мы — если есть кнопка "Личный кабинет" с data-auth-link
  // значит не авторизованы
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

  // Нажимаем войти
await page.evaluate(() => {
  // Находим все кнопки submit и берём ту что содержит текст ВОЙТИ
  const buttons = document.querySelectorAll('button[type="submit"]')
  const loginBtn = Array.from(buttons).find(b => b.textContent.trim() === 'ВОЙТИ')
  if (loginBtn) loginBtn.click()
})
await delay(2000)
await page.waitForNavigation({ waitUntil: 'networkidle' })
  await page.waitForNavigation({ waitUntil: 'networkidle' })

  logger.info('Авторизация успешна')
}

module.exports = { authorize }