import { appendFile } from 'node:fs/promises';
import { collectArticles, isVinitsa, sofiaDate } from './source.js';
import { createSender, requireCredentials } from './telegram.js';
import { readState, saveState } from './state.js';
import { processArticles } from './monitor.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const testMessage = process.argv.includes('--test-message');
  if (dryRun && testMessage) throw new Error('Выберите один режим запуска.');
  // Проверяем настройки до загрузки сайта, чтобы быстро обнаружить пропущенный секрет.
  const send = dryRun ? null : createSender(requireCredentials());
  if (testMessage) {
    await send('✅ Тестовое сообщение: бот ВиК Варна настроен и может писать в этот чат.\nЭто проверка связи, а не сообщение об отключении воды.');
    console.log('Тестовое сообщение отправлено.');
    return;
  }
  const statePath = process.env.STATE_FILE || '.runtime/state.json';
  const state = dryRun ? null : await readState(statePath);
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 14);
  const knownUrls = state ? Object.entries(state.entries)
    .filter(([, item]) => item.relevant && item.date >= sofiaDate(cutoff)).map(([url]) => url) : [];
  const { articles, errors } = await collectArticles({ knownUrls });
  const matching = articles.filter((article) => isVinitsa(`${article.title} ${article.text}`));
  console.log(`Прочитано полных объявлений: ${articles.length}. Упоминаний Виницы: ${matching.length}.`);
  if (dryRun) {
    console.log('Предпросмотр: Telegram не используется, история не изменяется.');
    for (const article of matching) console.log(`\n${article.date} | ${article.title}\n${article.text}\n${article.url}`);
    if (errors.length) throw new Error(`Не все страницы прочитаны:\n${errors.join('\n')}`);
    return;
  }
  const sent = await processArticles({ articles, state, send, persist: (next) => saveState(statePath, next), complete: errors.length === 0 });
  if (errors.length) throw new Error(`Часть страниц ВиК не прочитана. Доступные объявления обработаны, остальные будут проверены повторно:\n${errors.join('\n')}`);
  console.log(`Отправлено объявлений: ${sent}. Проверка завершена успешно.`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `Проверка ВиК Варна завершена.\n\nПолных объявлений: ${articles.length}. Упоминаний Виницы: ${matching.length}. Отправлено объявлений: ${sent}.\n\nВремя проверки: ${new Date().toISOString()} (UTC).\n`);
  }
}

main().catch((error) => { console.error(`Ошибка: ${error.message}`); process.exitCode = 1; });
