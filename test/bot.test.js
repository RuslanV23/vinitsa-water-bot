import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { articleUrl, collectArticles, fetchHtml, hashArticle, isVinitsa, parseArticle, parseListing, sofiaDate } from '../src/source.js';
import { createSender, requireCredentials, splitMessage, telegramCall } from '../src/telegram.js';
import { newState, readState, saveState } from '../src/state.js';
import { processArticles } from '../src/monitor.js';

const url = 'https://vikvarna.com/bg/messages/breakdown/123.html';
const now = new Date('2026-11-09T12:00:00Z');
const article = { url, title: 'Без вода', date: '2026-11-09', text: 'Без вода кв. Виница до 18.00 часа.' };
const listing = `<div id="main_content"><h1>Съобщения</h1><div class="list-item"><h2><a href="${url}?region_id=15">Без вода</a></h2><div class="list-item-date">09.11.2026 г.</div><div class="list-item-text">Част от района ...</div></div></div>`;
const detail = '<header>Виница</header><div id="main_content"><h1>Без вода</h1><div class="list-item-date">09.11.2026 г.</div><div class="view"><p>Без вода&nbsp;кв.&quot;Виница&quot;</p><p>До 18.00 ч.<br>Промяна</p><p class="link-subscribe">Виж всички съобщения</p><div class="clear"></div></div></div>';

function harness(state = newState()) {
  const messages = [];
  const saves = [];
  return { state, messages, saves, send: async (message) => messages.push(message),
    persist: async (value) => saves.push(structuredClone(value)), now };
}

test('Фильтр понимает болгарское название и границы слов', () => {
  for (const text of ['кв.Виница', 'ВИНИЦА', 'Виница-2', 'Vinitsa', 'Vinica', 'в Винице']) assert.ok(isVinitsa(text), text);
  for (const text of ['Виницата', 'Виничан', 'Млада гвардия', 'Невиница']) assert.equal(isVinitsa(text), false, text);
});

test('Список нормализует ссылки, а полный текст содержит район за пределами анонса', () => {
  assert.deepEqual(parseListing(listing), [{ url, date: '2026-11-09' }]);
  const result = parseArticle(detail, url);
  assert.ok(isVinitsa(result.text));
  assert.match(result.text, /До 18.00 ч.\nПромяна/u);
  assert.doesNotMatch(result.text, /Виж всички/u);
  assert.equal(articleUrl(`${url}?region_id=0`), url);
  assert.throws(() => articleUrl('https://example.com/bg/messages/breakdown/123.html'));
});

test('Посторонняя страница, неверная дата и пустой текст вызывают ошибку', () => {
  assert.throws(() => parseListing('<h1>Ошибка сервера</h1>'));
  assert.throws(() => parseListing(listing.replace('09.11.2026', '31.02.2026')));
  assert.throws(() => parseArticle('<div id="main_content"><h1>Без вода</h1></div>', url));
  const result = parseArticle(detail.replace('кв.&quot;Виница&quot;', 'Галата'), url);
  assert.equal(isVinitsa(result.text), false); // Упоминание в шапке не влияет на фильтр.
});

test('Проверяются обе категории и сохраняются доступные объявления при частичном сбое', async () => {
  const requests = [];
  const result = await collectArticles({ wait: async () => {}, getHtml: async (target) => {
    requests.push(target);
    if (target.includes('type=repair')) throw new Error('Источник временно недоступен');
    return target === url ? detail : listing;
  } });
  assert.equal(result.articles.length, 1);
  assert.equal(result.errors.length, 1);
  assert.ok(requests.some((target) => target.includes('type=repair')));
});

