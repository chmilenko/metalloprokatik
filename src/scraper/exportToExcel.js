/**
 * exportToExcel.js
 *
 * Экспорт всей заявки в Excel таблицу.
 */

const fs = require('fs');
const path = require('path');
const { searchPosition } = require('./search');
const { parseOrder } = require('../agent/parser');

/**
 * Формирует Excel таблицу по всей заявке
 */
async function экспортироватьЗаявку(ctx, text) {
  try {
    // 1. Парсим заявку
    await ctx.reply('🔍 Анализирую заявку...');
    const positions = await parseOrder(text);
    
    if (positions.length === 0) {
      await ctx.reply('❌ Не нашел позиций в заявке.');
      return;
    }

    await ctx.reply(`📋 Нашел ${positions.length} позиций. Ищу на mc.ru...`);

    // 2. Ищем каждую позицию
    const результаты = [];
    let всего = 0;
    let найдено = 0;

    for (const position of positions) {
      const result = await searchPosition(position.поисковый_запрос, position);
      
      if (result.found && result.variants.length > 0) {
        найдено++;
        // Берем все варианты
        for (const variant of result.variants) {
          результаты.push({
            позиция: position.название,
            количество: position.количество,
            единица: position.единица,
            название: variant.название,
            размер: variant.размер || '',
            марка: variant.марка || '',
            длина: variant.длина || '',
            смц: variant.смц || '',
            цена_от_1т: variant.цена_от_1т || '',
            цена_от_5т: variant.цена_от_5т || '',
            цена_от_10т: variant.цена_от_10т || '',
            остаток: variant.остаток || '',
            гост_ту: variant.название?.toLowerCase().includes('гост') ? 'ГОСТ' : 'ТУ',
            ссылка: variant.sourceUrl || ''
          });
        }
      } else {
        // Запоминаем, что не нашли
        результаты.push({
          позиция: position.название,
          количество: position.количество,
          единица: position.единица,
          название: '❌ НЕ НАЙДЕНО',
          размер: '',
          марка: '',
          длина: '',
          смц: '',
          цена_от_1т: '',
          цена_от_5т: '',
          цена_от_10т: '',
          остаток: '',
          гост_ту: '',
          ссылка: ''
        });
      }
    }

    // 3. Формируем CSV
    const заголовки = [
      'Позиция',
      'Количество',
      'Ед.',
      'Название на сайте',
      'Размер',
      'Марка',
      'Длина (мм)',
      'СМЦ',
      'Цена от 1т (₽)',
      'Цена от 5т (₽)',
      'Цена от 10т (₽)',
      'Остаток',
      'ГОСТ/ТУ',
      'Ссылка'
    ];

    const строки = результаты.map(r => [
      r.позиция,
      r.количество,
      r.единица,
      r.название,
      r.размер,
      r.марка,
      r.длина,
      r.смц,
      r.цена_от_1т,
      r.цена_от_5т,
      r.цена_от_10т,
      r.остаток,
      r.гост_ту,
      r.ссылка
    ]);

    const csv = сформироватьCSV(заголовки, строки);

    // 4. Сохраняем и отправляем
    const filename = `заявка_${Date.now()}.csv`;
    const filepath = path.join(__dirname, '../../downloads', filename);
    const BOM = '\uFEFF';
    fs.writeFileSync(filepath, BOM + csv, 'utf8');

    // 5. Отправляем
    await ctx.replyWithDocument(
      { source: filepath, filename: `заявка_${new Date().toISOString().slice(0,10)}.csv` },
      { 
        caption: `📊 Таблица по заявке:\n• Всего позиций: ${positions.length}\n• Найдено: ${найдено}\n• Не найдено: ${positions.length - найдено}`
      }
    );

    // 6. Показываем рекомендацию
    await показатьРекомендацию(ctx, результаты);

    // 7. Удаляем файл
    fs.unlinkSync(filepath);

  } catch (err) {
    logger.error('Ошибка экспорта заявки', { error: err.message });
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
}

/**
 * Формирует CSV строку
 */
function сформироватьCSV(заголовки, строки) {
  const экранировать = (поле) => {
    if (поле === null || поле === undefined) return '';
    const str = String(поле);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headerRow = заголовки.map(экранировать).join(',');
  const dataRows = строки.map(row => 
    row.map(экранировать).join(',')
  );
  return [headerRow, ...dataRows].join('\n');
}

/**
 * Показывает рекомендацию по заявке
 */
async function показатьРекомендацию(ctx, результаты) {
  // Группируем по базам
  const базы = {};
  for (const r of resultados) {
    if (r.смц && r.название !== '❌ НЕ НАЙДЕНО') {
      if (!базы[r.смц]) базы[r.смц] = [];
      базы[r.смц].push(r);
    }
  }

  // Находим лучшую базу
  let лучшаяБаза = null;
  let максПозиций = 0;

  for (const [база, позиции] of Object.entries(базы)) {
    if (позиции.length > максПозиций) {
      максПозиций = позиции.length;
      лучшаяБаза = база;
    }
  }

  let рекомендация = '💡 Рекомендация:\n';
  if (лучшаяБаза) {
    рекомендация += `• Лучшая база: ${лучшаяБаза} (покрывает ${максПозиций} позиций)\n`;
  }

  // Находим самую дешевую позицию
  const дешевые = resultados
    .filter(r => r.цена_от_1т && r.название !== '❌ НЕ НАЙДЕНО')
    .sort((a, b) => a.цена_от_1т - b.цена_от_1т);

  if (дешевые.length > 0) {
    рекомендация += `• Самая дешевая позиция: ${дешевые[0].название} (${дешевые[0].цена_от_1т} ₽/т)\n`;
  }

  await ctx.reply(рекомендация);
}

module.exports = { экспортироватьЗаявку };