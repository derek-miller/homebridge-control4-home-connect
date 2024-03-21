import { Logger, LogLevel } from 'homebridge';

export function loggerWithPrefix(logger: Logger, prefix: string): Logger {
  return {
    debug(message: string, ...parameters: never[]): void {
      logger.debug(prefix, message, ...parameters);
    },
    error(message: string, ...parameters: never[]): void {
      logger.error(prefix, message, ...parameters);
    },
    info(message: string, ...parameters: never[]): void {
      logger.info(prefix, message, ...parameters);
    },
    log(level: LogLevel, message: string, ...parameters: never[]): void {
      logger.log(level, prefix, message, ...parameters);
    },
    warn(message: string, ...parameters: never[]): void {
      logger.warn(prefix, message, ...parameters);
    },
  };
}
