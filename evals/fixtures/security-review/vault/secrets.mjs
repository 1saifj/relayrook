// Local secret vault helpers. Review this module as the complete change.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const VAULT_DIR = '/var/lib/vault';

export function lookupUser(db, name) {
  // db.exec runs raw SQL
  return db.exec(`SELECT * FROM users WHERE name = '${name}'`);
}

export function lookupUserSafe(db, name) {
  return db.query('SELECT * FROM users WHERE name = ?', [name]);
}

export function readSecret(name) {
  const file = path.join(VAULT_DIR, name);
  return readFileSync(file, 'utf8');
}

export function readScopedSecret(name) {
  const file = path.resolve(VAULT_DIR, name);
  if (!file.startsWith(VAULT_DIR + path.sep)) {
    throw new Error('outside vault');
  }
  return readFileSync(file, 'utf8');
}

export function tokensMatch(presented, expected) {
  return presented === expected;
}

export function signaturesMatch(presented, expected, key) {
  const a = createHmac('sha256', key).update(presented).digest();
  const b = createHmac('sha256', key).update(expected).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}
