/**
 * Ручное обновление прайса Дипоса из командной строки.
 *
 *   node src/scripts/dipos-update.js                    — скачать с dipos.ru и обновить
 *   node src/scripts/dipos-update.js C:\путь\price.xls  — взять уже скачанный файл
 *
 * Второй вариант нужен, если сайт не отдал файл автоматически: скачайте
 * прайс руками (кнопка «Прайс-лист» на dipos.ru) и укажите путь к нему.
 */
require("dotenv").config();
const { обновитьИзФайла } = require("../scraper-dipos/index");
const { обновитьПрайс } = require("../scraper-dipos/download");

(async () => {
  const файл = process.argv[2];
  const результат = файл ? обновитьИзФайла(файл) : await обновитьПрайс();
  const с = результат.статистика;
  console.log(`Прайс от ${результат.датаПрайсаТекст}: распознано ${с.разобрано} из ${с.разобрано + с.неРазобрано} позиций в тоннах.`);
  if (результат.неРазобранные?.length) {
    console.log("Не распознано (в сравнении не участвуют):");
    for (const н of результат.неРазобранные.slice(0, 40)) console.log("  - " + н);
  }
  process.exit(0);
})().catch((err) => {
  console.error("Ошибка:", err.message);
  process.exit(1);
});