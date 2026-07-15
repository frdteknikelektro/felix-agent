export function runGoogleWorkspaceOperation(input: {
  checkPermission: () => Promise<boolean>;
  checkAuth: () => Promise<unknown>;
  discoverSchema: () => Promise<unknown>;
  execute: (schema: unknown) => Promise<unknown>;
  needsSchema?: boolean;
}): Promise<unknown>;
