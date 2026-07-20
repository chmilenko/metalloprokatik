/**
 * searchMapManager.js
 * 
 * Управляет словарём сопоставлений поисковых запросов.
 * Читает, обновляет и сохраняет searchMap.json автоматически.
 */

const fs = require('fs')
const path = require('path')

const MAP_PATH = path.join(__dirname, '../data/searchMap.json')

function loadMap() {
  const raw = fs.readFileSync(MAP_PATH, 'utf-8')
  return JSON.parse(raw)
}

function saveMap(map) {
  fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2), 'utf-8')
}

// Получить поисковый запрос для позиции
function getSearchQuery(originalQuery) {
  const map = loadMap()
  const key = originalQuery.toLowerCase().trim()
  return map.поисковые_запросы[key] || null
}

// Сохранить новое сопоставление
function saveMapping(originalQuery, workingQuery) {
  const map = loadMap()
  const key = originalQuery.toLowerCase().trim()
  map.поисковые_запросы[key] = workingQuery
  saveMap(map)
}

// Добавить в список не найденных
function addNotFound(query) {
  const map = loadMap()
  if (!map.не_найдено.includes(query)) {
    map.не_найдено.push(query)
    saveMap(map)
  }
}

module.exports = { getSearchQuery, saveMapping, addNotFound, loadMap }