
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string): void;
}

export const NULL_LOGGER = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  log: (level: LogLevel, message: string): void => {
    return;
  },
};

export const CONSOLE_LOGGER = {
  log: (level: LogLevel, message: string): void => {
    switch (level) {
      case 'info':
        // eslint-disable-next-line no-console
        console.log(message);
        break;
      case 'warn':
        // eslint-disable-next-line no-console
        console.warn(message);
        break;
      case 'error':
        // eslint-disable-next-line no-console
        console.error(message);
        break;
      case 'debug':
        // eslint-disable-next-line no-console
        console.debug(message);
        break;
      default:
        // eslint-disable-next-line no-console
        console.error(`Unknown log level ${level}: ${message}`);
    }
  },
};
