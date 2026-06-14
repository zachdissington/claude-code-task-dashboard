/** pino logger — PM2-friendly (plain JSON to stdout, captured by PM2 log files). */

import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { module: "task-dashboard" },
});
