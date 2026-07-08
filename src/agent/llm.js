/**
 * llm.js
 * 
 * Абстрактный слой для работы с AI моделями.
 * Сейчас используем Claude Sonnet — основная модель для прода.
 */

const Anthropic = require('@anthropic-ai/sdk')

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

async function askAI(prompt) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  })

  return response.content[0].text
}

module.exports = { askAI }