test('Чтение всех трёх страниц и повторная проверка известных объявлений', async () => {
  const requests = [];
  const old = 'https://vikvarna.com/bg/messages/breakdown/999.html';
  const result = await collectArticles({ knownUrls: [old], wait: async () => {}, getHtml: async (target) => {
    requests.push(target);
    if (target.includes('messages.html')) {
      const p = new URL(target).searchParams;
      const page = Number(p.get('page'));
      const offset = p.get('type') === 'repair' ? 100 : 0;
      return `<div id="main_content"><h1>Съобщения</h1>${Array.from({ length: 10 }, (_, i) =>
        `<div class="list-item"><h2><a href="/bg/messages/breakdown/${offset + page * 10 + i}.html">Без вода</a></h2><div class="list-item-date">09.11.2026 г.</div></div>`).join('')}</div>`;
    }
    return detail;
  } });
  assert.equal(result.articles.length, 61);
  assert.ok(requests.includes(old));
  assert.ok(requests.some((target) => target.includes('page=3')));
});

test('При первом запуске архив сохраняется без рассылки, сегодняшнее отправляется один раз', async () => {
  const h = harness();
  const old = { ...article, url: url.replace('123', '122'), date: '2026-11-08' };
  assert.equal(await processArticles({ ...h, articles: [article, old] }), 1);
  assert.equal(h.messages.length, 2); // Объявление и подтверждение запуска.
  assert.equal(Object.keys(h.state.entries).length, 2);
  await processArticles({ ...h, articles: [article, old] });
  assert.equal(h.messages.length, 2);
});

test('Изменение срока и удаление упоминания Виницы дают обновление', async () => {
  const h = harness();
  await processArticles({ ...h, articles: [article] });
  await processArticles({ ...h, articles: [{ ...article, text: article.text.replace('18.00', '21.00') }] });
  assert.match(h.messages.at(-1), /Обновление/u);
  assert.match(h.messages.at(-1), /21.00/u);
  await processArticles({ ...h, articles: [{ ...article, text: 'Водоподаването е възстановено.' }] });
  assert.match(h.messages.at(-1), /възстановено/u);
});

test('После запуска отправляются новые найденные записи, даже опубликованные вчера', async () => {
  const h = harness({ ...newState(), initialized: true, startupNotified: true });
  const sent = await processArticles({ ...h, articles: [{ ...article, date: '2026-11-08' }] });
  assert.equal(sent, 1);
});

test('Сбой отправки не помечает сообщение как доставленное', async () => {
  const h = harness();
  await assert.rejects(processArticles({ ...h, articles: [article], send: async () => { throw new Error('Telegram offline'); } }));
  assert.equal(h.state.entries[url], undefined);
  assert.equal(h.state.initialized, false);
  await processArticles({ ...h, articles: [article] });
  assert.equal(h.messages.length, 2);
});

test('При частичной загрузке инициализация не завершается, успешные записи сохраняются', async () => {
  const h = harness();
  await processArticles({ ...h, articles: [article], complete: false });
  assert.equal(h.messages.length, 1);
  assert.equal(h.state.initialized, false);
  assert.ok(h.state.entries[url]);
});

test('Пробелы не порождают обновления; дата учитывает часовой пояс Варны', () => {
  assert.equal(hashArticle(article), hashArticle({ ...article, text: article.text.replace('Без вода', 'Без\n  вода') }));
  assert.equal(sofiaDate(new Date('2026-11-08T22:30:00Z')), '2026-11-09');
});

test('История переживает перезапуск и повреждение не сбрасывает её молча', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'water-state-'));
  try {
    const path = join(dir, 'state.json');
    const h = harness();
    await processArticles({ ...h, articles: [article], persist: (state) => saveState(path, state) });
    const restarted = harness(await readState(path));
    await processArticles({ ...restarted, articles: [article] });
    assert.equal(restarted.messages.length, 0);
    await writeFile(path, '{broken');
    await assert.rejects(readState(path));
    await writeFile(path, '{"version":99}');
    await assert.rejects(readState(path));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Telegram: длинный текст разбивается без потери символов и используется нужный чат', async () => {
  const text = '🚰'.repeat(5000);
  assert.equal(splitMessage(text).join(''), text);
  assert.ok(splitMessage(text).every((chunk) => chunk.length <= 3500));
  const calls = [];
  const sender = createSender({ token: '123:fake', chatId: '42', wait: async () => {}, call: async (...args) => calls.push(args) });
  await sender(text);
  assert.equal(calls.length, 3);
  assert.equal(calls[0][2].chat_id, '42');
});

