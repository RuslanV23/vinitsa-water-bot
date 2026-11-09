import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function newState() {
  return { version: 1, initialized: false, startupNotified: false, entries: {} };
}

export function validateState(state) {
  if (state?.version !== 1 || typeof state.initialized !== 'boolean' ||
      typeof state.startupNotified !== 'boolean' || !state.entries || Array.isArray(state.entries) ||
      typeof state.entries !== 'object') throw new Error('Повреждена история бота. Не удаляйте её: проверьте ветку bot-state.');
  for (const [url, entry] of Object.entries(state.entries)) {
    if (!/^https:\/\/vikvarna\.com\/bg\/messages\/(breakdown|repair)\/\d+\.html$/u.test(url) ||
        !/^[a-f0-9]{64}$/u.test(entry?.hash || '') || typeof entry?.relevant !== 'boolean' ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(entry?.date || '')) {
      throw new Error('Повреждена запись в истории бота. Проверьте ветку bot-state.');
    }
  }
  return state;
}

export async function readState(path) {
  try { return validateState(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return newState();
    if (error instanceof SyntaxError) throw new Error('История бота содержит некорректный JSON.');
    throw error;
  }
}

export async function saveState(path, state) {
  validateState(state);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(`${path}.tmp`, path);
}
