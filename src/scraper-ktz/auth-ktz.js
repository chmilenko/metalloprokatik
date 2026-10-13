/**
 * auth-ktz.js
 *
 * Авторизация на КТЗ. В отличие от mc.ru (отдельная страница логина,
 * без кода подтверждения) — тут ДВА усложнения:
 *   1. Форма логина всплывает МОДАЛЬНО (кликом по "Личный кабинет" на
 *      главной), а не отдельной страницей.
 *   2. После ввода логина/пароля сайт запрашивает КОД ПОДТВЕРЖДЕНИЯ
 *      (2FA) — автоматически ввести его мы не можем (это код из
 *      SMS/почты, у нас нет программного доступа туда). Поэтому вместо
 *      попытки автоматизировать 2FA целиком — сохраняем сессию на диск
 *      ПОСЛЕ первого ручного входа, и переиспользуем её при следующих
 *      запусках. Код подтверждения вводится вручную только один раз
 *      (или изредка, когда сохранённая сессия истечёт).
 *
 * Логин/пароль — из .env: KTZ_LOGIN, KTZ_PASSWORD.
 */

const readline = require("readline");
const path = require("path");
const fs = require("fs");
const logger = require("../utils/logger");
const { getBrowser, setPage } = require("../scraper/browser");
const ktzCode = require("../utils/ktzCode");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HOME_URL = "https://ktzholding.com/";
const CART_URL = "https://ktzholding.com/cart";
const SESSION_PATH = path.join(__dirname, "../../downloads/ktz-session.json");

