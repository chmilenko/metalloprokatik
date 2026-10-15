/**
 * scraper-brok/download.js
 *
 * Ежедневное скачивание прайс-листов Брок Инвеста и обновление данных бота.
 *
 * Как достаём файлы: на странице brokinvest.ru/price-lists «кнопки» XLSX — не
 * ссылки, а блоки с JavaScript, который при нажатии запрашивает файл по
 * публичному адресу
 *     https://back.brokinvest.ru/api/v1/catalog/table/<категория>/export
 * (авторизация не нужна, отдаётся обычный xlsx). Берём файлы напрямую по этому
 * адресу — без браузера. Категории — см. КАТЕГОРИИ в parse.js (рулоны,
 * электроды, проволоку и т.п. не качаем).
 *
 * Расписание: раз в сутки в 09:30 (по времени процесса; на сервере
 * Europe/Moscow), при неудаче повторяем через 30 минут, после четвёртой
 * неудачи пишем администратору. При старте бота, если данных нет или они
 * старше последнего ожидаемого обновления — качаем сразу.
 */

const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const { обновитьИзФайлов, инфоОПрайсе, КАТЕГОРИИ, ПАПКА_ФАЙЛОВ } = require("./index");

const АДРЕС_API = process.env.BROK_API || "https://back.brokinvest.ru/api/v1/catalog/table";
const ЧАС_ОБНОВЛЕНИЯ = 9;
const МИНУТА_ОБНОВЛЕНИЯ = 30;
const ПОВТОР_ЧЕРЕЗ_МС = 30 * 60 * 1000;
const МАКС_ПОПЫТОК_ПОДРЯД = 4;
const МИН_РАЗМЕР_ФАЙЛА = 1024;
const ТАЙМАУТ_ЗАПРОСА_МС = 60 * 1000;

let идётОбновление = false;

function этоXlsx(буфер) {
  return !!буфер && буфер.length >= 4 && буфер[0] === 0x50 && буфер[1] === 0x4b; // zip («PK»)
}

/** Категория по имени файла: «price-list-vgp.xlsx» → «vgp» (для ручной загрузки из папки). */
function слагИзИмени(текст) {
  if (!текст) return null;
  const м = decodeURIComponent(String(текст)).toLowerCase().match(/price-list-([a-z_]+)\.xlsx?/);
  return м && КАТЕГОРИИ[м[1]] ? м[1] : null;
}

