// Запуск из корня проекта: node audit_calc.js
// Проходит по ВСЕЙ базе metalcalc.json и сравнивает вес метра с формулой.
// Печатает только подозрительное. Без LLM и сети.
const { MetalCalc } = require('./src/utils/metalcalc');
const mc = new MetalCalc();
const ПЛ = 7.85;
const ДОПУСК = { armature: 3, round: 3, square: 3, hexagon: 3, strip: 1.5, pipe_es: 3, pipe_prof: 6, pipe_vgp: 5, angle: 6 };

const профили = mc.db.profiles;
const типы = {};
for (const p of профили) (типы[p.type] ||= []).push(p);

console.log('Типы в базе:', Object.entries(типы).map(([t, a]) => `${t}=${a.length}`).join(', '), '\n');

let подозр = 0;
const вывод = (t, p, текст) => { подозр++; console.log(`[${t}] ${p.size} (${p.gost || '-'}): ${текст}`); };

for (const [тип, список] of Object.entries(типы)) {
  // 1) Типы с формулой: сравниваем с базой
  if (ДОПУСК[тип]) {
    for (const p of список) {
      const ф = mc._calcFormulaWeight(тип, p.size, ПЛ);
      if (ф == null) { вывод(тип, p, 'формула не считает размер'); continue; }
      const откл = (p.weight_per_meter - ф) / ф * 100;
      if (Math.abs(откл) > ДОПУСК[тип]) вывод(тип, p, `в базе ${p.weight_per_meter} кг/м, по формуле ${ф} (${откл > 0 ? '+' : ''}${откл.toFixed(1)}%)`);
    }
  }
  // 2) Швеллер / двутавр: формулы нет — проверяем, что вес растёт с номером
  if (тип === 'channel' || тип === 'beam') {
    const отсорт = [...список].map((p) => ({ p, н: parseFloat(String(p.size).replace(',', '.')) })).filter((x) => Number.isFinite(x.н)).sort((a, b) => a.н - b.н);
    for (let i = 1; i < отсорт.length; i++) {
      const a = отсорт[i - 1], b = отсорт[i];
      if (b.н > a.н && b.p.weight_per_meter < a.p.weight_per_meter) вывод(тип, b.p, `легче меньшего номера ${a.p.size} (${b.p.weight_per_meter} < ${a.p.weight_per_meter})`);
      if (b.p.weight_per_meter > a.p.weight_per_meter * 2.2) вывод(тип, b.p, `скачок веса относительно ${a.p.size} (${a.p.weight_per_meter} → ${b.p.weight_per_meter})`);
    }
  }
  // 3) Листы: какая конвенция — вес целого листа или кг/м
  if (тип === 'sheet') {
    let целый = 0, наМетр = 0, прочее = 0;
    for (const p of список) {
      const [т, ш, д] = mc._normalizeSize(p.size).split('x').map(Number);
      if (!(т && ш)) { прочее++; continue; }
      const кгМ = т * ш * ПЛ / 1000;
      const кгЛиста = д ? т * ш * д * ПЛ / 1e6 : null;
      if (кгЛиста && Math.abs(p.weight_per_meter - кгЛиста) / кгЛиста < 0.03) целый++;
      else if (Math.abs(p.weight_per_meter - кгМ) / кгМ < 0.03) наМетр++;
      else { прочее++; вывод(тип, p, `не похоже ни на вес листа (${кгЛиста?.toFixed(2)}), ни на кг/м (${кгМ.toFixed(2)}): ${p.weight_per_meter}`); }
    }
    console.log(`[sheet] записей: ${список.length}; вес целого листа: ${целый}; кг/м: ${наМетр}; прочее: ${прочее}` +
      (целый && наМетр ? '  ← КОНВЕНЦИИ ПЕРЕМЕШАНЫ (бот считает лист геометрией, это безопасно)' : ''));
  }
  // 4) Любой тип: дубликаты размера с разным весом
  const вес = {};
  for (const p of список) {
    const k = mc._normalizeSize(p.size);
    if (k in вес && Math.abs(вес[k] - p.weight_per_meter) > 0.001) вывод(тип, p, `дубликат размера с другим весом (${вес[k]} и ${p.weight_per_meter})`);
    вес[k] = p.weight_per_meter;
  }
}
console.log(подозр ? `\nПодозрительных записей: ${подозр}` : '\nПодозрительного не найдено');
