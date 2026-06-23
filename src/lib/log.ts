type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldEmit(level: Level): boolean {
  const envLevel = (process.env.LOG_LEVEL ?? "info") as Level;
  const threshold = LEVEL_ORDER[envLevel] ?? LEVEL_ORDER.info;
  return (LEVEL_ORDER[level] ?? 1) >= threshold;
}

function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (!shouldEmit(level)) return;
  const { ts: _t, level: _l, event: _e, ...rest } = fields;
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...rest,
  };
  const line = JSON.stringify(payload);
  process.stderr.write(line + "\n");
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};

export function createLogger(ctx: Record<string, unknown>) {
  return {
    debug: (event: string, fields?: Record<string, unknown>) => log.debug(event, { ...ctx, ...fields }),
    info: (event: string, fields?: Record<string, unknown>) => log.info(event, { ...ctx, ...fields }),
    warn: (event: string, fields?: Record<string, unknown>) => log.warn(event, { ...ctx, ...fields }),
    error: (event: string, fields?: Record<string, unknown>) => log.error(event, { ...ctx, ...fields }),
  };
}
