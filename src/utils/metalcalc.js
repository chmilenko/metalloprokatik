// metalcalc.js v2.3
// v2.3: записи базы, явно расходящиеся с формулой (ВГП — все ДУ из ГОСТ 3262; круг >2,5%; проф. труба >8%),
//       заменяются расчётом по формуле — аудит базы показал ошибки в этих данных
// v2.2: шестигранник — размер «под ключ» (было: описанный круг, занижение 25% вне базы);
//       ВГП по формуле — наружный диаметр по ДУ из ГОСТ 3262 (было: ДУ как наружный диаметр)
// Локальный калькулятор металлопроката. Без зависимостей, без сети.
// Исправления: швеллер 16 = 14.2 кг/м, уголок 63x63x5 = 4.81 кг/м (из базы, а не по формуле)
// Добавлен словарь русских синонимов для type

const fs = require('fs');
const path = require('path');

// ============ СЛОВАРЬ СИНОНИМОВ ============
const TYPE_ALIASES = {
  // арматура
  'арматура': 'armature', 'арматуру': 'armature', 'арматуры': 'armature',
  'арматурная сталь': 'armature', 'стержень': 'armature', 'пруток арматурный': 'armature',
  // круг
  'круг': 'round', 'круглый прокат': 'round', 'круг стальной': 'round',
  // квадрат
  'квадрат': 'square', 'квадрат стальной': 'square',
  // шестигранник
  'шестигранник': 'hexagon', 'шестигранник стальной': 'hexagon',
  // трубы — три типа!
  'труба вгп': 'pipe_vgp', 'вгп': 'pipe_vgp', 'труба водогазопроводная': 'pipe_vgp',
  'водогазопроводная': 'pipe_vgp', 'труба оцинкованная вгп': 'pipe_vgp',
  'труба э/с': 'pipe_es', 'труба электросварная': 'pipe_es',
  'электросварная': 'pipe_es', 'труба прямошовная': 'pipe_es',
  'труба стальная электросварная': 'pipe_es', 'труба эс': 'pipe_es',
  'труба профильная': 'pipe_prof', 'труба прямоугольная': 'pipe_prof',
  'труба квадратная': 'pipe_prof', 'профильная': 'pipe_prof',
  'профильная труба': 'pipe_prof',
  // уголок
  'уголок': 'angle', 'уголок стальной': 'angle',
  'уголок равнополочный': 'angle', 'уголок металлический': 'angle',
  // швеллер
  'швеллер': 'channel', 'швеллер стальной': 'channel',
  // двутавр / балка
  'двутавр': 'beam', 'балка': 'beam', 'двутавровая балка': 'beam',
  'двутавр стальной': 'beam', 'балка двутавровая': 'beam',
  // полоса
  'полоса': 'strip', 'полоса стальная': 'strip',
  // лист
  'лист': 'sheet', 'лист стальной': 'sheet', 'листовой прокат': 'sheet',
  // английские (оригинальные коды)
  'armature': 'armature', 'round': 'round', 'square': 'square',
  'hexagon': 'hexagon', 'pipe_vgp': 'pipe_vgp', 'pipe_es': 'pipe_es',
  'pipe_prof': 'pipe_prof', 'angle': 'angle', 'channel': 'channel',
  'beam': 'beam', 'strip': 'strip', 'sheet': 'sheet',
};

// Наружные диаметры труб ВГП по условному проходу, мм (ГОСТ 3262)
const OUTER_VGP = {
  6: 10.2, 8: 13.5, 10: 17.0, 15: 21.3, 20: 26.8, 25: 33.5, 32: 42.3,
  40: 48.0, 50: 60.0, 65: 75.5, 80: 88.5, 90: 101.3, 100: 114.0, 125: 140.0, 150: 165.0,
};

// ============ ПЛОТНОСТИ МАТЕРИАЛОВ (г/см³) ============
const DENSITIES = {
  steel: 7.85, stainless: 8.0, aluminum: 2.70, copper: 8.94,
  brass: 8.56, bronze: 8.80, titanium: 4.51, cast_iron: 7.20
};

