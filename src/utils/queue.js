/**
 * queue.js
 * 
 * Очередь заявок — обрабатываем по одной за раз.
 * Пока один пользователь обрабатывается — остальные ждут.
 */

let isProcessing = false
const queue = []

async function addToQueue(task, onWaiting) {
  return new Promise((resolve, reject) => {
    if (isProcessing && onWaiting) {
      onWaiting(queue.length + 1)
    }
    queue.push({ task, resolve, reject })
    processQueue()
  })
}

async function processQueue() {
  if (isProcessing || queue.length === 0) return

  isProcessing = true
  const { task, resolve, reject } = queue.shift()

  try {
    const result = await task()
    resolve(result)
  } catch (err) {
    reject(err)
  } finally {
    isProcessing = false
    processQueue()
  }
}



module.exports = { addToQueue }