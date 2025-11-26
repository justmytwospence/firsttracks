import log from "loglevel";

const level = process.env.LOG_LEVEL || "info";
log.setLevel(level as log.LogLevelDesc);

// Enhanced logger with debug capabilities
export const baseLogger = {
  ...log,
  
  // Debug method with structured data support
  debugSync: (message: string, data?: any, category?: string) => {
    if (log.getLevel() <= log.levels.DEBUG) {
      const prefix = category ? `[${category.toUpperCase()}]` : '[DEBUG]';
      if (data) {
        log.debug(`${prefix} ${message}`, JSON.stringify(data, null, 2));
      } else {
        log.debug(`${prefix} ${message}`);
      }
    }
  },

  // API request/response logging
  apiRequest: (method: string, url: string, headers?: any) => {
    log.debug(`[API] ${method} ${url}`, headers ? { headers } : undefined);
  },

  apiResponse: (method: string, url: string, status: number, duration?: number) => {
    const durationText = duration ? ` (${duration}ms)` : '';
    log.debug(`[API] ${method} ${url} -> ${status}${durationText}`);
  },



  // Performance timing
  time: (label: string) => {
    if (typeof performance !== 'undefined') {
      console.time(label);
    }
  },

  timeEnd: (label: string) => {
    if (typeof performance !== 'undefined') {
      console.timeEnd(label);
    }
  },
};
