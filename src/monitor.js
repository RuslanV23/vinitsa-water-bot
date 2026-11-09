import { hashArticle, isVinitsa, sofiaDate } from './source.js';

export function messageFor(article, updated) {
  return [
    updated ? '🔄 Обновление объявления о воде — Виница' : '🚰 Отключение воды — Виница',
    `Опубликовано: ${article.date.split('-').reverse().join('.')}`,
    article.title, '', article.text, '',
    'Время в объявлении указано по Варне (Болгария).',
    `Источник: ${article.url}`,
  ].join('\n');
}

export async function processArticles({ articles, state, send, persist, now = new Date(), complete = true }) {
  const today = sofiaDate(now);
  let sent = 0;
  for (const article of [...articles].sort((a, b) => a.date.localeCompare(b.date) || a.url.localeCompare(b.url))) {
    const previous = state.entries[article.url];
    const hash = hashArticle(article);
    if (previous?.hash === hash) continue;
    const relevant = isVinitsa(`${article.title} ${article.text}`);
    const changed = Boolean(previous);
    // В первый запуск не рассылаем старый архив. Позже сообщаем и пропущенные новые записи.
    const notify = (relevant || previous?.relevant) && (changed || state.initialized || article.date >= today);
    if (notify) {
      await send(messageFor(article, changed));
      sent++;
    }
    // Запись считается обработанной только после успешной доставки всех частей сообщения.
    state.entries[article.url] = { hash, relevant, date: article.date };
    await persist(state);
  }
  if (!complete) return sent;
  state.initialized = true;
  await persist(state);
  if (!state.startupNotified) {
    await send('✅ Бот следит за объявлениями ВиК Варна о Винице.\nПроверка по расписанию каждые 20 минут. GitHub может задерживать запуски.\nСегодняшние объявления отправлены отдельно, старый архив сохранён без рассылки.\nСообщения появятся при новых объявлениях и изменениях.');
    state.startupNotified = true;
    await persist(state);
  }
  return sent;
}