const DEFAULT_DENSITY = DENSITIES.steel;

// ============ КЛАСС КАЛЬКУЛЯТОРА ============
class MetalCalc {
  constructor(dbPath) {
    if (!dbPath) {
      dbPath = path.join(__dirname, 'metalcalc.json');
    }
    const raw = fs.readFileSync(dbPath, 'utf-8');
    this.db = JSON.parse(raw);
    this._buildIndex();
  }

  _buildIndex() {
    this._index = {};
    for (const p of this.db.profiles) {
      const key = p.type + '|' + this._normalizeSize(p.size);
      this._index[key] = p;
    }
  }

  _normalizeType(type) {
    if (!type) return type;
    const lower = type.toLowerCase().trim();
    return TYPE_ALIASES[lower] || type.toLowerCase().trim();
  }

  _normalizeSize(size) {
    if (!size) return size;
    return String(size).trim()
      .replace(/,/g, '.')
      .replace(/\s+/g, '')
      .replace(/\u0445/g, 'x') // кириллическое 'х' -> латинское 'x'
      .replace(/\u0425/g, 'x') // кириллическое 'Х' -> 'x'
      .replace(/\*/g, 'x')
      .replace(/(\d)\.0(x|\b)/g, '$1$2'); // 40x20x2.0 -> 40x20x2
  }

  _findProfile(type, size) {
    const normType = this._normalizeType(type);
    const normSize = this._normalizeSize(size);
    const key = normType + '|' + normSize;
    if (this._index[key]) return this._index[key];

    // Попытка без нормализации нулей (если в базе 2.0, а ищем 2)
    const key2 = normType + '|' + size.replace(/\s+/g, '').replace(/,/g, '.').replace(/\u0445/g, 'x').replace(/\u0425/g, 'x').replace(/\*/g, 'x');
    if (this._index[key2]) return this._index[key2];

    // Попытка с добавлением .0 (если в базе 2.0, а ищем 2)
    const key3 = normType + '|' + normSize;
    if (!this._index[key3]) {
      // Проверяем варианты с .0
      for (const k of Object.keys(this._index)) {
        if (k.startsWith(normType + '|')) {
          const dbSize = k.split('|')[1];
          // Сравниваем числовые компоненты
          if (this._sizesEqual(normSize, dbSize)) {
            return this._index[k];
          }
        }
      }
    }

    return null;
  }

  _sizesEqual(s1, s2) {
    const parts1 = s1.split('x').map(Number);
    const parts2 = s2.split('x').map(Number);
    if (parts1.length !== parts2.length) return false;
    for (let i = 0; i < parts1.length; i++) {
      if (Math.abs(parts1[i] - parts2[i]) > 0.001) return false;
    }
    return true;
  }

  // Записи базы, которым нельзя доверять: ВГП (ДУ в базе перепутаны), круг и проф. труба
  // с отклонением от формулы больше допуска (аудит audit_calc.js)
  _предпочестьФормулу(type, size, весБазы, весФормулы) {
    const t = this._normalizeType(type);
    const откл = Math.abs(весБазы - весФормулы) / весФормулы * 100;
    if (t === 'pipe_vgp') {
      const ду = Number(this._normalizeSize(size).split('x')[0]);
      return !!OUTER_VGP[ду];
    }
    if (t === 'round') return откл > 2.5;
    if (t === 'pipe_prof') return откл > 8;
    return false;
  }

