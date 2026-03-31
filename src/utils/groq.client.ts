import Groq from 'groq-sdk';

if (!process.env['GROQ_API_KEY']) {
  // Non-fatal — analyzer will cascade to fallbacks
  console.warn('[groq] GROQ_API_KEY not set — Groq name classification disabled');
}

export const groq = new Groq({
  apiKey: process.env['GROQ_API_KEY'] ?? '',
});

// Fast, cheap model — sufficient for name classification
export const GROQ_MODEL = 'llama-3.1-8b-instant';
