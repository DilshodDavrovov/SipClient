#!/usr/bin/env node
'use strict';

/**
 * delete-contacts-without-code.js — одним файлом, без зависимостей
 * (node:sqlite встроен в Node.js 22.5+, тот же движок, что использует сервер).
 *
 * Удаляет из базы ВСЕ контакты, у которых не заполнен код клиента
 * (code IS NULL или пустая строка). Перед удалением:
 *   1) делает консистентную резервную копию базы (VACUUM INTO);
 *   2) печатает, сколько контактов будет удалено, и первые 20 для контроля.
 *
 * Запуск:
 *   node delete-contacts-without-code.js                — удалить
 *   node delete-contacts-without-code.js --dry-run      — только показать, БЕЗ удаления
 *   node delete-contacts-without-code.js path\to\app.db — явный путь к базе
 *
 * Сервер останавливать не обязательно (база в режиме WAL), но удалённые
 * контакты пропадут из клиента после обновления списка.
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const explicitPath = args.find((a) => !a.startsWith('--'));

// Путь к базе: аргумент -> переменная окружения -> data/app.db рядом со
// скриптом (server/scripts/ -> server/data/) -> путь проекта по умолчанию.
const candidates = [
  explicitPath,
  process.env.DB_FILE,
  path.join(__dirname, '..', 'data', 'app.db'),
  'd:/MySite/SipClient/server/data/app.db',
].filter(Boolean);

const dbFile = candidates.find((p) => fs.existsSync(p));
if (!dbFile) {
  console.error('База не найдена. Укажите путь: node delete-contacts-without-code.js path\\to\\app.db');
  console.error('Проверял:\n  ' + candidates.join('\n  '));
  process.exit(1);
}

const NO_CODE = "code IS NULL OR TRIM(code) = ''";

const db = new DatabaseSync(dbFile);
db.exec('PRAGMA busy_timeout = 5000;');

try {
  const total = db.prepare('SELECT COUNT(*) AS c FROM contacts').get().c;
  const toDelete = db.prepare(`SELECT COUNT(*) AS c FROM contacts WHERE ${NO_CODE}`).get().c;

  console.log(`База: ${dbFile}`);
  console.log(`Всего контактов: ${total}, из них БЕЗ кода: ${toDelete}`);

  if (toDelete === 0) {
    console.log('Удалять нечего.');
    process.exit(0);
  }

  const sample = db.prepare(`
    SELECT id, company_name, manager_name, phone1 FROM contacts
    WHERE ${NO_CODE} ORDER BY id LIMIT 20
  `).all();
  console.log('\nПримеры удаляемых (первые 20):');
  for (const r of sample) {
    console.log(`  #${r.id}  ${r.company_name || '(без названия)'}  ${r.manager_name || ''}  ${r.phone1 || ''}`.trimEnd());
  }
  if (toDelete > sample.length) console.log(`  ... и ещё ${toDelete - sample.length}`);

  if (dryRun) {
    console.log('\n--dry-run: ничего не удалено.');
    process.exit(0);
  }

  // Консистентная резервная копия (VACUUM INTO делает снимок даже при
  // работающем сервере, в отличие от простого копирования файла в WAL).
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFile = dbFile + '.backup-' + stamp;
  db.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);
  console.log(`\nРезервная копия: ${backupFile}`);

  const info = db.prepare(`DELETE FROM contacts WHERE ${NO_CODE}`).run();
  const left = db.prepare('SELECT COUNT(*) AS c FROM contacts').get().c;
  console.log(`Удалено контактов: ${info.changes}. Осталось: ${left}.`);
} finally {
  db.close();
}
