/**
 * Small orchestration seam for integrations that wrap gog. Keeping the
 * permission gate ahead of provider checks prevents auth and schema probes from
 * becoming an unauthorized side channel.
 */
export async function runGoogleWorkspaceOperation({
  checkPermission,
  checkAuth,
  discoverSchema,
  execute,
  needsSchema = false,
}) {
  if (!(await checkPermission())) {
    throw new Error("google_workspace_permission_required");
  }
  await checkAuth();
  const schema = needsSchema ? await discoverSchema() : undefined;
  return execute(schema);
}
