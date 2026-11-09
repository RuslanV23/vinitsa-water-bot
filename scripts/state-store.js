// Ветка bot-state содержит только state.json: токен и ID чата сюда не попадают.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateState } from '../src/state.js';

const directory = '.runtime';
const stateFile = `${directory}/state.json`;
const parentFile = `${directory}/state-parent`;
const ref = 'refs/heads/bot-state';

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
}

try {
  mkdirSync(directory, { recursive: true });
  if (process.argv[2] === 'restore') {
    const remote = git(['ls-remote', '--heads', 'origin', ref]);
    if (!remote) {
      if (existsSync(stateFile)) throw new Error('Локальная история уже существует; используйте чистый checkout.');
      writeFileSync(parentFile, '');
      console.log('Первый запуск: ветка bot-state будет создана после проверки.');
    } else {
      git(['fetch', '--no-tags', '--depth=1', 'origin', ref]);
      const parent = git(['rev-parse', 'FETCH_HEAD']);
      const content = git(['show', `${parent}:state.json`]);
      validateState(JSON.parse(content));
      writeFileSync(stateFile, `${content}\n`);
      writeFileSync(parentFile, parent);
      console.log('История восстановлена из ветки bot-state.');
    }
  } else if (process.argv[2] === 'save') {
    // Не создавать новую историю, если восстановление или проверка не состоялись.
    if (!existsSync(parentFile) || !existsSync(stateFile)) {
      console.log('Сохранять нечего.');
      process.exit(0);
    }
    const content = readFileSync(stateFile, 'utf8');
    validateState(JSON.parse(content));
    const parent = readFileSync(parentFile, 'utf8').trim();
    if (parent && git(['show', `${parent}:state.json`]).trim() === content.trim()) {
      console.log('История не изменилась.');
      process.exit(0);
    }
    const env = {
      ...process.env, GIT_INDEX_FILE: resolve(directory, 'state-index'),
      GIT_AUTHOR_NAME: 'Water Bot', GIT_COMMITTER_NAME: 'Water Bot',
      GIT_AUTHOR_EMAIL: 'water-bot@users.noreply.github.com',
      GIT_COMMITTER_EMAIL: 'water-bot@users.noreply.github.com',
    };
    git(['read-tree', '--empty'], { env });
    const blob = git(['hash-object', '-w', stateFile]);
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},state.json`], { env });
    const tree = git(['write-tree'], { env });
    const args = ['commit-tree', tree];
    if (parent) args.push('-p', parent);
    const commit = git(args, { env, input: 'Update water alert history\n' });
    // Без force: конфликт не должен уничтожить более новую историю.
    git(['push', 'origin', `${commit}:${ref}`]);
    console.log('История сохранена в ветку bot-state.');
  } else throw new Error('Используйте restore или save.');
} catch {
  console.error('Не удалось прочитать/сохранить ветку bot-state. Проверьте доступность GitHub, разрешение Contents: write и правила защиты веток. Историю вручную не удаляйте.');
  process.exitCode = 1;
}
