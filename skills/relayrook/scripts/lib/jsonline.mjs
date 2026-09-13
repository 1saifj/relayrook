import { fail, ERROR_CODES } from './errors.mjs';

export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Newline-delimited JSON reader with a hard per-line byte ceiling.
 *
 * ACP agents stream large tool payloads; without a ceiling a single malformed
 * or pathological line can grow the buffer until the process dies. On overflow
 * we drop the partial line, emit a typed `line_overflow` error to the consumer,
 * and resynchronise at the next newline rather than throwing away the stream.
 */
export class JsonLineReader {
  /**
   * @param {{maxLineBytes?: number, onMessage: (msg: any) => void, onError?: (err: Error) => void}} options
   */
  constructor(options) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.onMessage = options.onMessage;
    this.onError = options.onError ?? (() => {});
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0);
    this.skipping = false;
    this.droppedLines = 0;
  }

  /** @param {Buffer|string} chunk */
  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);

    for (;;) {
      const nl = this.buffer.indexOf(0x0a);
      if (nl === -1) break;
      const line = this.buffer.subarray(0, nl);
      this.buffer = this.buffer.subarray(nl + 1);
      if (this.skipping) {
        this.skipping = false;
        continue;
      }
      this.#handleLine(line);
    }

    if (this.skipping) {
      // Everything before the next newline is still part of the dropped line,
      // so it is discarded rather than allowed to grow the buffer again.
      this.buffer = Buffer.alloc(0);
      return;
    }

    if (this.buffer.length > this.maxLineBytes) {
      this.droppedLines += 1;
      this.skipping = true;
      const size = this.buffer.length;
      this.buffer = Buffer.alloc(0);
      this.onError(
        fail(ERROR_CODES.line_overflow, `Dropped a protocol line larger than ${this.maxLineBytes} bytes`, {
          bytesSeen: size,
          maxLineBytes: this.maxLineBytes,
        }),
      );
    }
  }

  /** @param {Buffer} line */
  #handleLine(line) {
    if (line.length === 0) return;
    if (line.length > this.maxLineBytes) {
      this.droppedLines += 1;
      this.onError(
        fail(ERROR_CODES.line_overflow, `Dropped a protocol line larger than ${this.maxLineBytes} bytes`, {
          bytesSeen: line.length,
          maxLineBytes: this.maxLineBytes,
        }),
      );
      return;
    }
    const text = line.toString('utf8').trim();
    if (text === '') return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.onError(
        fail(ERROR_CODES.protocol_error, `Unparseable protocol line: ${err instanceof Error ? err.message : err}`, {
          preview: text.slice(0, 200),
        }),
      );
      return;
    }
    this.onMessage(parsed);
  }
}

/**
 * @param {unknown} message
 * @returns {string}
 */
export function encodeJsonLine(message) {
  return `${JSON.stringify(message)}\n`;
}
