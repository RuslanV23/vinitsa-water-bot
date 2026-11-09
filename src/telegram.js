import { setTimeout as sleep } from 'node:timers/promises';

export function requireCredentials(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/u.test(token)) {
    throw new Error('Не задан корректный TELEGRAM_BOT_TOKEN. См. инструкцию README.md.');
  }
  if (!chatId || !/^-?\d+$/u.test(chatId)) {
    throw new Error('Не задан корректный TELEGRAM_CHAT_ID. См. инструкцию README.md.');
  }
  return { token, chatId };
}

export async function telegramCall(token, method, payload = {}, fetchImpl = fetch) {
  let response;
  let result;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(25_000),
    });
    result = await response.json();
  } catch {
    // Ошибку fetch с URL печатать нельзя: URL Telegram содержит секретный токен.
    throw new Error('Нет ответа Telegram. Проверьте интернет и повторите запуск.');
  }
  if (!response.ok || !result.ok) {
    const code = result.error_code || response.status;
    const hints = {
      400: 'Проверьте ID чата и отправьте боту /start.',
      401: 'Неверный токен бота.',
      403: 'Бот заблокирован или ему запрещено писать в чат.',
      409: 'Этот токен уже используется другим получателем обновлений.',
      429: 'Telegram ограничил частоту сообщений. Повторите позже.',
    };
    const error = new Error(`Telegram: ошибка ${code}. ${hints[code] || 'Повторите позже.'}`);
    error.retryAfter = code === 429 ? result.parameters?.retry_after : undefined;
    throw error;
  }
  return result.result;
}

export function splitMessage(text, limit = 3500) {
  const chunks = [];
  let chunk = '';
  // Ограничиваем и UTF-16 длину, не разрывая пары суррогатов у emoji.
  for (const point of text) {
    if (chunk.length + point.length > limit) { chunks.push(chunk); chunk = ''; }
    chunk += point;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function createSender({ token, chatId, call = telegramCall, wait = sleep }) {
  return async (text) => {
    for (const chunk of splitMessage(text)) {
      try {
        await call(token, 'sendMessage', { chat_id: chatId, text: chunk, link_preview_options: { is_disabled: true } });
      } catch (error) {
        if (!Number.isInteger(error.retryAfter) || error.retryAfter < 1 || error.retryAfter > 60) throw error;
        await wait(error.retryAfter * 1000);
        await call(token, 'sendMessage', { chat_id: chatId, text: chunk, link_preview_options: { is_disabled: true } });
      }
      await wait(1100);
    }
  };
}
