import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function read(path: string): Promise<string> {
  return fs.readFile(path, "utf8");
}

describe("agent runtime image contract", () => {
  it("keeps the Node Bookworm runtime base and provider-neutral batteries", async () => {
    const dockerfile = await read("Dockerfile");

    expect(dockerfile).toContain("FROM node:24-bookworm-slim AS runtime");
    for (const aptPackage of [
      "build-essential",
      "git",
      "jq",
      "poppler-utils",
      "ghostscript",
      "imagemagick",
      "python3",
      "python3-dev",
      "python3-pip",
      "python3-venv",
      "unzip",
      "zip",
    ]) {
      expect(dockerfile).toContain(aptPackage);
    }
  });

  it("installs and verifies the core data stack at build time", async () => {
    const dockerfile = await read("Dockerfile");

    expect(dockerfile).toContain("python3 -m pip install --no-cache-dir --break-system-packages");
    for (const pipPackage of [
      "matplotlib",
      "numpy",
      "openpyxl",
      "pandas",
      "pillow",
      "python-dateutil",
      "requests",
      "seaborn",
      "xlsxwriter",
    ]) {
      expect(dockerfile).toContain(pipPackage);
    }
    expect(dockerfile).toContain("python core data stack ok");
  });

  it("routes shared runtime tooling through workspace runtime paths", async () => {
    const dockerfile = await read("Dockerfile");

    expect(dockerfile).toContain("PYTHONUSERBASE=/home/node/workspace/runtime/python");
    // Shared binaries, npm-installed CLIs, and the Python user base are all on PATH.
    expect(dockerfile).toContain("/home/node/workspace/runtime/bin:");
    expect(dockerfile).toContain("/home/node/workspace/runtime/npm/bin:");
    expect(dockerfile).toContain("/home/node/workspace/runtime/python/bin:$PATH");
  });

  it("runs as the default node user, no custom uid/gid build args", async () => {
    const dockerfile = await read("Dockerfile");

    expect(dockerfile).toContain("USER node");
    expect(dockerfile).not.toContain("ARG AGENT_UID");
    expect(dockerfile).not.toContain("ARG AGENT_GID");
  });

  it("documents exclusions for provider CLIs, LibreOffice, and browser runtimes in the ADR", async () => {
    // The ADR is the canonical contract; the README intentionally stays lean.
    const adr = await read("docs/adr/0002-agent-runtime-image-contract.md");

    expect(adr).toContain("Provider-specific operational CLIs");
    const normalized = adr.toLowerCase();
    expect(normalized).toContain("aws");
    expect(normalized).toContain("gcloud");
    expect(normalized).toContain("kubectl");
    expect(normalized).toContain("terraform");
    expect(adr).toContain("LibreOffice");
    expect(adr).toContain("browser automation");
  });
});
