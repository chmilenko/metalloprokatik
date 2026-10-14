/**
 * Ручное обновление прайсов Брок Инвеста из командной строки.
 *
 *   node src/scripts/brok-update.js            — скачать с brokinvest.ru и обновить
 *   node src/scripts/brok-update.js ПАПКА      — взять уже скачанные файлы из папки
 *
 * Второй вариант нужен, если сайт не отдаёт файлы автоматически: скачайте
 * прайсы руками (страница «Прайс-листы») в одну папку — имена файлов вида
 * price-list-vgp.xlsx — и укажите путь к папке.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { обновитьИзФайлов, КАТЕГОРИИ } = require("../scraper-brok/index");
const { обновитьПрайс, слагИзИмени } = require("../scraper-brok/download");

(async () => {
  const арг = process.argv[2];
  let результат;
  if (арг) {
    const файлы = {};
    for (const имя of fs.readdirSync(арг)) {
      const slug = слагИзИмени(имя) || (КАТЕГОРИИ[имя.replace(/\.xlsx?$/i, "")] ? имя.replace(/\.xlsx?$/i, "") : null);
      if (slug) файлы[slug] = path.join(арг, имя);
    }
    if (Object.keys(файлы).length === 0) throw new Error(`В папке ${арг} нет файлов вида price-list-<категория>.xlsx`);
    результат = обновитьИзФайлов(файлы);
  } else {
    результат = await обновитьПрайс();
  }
  console.log(`Прайс от ${результат.датаПрайсаТекст}: категорий обновлено ${результат.обновлено.length}, позиций ${результат.позиций}, распознано ${результат.разобрано}.`);
  if (результат.проблемы?.length) console.log("Проблемы:\n  " + результат.проблемы.join("\n  "));
  if (результат.нетСсылок?.length) console.log("Не нашёл на сайте: " + результат.нетСсылок.join(", "));
  process.exit(0);
})().catch((err) => {
  console.error("Ошибка:", err.message);
  process.exit(1);
});