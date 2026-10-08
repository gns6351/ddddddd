'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

/**
 * 연결마다 foreign_keys=ON (schema 주석), 삭제 내용 덮어쓰기(secure_delete), WAL.
 */
function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('secure_delete = ON');
  db.pragma('busy_timeout = 5000');
  const has = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='sessions'").get().c;
  if (!has) db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  if (db.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('foreign_keys pragma not enabled');
  return db;
}

/** BEGIN IMMEDIATE 트랜잭션 실행 */
function tx(db, fn) {
  return db.transaction(fn).immediate();
}

module.exports = { openDb, tx, SCHEMA_PATH };
