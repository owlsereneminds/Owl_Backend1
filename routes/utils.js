import fs from 'fs/promises';
import path from 'path';

export async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    // ignore
  }
}

export function parseAllowedOrigins(env) {
  if (!env) return [];
  return env.split(',').map(s => s.trim()).filter(Boolean);
}