  _calcFormulaWeight(type, size, density) {
    // Геометрический расчёт для нестандартных размеров
    const parts = this._normalizeSize(size).split('x').map(Number);
    const d = density; // г/см³ = кг/дм³ × 0.001... нет, г/см³ = кг/дм³ / 100
    // Плотность в г/см³, размеры в мм
    // Вес 1 метра = площадь сечения (мм²) × плотность (г/см³) × 100 (перевод) / 1000000
    // = площадь × плотность / 10000 ... проверим:
    // 1 м = 1000 мм, площадь в мм² × 1000 мм = объём в мм³
    // / 1000 = объём в см³, × плотность г/см³ = масса в граммах, / 1000 = кг
    // Итог: площадь(мм²) × 1000 / 1000 × плотность / 1000 = площадь × плотность / 1000

    let area = 0; // мм²

    const normType = this._normalizeType(type);

    if (normType === 'armature' || normType === 'round') {
      const dia = parts[0];
      if (!dia) return null;
      area = Math.PI * dia * dia / 4;
    } else if (normType === 'square') {
      const a = parts[0];
      if (!a) return null;
      area = a * a;
    } else if (normType === 'hexagon') {
      const s = parts[0]; // размер «под ключ» (расстояние между гранями), как в ГОСТ 2879
      if (!s) return null;
      area = (Math.sqrt(3) / 2) * s * s;
    } else if (normType === 'pipe_vgp' || normType === 'pipe_es') {
      let outer = parts[0];
      const wall = parts[1];
      if (!outer || !wall) return null;
      // ВГП задаётся условным проходом (ДУ), наружный диаметр — по ГОСТ 3262
      if (normType === 'pipe_vgp' && OUTER_VGP[outer]) outer = OUTER_VGP[outer];
      area = Math.PI * (outer * outer - (outer - 2 * wall) * (outer - 2 * wall)) / 4;
    } else if (normType === 'pipe_prof') {
      const w = parts[0], h = parts[1] || parts[0], wall = parts[2];
      if (!w || !wall) return null;
      area = 2 * (w + h - 2 * wall) * wall - (4 - Math.PI) * wall * wall; // с учётом скруглений
      // Упрощённая (без скруглений): area = 2 * (w + h) * wall - 4 * wall * wall
      // С учётом скруглений R=1.5*wall:
      area = 2 * (w + h - 2 * wall) * wall - (4 - Math.PI) * Math.pow(1.5 * wall, 2);
    } else if (normType === 'angle') {
      const a = parts[0], b = parts[1] || parts[0], t = parts[2];
      if (!a || !t) return null;
      area = (a + b - t) * t + (1 - Math.PI / 4) * 0; // без учёта радиусов
      area = (a + b - t) * t; // упрощённая формула (даёт занижение ~1-2%)
    } else if (normType === 'channel') {
      // Швеллер: h × s + 2 × b × t (упрощённо)
      // parts: номер швеллера (например "16") — не можем посчитать по формуле без размеров сечения
      return null; // для швеллера нужен ГОСТ
    } else if (normType === 'beam') {
      return null; // для двутавра нужен ГОСТ
    } else if (normType === 'strip') {
      const w = parts[0], t = parts[1];
      if (!w || !t) return null;
      area = w * t;
    } else if (normType === 'sheet') {
      // Лист: толщина × ширина (вес за 1 м длины)
      const t = parts[0], w = parts[1];
      if (!t) return null;
      area = t * (w || 1000);
    } else {
      return null;
    }

    // площадь(мм²) × плотность(г/см³) / 1000 = кг/м
    const weightPerMeter = area * d / 1000;
    return Math.round(weightPerMeter * 1000) / 1000; // округление до 3 знаков
  }

