import type { SchedulerJob } from "./schemas.js";

export interface SchedulerExecutionRequest {
  job: SchedulerJob;
  executionId: string;
  signal: AbortSignal;
}

export interface SchedulerExecutionResult {
  status: "success" | "failed" | "paused";
  sessionId?: string;
  exitCode?: number;
  logPath?: string;
  output?: string;
  error?: string;
  missingPermissions?: string[];
}

export interface SchedulerExecutor {
  run(request: SchedulerExecutionRequest): Promise<SchedulerExecutionResult>;
}
