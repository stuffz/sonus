import { createConsola, LogLevels } from "consola";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

const logsDir = join(process.cwd(), "logs");
mkdirSync(logsDir, { recursive: true });

function getLogFilename() {
  const date = new Date().toISOString().split("T")[0];
  return join(logsDir, `sonus-${date}.log`);
}

function serializeArg(arg: unknown): string {
  if (arg instanceof Error) {
    // Error properties are non-enumerable; JSON.stringify produces "{}"
    const parts = [arg.message || arg.name || "(unknown error)"];
    if (arg.stack) parts.push(`\n${arg.stack}`);
    return parts.join("");
  }
  if (typeof arg === "object" && arg !== null) {
    // Check for error-like objects (e.g. { message, stack })
    const obj = arg as Record<string, unknown>;
    if ("message" in obj || "stack" in obj) {
      const parts: string[] = [];
      if (obj.message) parts.push(typeof obj.message === "string" ? obj.message : JSON.stringify(obj.message));
      // Include other enumerable properties
      const rest = { ...obj };
      delete rest.message;
      delete rest.stack;
      if (Object.keys(rest).length > 0) parts.push(JSON.stringify(rest));
      if (obj.stack) parts.push(`\n${typeof obj.stack === "string" ? obj.stack : JSON.stringify(obj.stack)}`);
      return parts.join(" ") || JSON.stringify(arg);
    }
    return JSON.stringify(arg);
  }
  return String(arg);
}

function formatLogLine(logObj: { date: Date; type: string; tag?: string; args: unknown[] }) {
  const timestamp = logObj.date.toISOString();
  const level = logObj.type.toUpperCase().padEnd(5);
  const tag = logObj.tag ? `[${logObj.tag}] ` : "";
  const message = logObj.args.map(serializeArg).join(" ");
  return `${timestamp} ${level} ${tag}${message}\n`;
}

export const logger = createConsola({
  level: LogLevels[process.env.LOG_LEVEL as keyof typeof LogLevels] ?? LogLevels.info,
  formatOptions: {
    date: true,
  },
  reporters: [
    { log: (logObj) => console.log(formatLogLine(logObj).trim()) },
    { log: (logObj) => appendFileSync(getLogFilename(), formatLogLine(logObj)) },
  ],
}).withTag("sonus");