async function скачатьОдин(slug) {
  const адрес = `${АДРЕС_API}/${slug}/export`;
  let последняяОшибка = null;
  for (let попытка = 1; попытка <= 2; попытка++) {
    try {
      const ответ = await fetch(адрес, {
        headers: { accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*", "user-agent": "Mozilla/5.0 (compatible; metalloprokatik-bot)" },
        signal: AbortSignal.timeout(ТАЙМАУТ_ЗАПРОСА_МС),
      });
      if (!ответ.ok) throw new Error(`сервер ответил ${ответ.status}`);
      const буфер = Buffer.from(await ответ.arrayBuffer());
      if (!этоXlsx(буфер) || буфер.length < МИН_РАЗМЕР_ФАЙЛА) {
        throw new Error(`пришёл не Excel-файл (${буфер.length} байт)`);
      }
      return буфер;
    } catch (err) {
      последняяОшибка = err;
      if (попытка < 2) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw последняяОшибка;
}

/**
 * Скачивает все нужные файлы в downloads/brok/<категория>.xlsx.
 * Возвращает { файлы: {slug: путь}, нетСсылок: [slug...], ошибки: [...] }.
 */
async function скачатьФайлы() {
  fs.mkdirSync(ПАПКА_ФАЙЛОВ, { recursive: true });
  const файлы = {};
  const ошибки = [];
  for (const slug of Object.keys(КАТЕГОРИИ)) {
    try {
      const буфер = await скачатьОдин(slug);
      const путь = path.join(ПАПКА_ФАЙЛОВ, `${slug}.xlsx`);
      fs.writeFileSync(`${путь}.tmp`, буфер);
      fs.renameSync(`${путь}.tmp`, путь);
      файлы[slug] = путь;
    } catch (err) {
      ошибки.push(`${slug}: ${err.message}`);
    }
  }
  if (Object.keys(файлы).length === 0) {
    throw new Error(`ни один прайс не скачался (${ошибки.slice(0, 3).join("; ")})`);
  }
  if (ошибки.length) logger.warn("Брок: часть файлов не скачалась", { ошибки });
  return { файлы, нетСсылок: Object.keys(КАТЕГОРИИ).filter((к) => !файлы[к]), ошибки };
}

/**
 * Скачать + разобрать + сохранить. Бросает ошибку, если не вышло; прежние
 * данные при этом остаются.
 */
async function обновитьПрайс() {
  if (идётОбновление) throw new Error("Обновление прайсов Брок Инвеста уже идёт");
  идётОбновление = true;
  try {
    const результатСкачивания = await скачатьФайлы();
    const итог = обновитьИзФайлов(результатСкачивания.файлы);
    итог.нетСсылок = результатСкачивания.нетСсылок;
    return итог;
  } finally {
    идётОбновление = false;
  }
}

// ───────────────────────── расписание ─────────────────────────

function следующийЗапуск(сейчас = new Date()) {
  const t = new Date(сейчас);
  t.setHours(ЧАС_ОБНОВЛЕНИЯ, МИНУТА_ОБНОВЛЕНИЯ, 0, 0);
  if (t.getTime() <= сейчас.getTime()) t.setDate(t.getDate() + 1);
  return t;
}

function последнийОжидаемыйМомент(сейчас = new Date()) {
  const t = new Date(сейчас);
  t.setHours(ЧАС_ОБНОВЛЕНИЯ, МИНУТА_ОБНОВЛЕНИЯ, 0, 0);
  if (t.getTime() > сейчас.getTime()) t.setDate(t.getDate() - 1);
  return t;
}

function нужноСкачатьПриСтарте() {
  const инфо = инфоОПрайсе();
  if (!инфо.есть) return true;
  const скачан = инфо.скачан ? Date.parse(инфо.скачан) : 0;
  return скачан < последнийОжидаемыйМомент().getTime();
}

/**
 * Запускает ежедневное обновление. Вызывать один раз при старте бота.
 * @param {{уведомить?: (текст:string)=>Promise<any>}} опции
 */
function запуститьЕжедневноеОбновление({ уведомить = null } = {}) {
  const сказать = async (текст) => {
    if (!уведомить) return;
    try {
      await уведомить(текст);
    } catch (err) {
      logger.error("Брок: не удалось отправить уведомление", { error: err.message });
    }
  };

  async function попытка(номер) {
    try {
      const р = await обновитьПрайс();
      logger.info("Брок: плановое обновление прошло", { дата: р.датаПрайсаТекст, обновлено: р.обновлено.length });
      if (р.проблемы.length > 0 || р.нетСсылок.length > 0) {
        await сказать(
          `⚠️ Прайсы Брок Инвеста обновлены не полностью: получено ${р.обновлено.length} категорий.` +
            (р.нетСсылок.length ? `\nНе нашёл на сайте: ${р.нетСсылок.join(", ")}` : "") +
            (р.проблемы.length ? `\nНе разобрались: ${р.проблемы.join("; ")}` : ""),
        );
      } else {
        await сказать(`🔄 Прайсы Брок Инвеста обновлены (от ${р.датаПрайсаТекст})` + (номер > 1 ? ` — со ${номер}-й попытки.` : "."));
      }
      return true;
    } catch (err) {
      logger.error("Брок: не удалось обновить прайсы", { попытка: номер, error: err.message });
      if (номер >= МАКС_ПОПЫТОК_ПОДРЯД) {
        const инфо = инфоОПрайсе();
        await сказать(
          `⚠️ Не удалось обновить прайсы Брок Инвеста (${номер} попытки подряд): ${err.message}\n` +
            (инфо.есть ? `Использую прежние — от ${инфо.датаПрайсаТекст}.` : "Данных нет — колонки «Брок» в таблице не будет."),
        );
        return true;
      }
      setTimeout(() => попытка(номер + 1), ПОВТОР_ЧЕРЕЗ_МС).unref?.();
      return false;
    }
  }

  function назначить() {
    const когда = следующийЗапуск();
    const мс = когда.getTime() - Date.now();
    logger.info("Брок: следующее обновление прайсов", { когда: когда.toISOString() });
    setTimeout(async () => {
      await попытка(1);
      назначить();
    }, мс).unref?.();
  }

  назначить();

  if (нужноСкачатьПриСтарте()) {
    // чуть позже старта (и после загрузки Дипоса), чтобы не мешать запуску бота
    setTimeout(() => попытка(1), 45000).unref?.();
  }
}

module.exports = {
  обновитьПрайс,
  скачатьФайлы,
  запуститьЕжедневноеОбновление,
  следующийЗапуск,
  последнийОжидаемыйМомент,
  нужноСкачатьПриСтарте,
  слагИзИмени,
};