test('Telegram: повторять разрешается только явно отклонённую отправку с HTTP 429', async () => {
  let attempts = 0;
  const waits = [];
  const sender = createSender({ token: '123:fake', chatId: '42', wait: async (ms) => waits.push(ms), call: async () => {
    attempts++;
    if (attempts === 1) { const error = new Error('429'); error.retryAfter = 2; throw error; }
  } });
  await sender('Тест');
  assert.equal(attempts, 2);
  assert.equal(waits[0], 2000);
});

test('Ошибки Telegram не раскрывают токен, пропущенные настройки выявляются', async () => {
  const token = '123:super-secret';
  await assert.rejects(telegramCall(token, 'sendMessage', {}, async () => { throw new Error(`https://api.telegram.org/bot${token}`); }),
    (error) => !error.message.includes(token));
  await assert.rejects(telegramCall(token, 'sendMessage', {}, async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error_code: 401 }) })), /401/u);
  assert.throws(() => requireCredentials({}));
  assert.deepEqual(requireCredentials({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: '42' }), { token, chatId: '42' });
});

test('При временном сбое ВиК повторяет GET, после трёх ошибок завершает проверку с ошибкой', async () => {
  let attempts = 0;
  assert.equal(await fetchHtml(url, { wait: async () => {}, fetchImpl: async () => {
    if (++attempts < 3) throw new Error('offline');
    return { ok: true, text: async () => 'html' };
  } }), 'html');
  assert.equal(attempts, 3);
  await assert.rejects(fetchHtml(url, { wait: async () => {}, fetchImpl: async () => { throw new Error('offline'); } }), /3 попыток/u);
});

test('Ветка истории: создание, восстановление, отсутствие лишних коммитов и сохранение обновления', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'water-git-'));
  const remote = join(dir, 'remote.git');
  const checkout = join(dir, 'checkout');
  const git = (args, cwd = dir) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const run = (action) => execFileSync(process.execPath, [resolve('scripts/state-store.js'), action], { cwd: checkout, encoding: 'utf8' });
  try {
    git(['init', '--bare', remote]);
    await mkdir(checkout);
    git(['init', '-b', 'main'], checkout);
    git(['config', 'user.name', 'Test'], checkout);
    git(['config', 'user.email', 'test@example.com'], checkout);
    await writeFile(join(checkout, 'README.md'), 'Main branch must remain unchanged');
    git(['add', 'README.md'], checkout);
    git(['commit', '-m', 'Initial'], checkout);
    git(['remote', 'add', 'origin', remote], checkout);
    const main = git(['rev-parse', 'HEAD'], checkout);
    run('restore');
    const h = harness();
    await processArticles({ ...h, articles: [article], persist: (state) => saveState(join(checkout, '.runtime/state.json'), state) });
    run('save');
    const first = git(['rev-parse', 'refs/heads/bot-state'], remote);
    assert.equal(git(['ls-tree', '--name-only', first], remote), 'state.json');
    assert.equal(git(['rev-parse', 'HEAD'], checkout), main);
    await rm(join(checkout, '.runtime'), { recursive: true, force: true });
    run('restore');
    assert.deepEqual(JSON.parse(await readFile(join(checkout, '.runtime/state.json'), 'utf8')), h.state);
    run('save');
    assert.equal(git(['rev-parse', 'refs/heads/bot-state'], remote), first);
    h.state.entries[url].hash = 'a'.repeat(64);
    await saveState(join(checkout, '.runtime/state.json'), h.state);
    run('save');
    assert.notEqual(git(['rev-parse', 'refs/heads/bot-state'], remote), first);
    assert.equal(git(['rev-parse', 'HEAD'], checkout), main);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
