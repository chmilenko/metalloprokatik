/**
 * merge-final.js
 *
 * Собирает финальную базу metalcalc.json: берёт присланный v2.1 целиком,
 * заменяет в нём ТОЛЬКО категорию "pipe_es" на проверенную через
 * независимые источники версию (см. gen1-pipe-es.json рядом) — та самая
 * категория, где v2.1 оказался неверным (труба 89х3 в v2.1 = 6.463,
 * а по 4+ независимым источникам и официальному ГОСТ 10704-91 — 6.36).
 *
 * Использование:
 *   node merge-final.js <путь-к-вашему-metalcalc-v2.1.json>
 *
 * Результат — metalcalc-FINAL.json в этой же папке.
 */

const fs = require("fs");
const path = require("path");

const v21Path = process.argv[2];
if (!v21Path) {
  console.error("Использование: node merge-final.js <путь к вашему metalcalc.json v2.1>");
  process.exit(1);
}

const v21 = JSON.parse(fs.readFileSync(v21Path, "utf-8"));
const проверенныйPipeEs = JSON.parse(
  fs.readFileSync(path.join(__dirname, "gen1-pipe-es.json"), "utf-8"),
);

const безСтарогоPipeEs = v21.profiles.filter((p) => p.type !== "pipe_es");
const итоговыеПрофили = [...безСтарогоPipeEs, ...проверенныйPipeEs];

const итог = {
  version: "2.2-merged",
  description:
    "v2.1 + проверенная категория pipe_es (труба электросварная) — в v2.1 " +
    "эта категория содержала систематическую ошибку ~1.6% (труба 89х3 " +
    "показывала 6.463 кг/м вместо верных 6.36 кг/м по ГОСТ 10704-91, " +
    "подтверждено 4+ независимыми источниками). Остальные категории — " +
    "как в v2.1 (швеллер/уголок там уже исправлены и проверены отдельно).",
  profiles: итоговыеПрофили,
};

const outPath = path.join(__dirname, "metalcalc-FINAL.json");
fs.writeFileSync(outPath, JSON.stringify(итог, null, 2), "utf-8");

console.log(`Готово: ${outPath}`);
console.log(`Всего профилей: ${итоговыеПрофили.length}`);
console.log(`  из них pipe_es (заменено на проверенные): ${проверенныйPipeEs.length}`);
console.log(`  остальное (из v2.1, без изменений): ${безСтарогоPipeEs.length}`);

// Быстрая самопроверка — заодно сразу видно, что подмена сработала
const проверкаТруба89x3 = итоговыеПрофили.find(
  (p) => p.type === "pipe_es" && p.size === "89x3.0",
);
console.log(
  `\nПроверка: труба 89x3.0 → ${проверкаТруба89x3?.weight_per_meter} кг/м (должно быть 6.362)`,
);
