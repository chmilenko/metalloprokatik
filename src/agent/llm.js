/**
 * llm.js
 * 
 * Абстрактный слой для работы с AI моделями.
 * Сейчас используем Groq (Llama 3) — бесплатный tier.
 */

const Groq = require('groq-sdk')

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY
})

async function askAI(prompt) {
  const response = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1000
  })

  return response.choices[0].message.content
}

module.exports = { askAI }