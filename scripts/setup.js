import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { access, writeFile } from 'node:fs/promises';
import { telegramCall } from '../src/telegram.js';

const rl = createInterface({ input: stdin, output: stdout });
try {
  try {
    await access('.env');
    throw new Error('Файл .env уже существует. Для изменения откройте его в Блокноте; помощник его не перезаписывает.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log('Токен вводится только на вашем компьютере. Не показывайте его другим.');
  const token = (await rl.question('Вставьте токен из @BotFather и нажмите Enter: ')).trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/u.test(token)) throw new Error('Неверный формат токена.');
  const bot = await telegramCall(token, 'getMe');
  const webhook = await telegramCall(token, 'getWebhookInfo');
  if (webhook.url) throw new Error('У этого бота уже настроен webhook. Создайте отдельного нового бота через BotFather.');
  console.log(`\nОткройте https://t.me/${bot.username} и отправьте боту /start.\nБот пока не отвечает — это нормально. Вернитесь в это окно после отправки.`);
  await rl.question('После отправки /start нажмите здесь Enter: ');
  const updates = await telegramCall(token, 'getUpdates', { timeout: 0, allowed_updates: ['message'] });
  const chats = new Map();
  for (const update of updates) {
    const message = update.message;
    if (message?.chat?.type === 'private' && /^\/start(?:@\w+)?(?:\s|$)/u.test(message.text || '')) {
      chats.set(String(message.chat.id), message.chat);
    }
  }
  if (!chats.size) throw new Error('Не найден /start. Отправьте его боту сейчас и запустите npm.cmd run setup ещё раз.');
  console.log('\nНайдены личные чаты:');
  for (const [id, chat] of chats) console.log(`ID ${id} — ${chat.first_name || ''} ${chat.username ? `(@${chat.username})` : ''}`);
  const chatId = (await rl.question('Введите ID своего чата из списка выше: ')).trim();
  if (!chats.has(chatId)) throw new Error('Выберите ID из списка.');
  await telegramCall(token, 'sendMessage', { chat_id: chatId, text: '✅ Настройка связи завершена. Теперь выполните шаги GitHub Actions из README.md. Это тест, а не сообщение об отключении воды.' });
  await writeFile('.env', `TELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_CHAT_ID=${chatId}\n`, { flag: 'wx', mode: 0o600 });
  console.log('\nГотово! Настройки сохранены в .env. ID чата:', chatId);
  console.log('Добавьте значения из .env в GitHub Secrets по инструкции README.md. Сам файл .env не загружайте.');
} catch (error) { console.error(`Ошибка: ${error.message}`); process.exitCode = 1; }
finally { rl.close(); }