function ждиВводаВКонсоли(вопрос) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(вопрос, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Возвращает готовую авторизованную страницу КТЗ. Порядок действий:
 *   1. Если есть сохранённая сессия на диске — пробуем её (открываем
 *      /cart, смотрим, не редиректнуло ли на главную — если нет, сессия
 *      ещё жива, дальше логиниться не нужно).
 *   2. Если сессии нет или она протухла — идём на полный вход, ждём
 *      РУЧНОГО ввода кода подтверждения (сайт запрашивает при первом
 *      входе — автоматически мы это не вводим), затем сохраняем
 *      получившуюся сессию на диск для следующих запусков.
 * @returns {Promise<import('playwright').Page>}
 */
// Вводит код подтверждения в форму — 6 (или сколько окажется) отдельных
// полей по одной цифре каждое. Ищем по подстроке класса "codeInput" (не
// по автогенерируемым id вида "_r_13_" — та же осторожность, что и
// везде в этом файле). Код передаётся строкой цифр, дефисы/пробелы
// внутри игнорируются ("123456" и "123-456" — одно и то же).
async function введиКодПодтверждения(page, code) {
  const цифры = String(code).replace(/[^0-9]/g, "").split("");

  const поля = await page.locator('[class*="codeInputWrapper"] input').all();

  if (поля.length === 0) {
    throw new Error("Не нашли поля ввода кода подтверждения на странице");
  }
  if (поля.length !== цифры.length) {
    logger.warn("КТЗ: число полей кода не совпадает с длиной кода", {
      полейНаСтранице: поля.length,
      цифрВКоде: цифры.length,
    });
  }

  for (let i = 0; i < Math.min(поля.length, цифры.length); i++) {
    await поля[i].fill("").catch(() => {});
    await поля[i].click();
    await page.keyboard.type(цифры[i], { delay: 60 });
    await delay(100);
  }

  await delay(500);
  logger.info("КТЗ: код подтверждения введён");
}

const ПОЛЯ_КОДА = '[class*="codeInputWrapper"] input';
const ПОПЫТОК_КОДА = 3;

async function формаКодаВидна(page, timeout) {
  try {
    await page.locator(ПОЛЯ_КОДА).first().waitFor({ state: "visible", timeout });
    return true;
  } catch (e) {
    return false;
  }
}

async function формаКодаИсчезла(page, timeout) {
  try {
    await page.locator(ПОЛЯ_КОДА).first().waitFor({ state: "hidden", timeout });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Если КТЗ показал форму кода подтверждения — получает код и вводит его.
 *
 * С настроенным Telegram (ktzCode): просит код у администратора в чате,
 * ждёт до 5 минут, вводит, при неверном коде просит ещё раз (всего
 * ПОПЫТОК_КОДА). Без Telegram (запуск вручную из консоли) — прежнее
 * поведение: ждём Enter в терминале, пока код введут в окне браузера.
 *
 * опции.приЗапросеКода — необязательный колбэк (например, сообщить
 * менеджеру "жду код от администратора").
 */
async function подтвердиВходКодом(page, опции = {}) {
  if (!ktzCode.доступенTelegram()) {
    console.log("\n⏸  Сайт запросил код подтверждения (если запросил).");
    console.log("   Введите его В ОКНЕ БРАУЗЕРА вручную, дождитесь входа,");
    console.log("   затем вернитесь сюда и нажмите Enter, чтобы продолжить.\n");
    await ждиВводаВКонсоли("Нажмите Enter после входа в браузере... ");
    return;
  }

  for (let попытка = 1; попытка <= ПОПЫТОК_КОДА; попытка++) {
    // Первый раз форма кода появляется не мгновенно; в следующие разы
    // она либо уже на экране (код не подошёл), либо её нет (код принят)
    const видна = await формаКодаВидна(page, попытка === 1 ? 8000 : 2000);
    if (!видна) {
      logger.info("КТЗ: форма кода подтверждения не показана — код не нужен или уже принят", { попытка });
      return;
    }

    if (typeof опции.приЗапросеКода === "function") {
      try {
        await опции.приЗапросеКода(попытка);
      } catch (e) {
        logger.warn("КТЗ: колбэк приЗапросеКода упал", { error: e.message });
      }
    }

    const сообщение =
      попытка === 1
        ? "🔐 КТЗ запросил код подтверждения входа.\nПришли код (только цифры) ответным сообщением — у тебя 5 минут."
        : `⚠️ КТЗ не принял код (попытка ${попытка - 1} из ${ПОПЫТОК_КОДА}).\nПришли новый код — у тебя 5 минут.`;

    const код = await ktzCode.запроситьКод({ сообщение });
    await введиКодПодтверждения(page, код);

    // Форма кода (реальная вёрстка КТЗ): кнопка «Отправить» неактивна, пока
    // не введены все цифры, и её нужно нажать. На случай, если форма
    // закроется сама после последней цифры — сначала коротко проверяем это.
    if (await формаКодаИсчезла(page, 1500)) return;

    const кнопка = page
      .locator('button[type="submit"]', { hasText: /Отправить|Подтвердить|Продолжить/i })
      .first();
    try {
      await кнопка.click({ timeout: 5000 }); // click сам дожидается, пока кнопка станет активной
    } catch (e) {
      logger.warn("КТЗ: не удалось нажать кнопку отправки кода", { error: e.message.split("\n")[0] });
    }
    if (await формаКодаИсчезла(page, 8000)) return;

    logger.warn("КТЗ: форма кода осталась на экране после ввода — код, вероятно, неверный", { попытка });
  }

  throw new Error(`КТЗ не принял код подтверждения за ${ПОПЫТОК_КОДА} попытки`);
}

async function authorizeKTZ(опции = {}) {
  const browser = await getBrowser();

  // ============================================================
  // 1. ПРОБУЕМ СОХРАНЁННУЮ СЕССИЮ
  // ============================================================

  if (fs.existsSync(SESSION_PATH)) {
    logger.info("КТЗ: пробуем сохранённую сессию", { путь: SESSION_PATH });
    const context = await browser.newContext({
      storageState: SESSION_PATH,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      acceptDownloads: true,
    });
    const page = await context.newPage();

    await page.goto(CART_URL);
    await page.waitForLoadState("domcontentloaded");
    await delay(1500);

    const попалиВКорзину = page.url().includes("/cart");
    if (попалиВКорзину) {
      logger.info("КТЗ: сохранённая сессия ещё жива, вход не требуется");
      setPage(page); // делаем страницу общей — её же вернёт обычный getPage()
      return page;
    }

    logger.info("КТЗ: сохранённая сессия истекла (редирект на главную), логинимся заново");
    await context.close();
  }

  // ============================================================
  // 2. ПОЛНЫЙ ВХОД — ЛОГИН/ПАРОЛЬ + РУЧНОЙ ВВОД КОДА ПОДТВЕРЖДЕНИЯ
  // ============================================================

  const login = process.env.KTZ_LOGIN;
  const password = process.env.KTZ_PASSWORD;
  if (!login || !password) {
    throw new Error("Не заданы KTZ_LOGIN/KTZ_PASSWORD в .env");
  }

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    acceptDownloads: true,
  });
  const page = await context.newPage();

  logger.info("КТЗ: переходим на главную для авторизации");
  await page.goto(HOME_URL);
  await page.waitForLoadState("domcontentloaded");
  await delay(2500);

  // --- Клик "Личный кабинет" ---
  const личныйКабинет = page.locator('img[alt="Личный кабинет"]').first();
  await личныйКабинет.waitFor({ state: "visible", timeout: 15000 });
  await личныйКабинет.locator("xpath=ancestor::a[1]").click();
  await delay(1200);

  // --- Поля логина/пароля ---
  await page.waitForSelector('input[name="login"]', { state: "visible", timeout: 5000 });
  await delay(300);

  await page.click('input[name="login"]');
  await page.keyboard.type(login, { delay: 40 });
  await delay(200);

  await page.click('input[name="password"]');
  await page.keyboard.type(password, { delay: 40 });
  await delay(200);

  const кнопкаВойти = page.locator('button[type="submit"]', { hasText: "Войти" }).first();
  await кнопкаВойти.waitFor({ state: "visible", timeout: 3000 });
  await кнопкаВойти.click();
  await delay(1500);

  // ============================================================
  // 3. КОД ПОДТВЕРЖДЕНИЯ — ЗАПРАШИВАЕМ У АДМИНА В TELEGRAM
  // ============================================================
  //
  // На сервере нет ни терминала, ни видимого окна, поэтому ждать Enter
  // в консоли нельзя (бот зависал навсегда). Код приходит админу в
  // Telegram → админ пересылает его боту → бот вводит его в форму.
  // Таймаут — 5 минут на попытку; после него бросаем ошибку, а не висим.

  await подтвердиВходКодом(page, опции);

  await delay(1000);

  // ============================================================
  // 4. ПРОВЕРКА УСПЕХА
  // ============================================================

  await page.goto(CART_URL);
  await page.waitForLoadState("domcontentloaded");
  await delay(1500);

  if (!page.url().includes("/cart")) {
    throw new Error(
      "После ручного ввода кода подтверждения всё равно не попали в корзину — вход не удался.",
    );
  }

  // ============================================================
  // 5. СОХРАНЯЕМ СЕССИЮ НА ДИСК — СЛЕДУЮЩИЕ ЗАПУСКИ СМОГУТ ЕЁ
  //    ПЕРЕИСПОЛЬЗОВАТЬ, БЕЗ ПОВТОРНОГО ВВОДА КОДА
  // ============================================================

  const outDir = path.dirname(SESSION_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  await context.storageState({ path: SESSION_PATH });

  logger.info("КТЗ: авторизация прошла успешно, сессия сохранена", { путь: SESSION_PATH });

  setPage(page); // делаем страницу общей — её же вернёт обычный getPage()
  return page;
}

module.exports = { authorizeKTZ, введиКодПодтверждения, подтвердиВходКодом };