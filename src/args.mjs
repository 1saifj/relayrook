import { fail, ERROR_CODES } from './errors.mjs';

/**
 * Minimal, dependency-free flag parser.
 *
 * Supports `--flag`, `--flag=value`, `--flag value`, `--no-flag` and repeated
 * flags (collected into an array). Everything after a bare `--` is positional.
 *
 * @param {string[]} argv
 * @param {{booleans?: string[]}} [options]
 */
export function parseArgs(argv, options = {}) {
  const booleans = new Set(options.booleans ?? []);
  /** @type {Record<string, any>} */
  const flags = {};
  /** @type {string[]} */
  const positionals = [];
  let passthrough = false;

  const setFlag = (name, value) => {
    if (Object.hasOwn(flags, name)) {
      const current = flags[name];
      flags[name] = Array.isArray(current) ? [...current, value] : [current, value];
    } else {
      flags[name] = value;
    }
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (passthrough) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    if (body.length === 0) continue;
    const eq = body.indexOf('=');
    if (eq !== -1) {
      setFlag(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    if (body.startsWith('no-')) {
      setFlag(body.slice(3), false);
      continue;
    }
    if (booleans.has(body)) {
      setFlag(body, true);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      setFlag(body, true);
      continue;
    }
    setFlag(body, next);
    i += 1;
  }

  return { flags, positionals };
}

/**
 * @param {Record<string, any>} flags
 * @param {string} name
 * @returns {string|undefined}
 */
export function flagString(flags, name) {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return String(value[value.length - 1]);
  if (typeof value === 'boolean') {
    throw fail(ERROR_CODES.usage, `--${name} requires a value`);
  }
  return String(value);
}

/**
 * @param {Record<string, any>} flags
 * @param {string} name
 * @returns {string}
 */
export function requireFlag(flags, name) {
  const value = flagString(flags, name);
  if (value === undefined || value === '') {
    throw fail(ERROR_CODES.usage, `--${name} is required`);
  }
  return value;
}

/**
 * @param {Record<string, any>} flags
 * @param {string} name
 * @param {boolean} [fallback]
 */
export function flagBool(flags, name, fallback = false) {
  const value = flags[name];
  if (value === undefined) return fallback;
  const last = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof last === 'boolean') return last;
  const text = String(last).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

/**
 * @param {Record<string, any>} flags
 * @param {string} name
 * @param {number} fallback
 */
export function flagNumber(flags, name, fallback) {
  const value = flagString(flags, name);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw fail(ERROR_CODES.usage, `--${name} must be a number`);
  return n;
}

/**
 * @param {Record<string, any>} flags
 * @param {string} name
 * @returns {string[]}
 */
export function flagList(flags, name) {
  const value = flags[name];
  if (value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .filter((item) => typeof item === 'string')
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}
