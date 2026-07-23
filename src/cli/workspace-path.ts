#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildWorkspacePaths,
  resolveWorkspaceTarget,
  type HostedProjectProvider,
  type WorkspaceTarget,
} from "../workspace.js";

const usage = `Usage:
  felix-workspace-path file-collection <collection> [relative]
  felix-workspace-path local-project <project> [relative]
  felix-workspace-path hosted-project <github|gitlab> <namespace[/group...]> <repo> [relative]
  felix-workspace-path session-work <thread-dir> <work-name> [relative]
  felix-workspace-path session-attachment <thread-dir> <filename>`;

export async function resolveWorkspacePathCommand(
  args: string[],
  workspaceDir: string,
  currentThreadDir?: string,
): Promise<string> {
  if (!path.isAbsolute(workspaceDir)) {
    throw new Error("WORKSPACE_DIR must be an absolute path");
  }
  const target = parseTarget(args);
  if (target.kind === "session_work" || target.kind === "session_attachment") {
    if (!currentThreadDir || path.resolve(target.threadDir) !== path.resolve(currentThreadDir)) {
      throw new Error("Session target must use the active thread directory");
    }
  }
  return resolveWorkspaceTarget(buildWorkspacePaths(workspaceDir), target);
}

function parseTarget(args: string[]): WorkspaceTarget {
  const [command, ...values] = args;
  switch (command) {
    case "file-collection":
      requireArity(command, values, 1, 2);
      return { kind: "file_collection", collection: values[0]!, relative: values[1] };
    case "local-project":
      requireArity(command, values, 1, 2);
      return { kind: "local_project", project: values[0]!, relative: values[1] };
    case "hosted-project": {
      requireArity(command, values, 3, 4);
      const namespace = values[1]!.split("/");
      if (namespace.some((segment) => segment === "")) throw new Error(usage);
      return {
        kind: "hosted_project",
        provider: values[0] as HostedProjectProvider,
        namespace,
        repo: values[2]!,
        relative: values[3],
      };
    }
    case "session-work":
      requireArity(command, values, 2, 3);
      return { kind: "session_work", threadDir: values[0]!, workName: values[1]!, relative: values[2] };
    case "session-attachment":
      requireArity(command, values, 2, 2);
      return { kind: "session_attachment", threadDir: values[0]!, filename: values[1]! };
    default:
      throw new Error(usage);
  }
}

function requireArity(command: string, values: string[], minimum: number, maximum: number): void {
  if (values.length < minimum || values.length > maximum) {
    throw new Error(`Invalid arguments for ${command}.\n${usage}`);
  }
}

async function main(): Promise<void> {
  const workspaceDir = process.env.WORKSPACE_DIR;
  if (!workspaceDir) throw new Error("WORKSPACE_DIR is required");
  process.stdout.write(
    `${await resolveWorkspacePathCommand(process.argv.slice(2), workspaceDir, process.env.FELIX_THREAD_DIR)}\n`,
  );
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
