/**
 * Tiny leveled logger. The ONLY place the codebase is allowed to write to
 * stdout/stderr — library and CLI code must use this, never `console.log`
 * (enforced by the `no-console` ESLint rule).
 *
 * Level resolves from the `LOG_LEVEL` env var: silent | info | verbose | debug.
 */

export type LogLevel = 'silent' | 'info' | 'verbose' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  info: 1,
  verbose: 2,
  debug: 3,
};

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return raw in LEVEL_ORDER ? (raw as LogLevel) : 'info';
}

export class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = resolveLevel()) {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  private enabled(min: LogLevel): boolean {
    return LEVEL_ORDER[this.level] >= LEVEL_ORDER[min];
  }

  private emit(stream: NodeJS.WriteStream, tag: string, min: LogLevel, args: unknown[]): void {
    if (!this.enabled(min)) return;
    const ts = new Date().toISOString();
    const body = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    stream.write(`[${ts}] ${tag} ${body}\n`);
  }

  log(...args: unknown[]): void {
    this.emit(process.stdout, 'LOG  ', 'info', args);
  }

  info(...args: unknown[]): void {
    this.emit(process.stdout, 'INFO ', 'info', args);
  }

  warn(...args: unknown[]): void {
    this.emit(process.stderr, 'WARN ', 'info', args);
  }

  error(...args: unknown[]): void {
    this.emit(process.stderr, 'ERROR', 'info', args);
  }

  verbose(...args: unknown[]): void {
    this.emit(process.stdout, 'VERB ', 'verbose', args);
  }

  debug(...args: unknown[]): void {
    this.emit(process.stderr, 'DEBUG', 'debug', args);
  }
}

/** Shared singleton — import this everywhere. */
export const logger = new Logger();