  calc(params) {
    const type = this._normalizeType(params.type);
    const size = params.size || '';
    const material = params.material || 'steel';
    const density = DENSITIES[material] || DEFAULT_DENSITY;
    const pieceLength = params.pieceLength || params.piece_length || null;
    const pricePerTon = params.pricePerTon || params.price_per_ton || null;

    // Ищем в базе
    let profile = this._findProfile(type, size);
    if (profile) {
      const ф = this._calcFormulaWeight(type, size, DENSITIES.steel);
      if (ф != null && this._предпочестьФормулу(type, size, profile.weight_per_meter, ф)) profile = null;
    }
    let weightPerMeter = null;
    let fromDb = false;

    if (profile) {
      // В базе вес указан для стали (7.85). Корректируем для других материалов
      weightPerMeter = profile.weight_per_meter * density / DENSITIES.steel;
      weightPerMeter = Math.round(weightPerMeter * 1000) / 1000;
      fromDb = true;
    } else {
      // Считаем по формуле
      weightPerMeter = this._calcFormulaWeight(type, size, density);
      if (weightPerMeter === null) {
        return { error: `Не найден профиль ${type} ${size} в базе и не удалось посчитать по формуле` };
      }
    }

    // Параметры на входе
    const totalLength = params.length ? parseFloat(params.length) : null;
    const totalWeight = params.weight ? parseFloat(params.weight) : null;
    const pieces = params.pieces ? parseInt(params.pieces) : null;

    let result = {
      type: type,
      size: size,
      weight_per_meter: weightPerMeter,
      source: fromDb ? 'database' : 'formula',
      material: material,
    };

    // Расчёты
    if (totalLength !== null) {
      // Из метров — вес и штуки
      const weightKg = totalLength * weightPerMeter;
      result.total_length = totalLength;
      result.total_weight = Math.round(weightKg * 100) / 100;
      result.total_weight_tons = Math.round(weightKg / 10) / 100;

      if (pieceLength) {
        const pl = parseFloat(pieceLength);
        const fullPieces = Math.floor(totalLength / pl);
        const remainder = Math.round((totalLength - fullPieces * pl) * 100) / 100;
        result.pieces = fullPieces;
        result.piece_length = pl;
        result.remaining_length = remainder;
      }
    } else if (totalWeight !== null) {
      // Из тонн/кг — метры и штуки
      let weightKg;
      if (totalWeight < 100) {
        // Вероятно, тонны
        weightKg = totalWeight * 1000;
        result.total_weight_tons = totalWeight;
      } else {
        weightKg = totalWeight;
        result.total_weight_tons = Math.round(totalWeight / 10) / 100;
      }
      const length = weightKg / weightPerMeter;
      result.total_weight = Math.round(weightKg * 100) / 100;
      result.total_weight_tons = result.total_weight_tons || Math.round(weightKg / 10) / 100;
      result.total_length = Math.round(length * 100) / 100;

      if (pieceLength) {
        const pl = parseFloat(pieceLength);
        const fullPieces = Math.floor(length / pl);
        const remainder = Math.round((length - fullPieces * pl) * 100) / 100;
        result.pieces = fullPieces;
        result.piece_length = pl;
        result.remaining_length = remainder;
      }
    } else if (pieces !== null) {
      // Из штук — метры и вес
      if (!pieceLength) {
        return { error: 'При расчёте по штукам нужен pieceLength (длина одной штуки в метрах)' };
      }
      const pl = parseFloat(pieceLength);
      const length = pieces * pl;
      const weightKg = length * weightPerMeter;
      result.pieces = pieces;
      result.piece_length = pl;
      result.total_length = length;
      result.total_weight = Math.round(weightKg * 100) / 100;
      result.total_weight_tons = Math.round(weightKg / 10) / 100;
    } else {
      return { error: 'Нужен хотя бы один из параметров: length, weight, pieces' };
    }

    // Цена
    if (pricePerTon !== null && result.total_weight_tons) {
      result.total_cost = Math.round(result.total_weight_tons * pricePerTon * 100) / 100;
      result.price_per_ton = pricePerTon;
    }

    return result;
  }

  calcBatch(items) {
    const results = [];
    let totalWeight = 0;
    let totalCost = 0;

    for (const item of items) {
      const r = this.calc(item);
      if (r.error) {
        results.push({ input: item, error: r.error });
      } else {
        results.push(r);
        if (r.total_weight_tons) totalWeight += r.total_weight_tons;
        if (r.total_cost) totalCost += r.total_cost;
      }
    }

    return {
      results: results,
      summary: {
        total_weight_tons: Math.round(totalWeight * 100) / 100,
        total_cost: totalCost > 0 ? Math.round(totalCost * 100) / 100 : undefined
      }
    };
  }

