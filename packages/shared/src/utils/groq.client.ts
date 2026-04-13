import Groq from 'groq-sdk';

if (!process.env['GROQ_API_KEY']) {
  console.warn('[groq] GROQ_API_KEY not set — Groq name classification disabled');
}

export const groq = new Groq({
  apiKey: process.env['GROQ_API_KEY'] ?? '',
});

export const GROQ_MODEL = 'llama-3.1-8b-instant';
