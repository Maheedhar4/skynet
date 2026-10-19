/**
 * Lazy GoogleGenAI factory — one client for the process. Throws a typed error
 * with a helpful message when GEMINI_API_KEY is missing (Google free tier key
 * from https://aistudio.google.com/apikey).
 */
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';

export class ZeroKeyError extends Error {
  constructor() {
    super('GEMINI_API_KEY is not set (add it to .env, Google AI Studio free tier).');
    this.name = 'ZeroKeyError';
  }
}

let client: GoogleGenAI | null = null;

export function genaiFactory(): GoogleGenAI {
  if (!config.geminiApiKey) throw new ZeroKeyError();
  client ??= new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

export function hasGeminiKey(): boolean {
  return Boolean(config.geminiApiKey);
}
