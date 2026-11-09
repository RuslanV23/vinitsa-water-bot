import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { setTimeout as sleep } from 'node:timers/promises';

export const ORIGIN = 'https://vikvarna.com';
export const SECTIONS = ['breakdown', 'repair'];
export const PAGES_PER_SECTION = 3;

export function normalize(text) {
  return text.normalize('NFKC').replace(/[\s\u200b\ufeff]+/gu, ' ').trim();
}

export function isVinitsa(text) {
  return /(?<!\p{L})(?:виниц[аыуе]|vinitsa|vinica)(?!\p{L})/iu.test(normalize(text));
}

export function hashArticle(article) {
  return createHash('sha256').update(normalize(`${article.title} ${article.date} ${article.text}`)).digest('hex');
}

export function parseDate(text) {
  const match = text.match(/(\d{2})\.(\d{2})\.(\d{4})/u);
  if (!match) throw new Error('Не удалось прочитать дату объявления: возможно, изменился сайт ВиК.');
  const [, day, month, year] = match;
  const iso = `${year}-${month}-${day}`;
  if (new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso) {
    throw new Error('Некорректная дата объявления ВиК.');
  }
  return iso;
}

export function sofiaDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function articleUrl(href) {
  const url = new URL(href, ORIGIN);
  if (url.origin !== ORIGIN || !/^\/bg\/messages\/(breakdown|repair)\/\d+\.html$/u.test(url.pathname)) {
    throw new Error('Неожиданная ссылка на объявление ВиК.');
  }
  // Параметры region_id/sub_region_id меняют навигацию, а не само объявление.
  return `${url.origin}${url.pathname}`;
}

export function parseListing(html) {
  const $ = load(html);
  const content = $('#main_content');
  if (!content.find('h1').length) throw new Error('На сайте ВиК не найден список объявлений.');
  const items = content.find('.list-item').toArray().map((node) => {
    const item = $(node);
    const href = item.find('h2 a').attr('href');
    if (!href) throw new Error('У объявления ВиК отсутствует ссылка.');
    return { url: articleUrl(href), date: parseDate(item.find('.list-item-date').text()) };
  });
  // Пустой неожиданный ответ нельзя принять за успешную проверку.
  if (!items.length && !/няма\s+(?:намерени\s+)?съобщения/iu.test(content.text())) {
    throw new Error('Список ВиК пуст или изменился формат страницы.');
  }
  return items;
}

export function parseArticle(html, url) {
  const $ = load(html);
  const main = $('#main_content');
  const title = normalize(main.find('h1').first().text());
  const body = main.find('.view').first().clone();
  body.find('script, style, .link-subscribe, .clear').remove();
  body.find('br').replaceWith('\n');
  body.find('p, div, li').append('\n');
  const text = body.text().split('\n').map(normalize).filter(Boolean).join('\n');
  if (!title || !text) throw new Error(`Не удалось прочитать полный текст: ${url}`);
  return { url: articleUrl(url), title, date: parseDate(main.find('.list-item-date').first().text()), text };
}

export async function fetchHtml(url, { fetchImpl = fetch, wait = sleep } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(20_000),
        headers: { 'User-Agent': 'VinitsaWaterNotifier/1.0 (+personal outage monitoring)', Accept: 'text/html' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch {
      if (attempt === 2) throw new Error(`Не удалось загрузить сайт ВиК после 3 попыток: ${url}`);
      await wait(1000 * (attempt + 1));
    }
  }
}

export async function collectArticles({ getHtml = fetchHtml, wait = sleep, knownUrls = [] } = {}) {
  const urls = new Set();
  const errors = [];
  // Читаем обе категории и несколько страниц: Виница может отсутствовать в кратком анонсе.
  for (const type of SECTIONS) {
    for (let page = 1; page <= PAGES_PER_SECTION; page++) {
      const url = `${ORIGIN}/bg/messages.html?region_id=0&sub_region_id=0&type=${type}&page=${page}`;
      let items;
      try { items = parseListing(await getHtml(url)); }
      catch (error) { errors.push(error.message); break; }
      let added = 0;
      for (const item of items) {
        if (!urls.has(item.url)) { urls.add(item.url); added++; }
      }
      if (!added || items.length < 10) break;
      await wait(200);
    }
  }
  for (const url of knownUrls) urls.add(articleUrl(url));
  const articles = [];
  for (const url of urls) {
    try { articles.push(parseArticle(await getHtml(url), url)); }
    catch (error) { errors.push(error.message); }
    await wait(200);
  }
  return { articles, errors };
}
