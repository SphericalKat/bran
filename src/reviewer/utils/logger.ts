export type LogLevel = "debug" | "info" | "warn" | "error";

let currentLevel: LogLevel = "warn";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function timestamp(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, message: string): void {
  if (shouldLog(level)) {
    console.log(JSON.stringify({ timestamp: timestamp(), level, message }));
  }
}

export const logger = {
  debug(message: string): void {
    log("debug", message);
  },
  info(message: string): void {
    log("info", message);
  },
  warn(message: string): void {
    log("warn", message);
  },
  error(message: string): void {
    log("error", message);
  },
};
