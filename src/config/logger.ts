import pino from "pino";
import { env } from "./env.js";

export const log = pino({
  redact: {
    paths: ["password", "token", "access_token", "refresh_token", "secret", "authorization", "headers.authorization", "headers.cookie", "req.headers.authorization", "req.headers.cookie"],
    censor: "[REDACTED]",
  },
  level: env.NODE_ENV === "production" ? "info" : "debug",
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});