  search(query) {
    const q = query.toLowerCase().trim();
    const results = [];
    for (const p of this.db.profiles) {
      if (p.type.toLowerCase().includes(q) || p.size.toLowerCase().includes(q)) {
        results.push(p);
      }
    }
    // Если не нашли по type, ищем по синонимам
    if (results.length === 0) {
      const normType = this._normalizeType(q);
      for (const p of this.db.profiles) {
        if (p.type === normType) results.push(p);
      }
    }
    return results;
  }

  getTypes() {
    const counts = {};
    for (const p of this.db.profiles) {
      counts[p.type] = (counts[p.type] || 0) + 1;
    }
    return counts;
  }

  getAliases() {
    // Группируем синонимы по каноническому типу
    const grouped = {};
    for (const [alias, canonical] of Object.entries(TYPE_ALIASES)) {
      if (alias === canonical) continue; // пропускаем английские оригиналы
      if (!grouped[canonical]) grouped[canonical] = [];
      grouped[canonical].push(alias);
    }
    return grouped;
  }

  addProfile(params) {
    const profile = {
      type: this._normalizeType(params.type),
      size: this._normalizeSize(params.size),
      weight_per_meter: parseFloat(params.weight_per_meter || params.weightPerMeter),
      gost: params.gost || 'Custom'
    };
    this.db.profiles.push(profile);
    this._buildIndex();

    // Сохраняем в файл
    const dbPath = path.join(__dirname, 'metalcalc.json');
    fs.writeFileSync(dbPath, JSON.stringify(this.db, null, 2), 'utf-8');
    return { success: true, profile: profile };
  }
}

// ============ CLI ============
function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opts = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.replace(/^--/, '').replace(/-/g, '_');
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
      if (val !== 'true') i++;
      opts[key] = val;
    }
  }
  return { cmd, opts };
}

function main() {
  const { cmd, opts } = parseArgs();
  const mc = new MetalCalc();

  if (cmd === 'calc') {
    const result = mc.calc(opts);
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === 'batch') {
    if (!opts.file) { console.error('Укажите --file path.json'); process.exit(1); }
    const items = JSON.parse(fs.readFileSync(opts.file, 'utf-8'));
    const result = mc.calcBatch(items);
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === 'search') {
    const query = opts._query || process.argv.slice(2).slice(1).join(' ');
    const results = mc.search(query);
    console.log(JSON.stringify(results, null, 2));
  } else if (cmd === 'types') {
    console.log(JSON.stringify(mc.getTypes(), null, 2));
  } else if (cmd === 'aliases') {
    console.log(JSON.stringify(mc.getAliases(), null, 2));
  } else if (cmd === 'add') {
    const result = mc.addProfile(opts);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`MetalCalc v2.1 — локальный калькулятор металлопроката

Использование:
  node metalcalc.js calc --type арматура --size 12 --weight 1.5 --piece-length 11.7
  node metalcalc.js calc --type уголок --size 63x63x5 --length 1000
  node metalcalc.js calc --type "труба профильная" --size "40x20x2" --pieces 10 --piece-length 6
  node metalcalc.js calc --type channel --size 16 --weight 2.5 --price-per-ton 62000
  node metalcalc.js batch --file zayavka.json
  node metalcalc.js search "уголок"
  node metalcalc.js types
  node metalcalc.js aliases
  node metalcalc.js add --type custom --size 120x60x3 --weight 10.36

Параметры:
  --type        Тип проката (рус. или англ.: арматура/armature, уголок/angle, ...)
  --size        Размер (например: 12, 63x63x5, 40x20x2)
  --length      Длина в метрах (для расчёта из метров → тонны/штуки)
  --weight      Вес в тоннах (если <100) или кг (если >=100)
  --pieces      Колько штук
  --piece-length Длина одной штуки в метрах
  --price-per-ton  Цена за тонну (опционально)
  --material    Материал: steel, stainless, aluminum, copper, brass, bronze, titanium, cast_iron
`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { MetalCalc };