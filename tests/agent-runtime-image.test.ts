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
      "ffmpeg",
      "git",
      "jq",
      "pandoc",
      "poppler-utils",
      "ghostscript",
      "imagemagick",
      "python3",
      "python3-pip",
      "python3-venv",
      "unzip",
      "zip",
    ]) {
      expect(dockerfile).toContain(aptPackage);
    }
    // No compiler toolchain in any stage: nothing in the dependency tree needs node-gyp
    // (sqlite uses the node:sqlite built-in), and runtime pip installs are wheels-only.
    expect(dockerfile).not.toContain("build-essential");
    expect(dockerfile).not.toContain("python3-dev");
  });

  it("installs and verifies the core data stack at build time", async () => {
    const dockerfile = await read("Dockerfile");

    expect(dockerfile).toContain("python3 -m pip install --no-cache-dir --break-system-packages --only-binary=:all:");
    for (const pipPackage of [
      "lxml",
      "markitdown",
      "matplotlib",
      "numpy",
      "openpyxl",
      "pandas",
      "pdfplumber",
      "pillow",
      "pypdf",
      "python-dateutil",
      "reportlab",
      "requests",
      "seaborn",
      "xlsxwriter",
    ]) {
      expect(dockerfile).toContain(pipPackage);
    }
    expect(dockerfile).toContain("python core data + office stack ok");
  });

  it("routes shared runtime tooling through workspace runtime paths", async () => {
    const dockerfile = await read("Dockerfile");

    expect(dockerfile).toContain("PYTHONUSERBASE=/home/node/runtime/python");
    // Shared binaries, npm-installed CLIs, and the Python user base are all on PATH.
    expect(dockerfile).toContain("/home/node/runtime/bin:");
    expect(dockerfile).toContain("/home/node/runtime/npm/bin:");
    expect(dockerfile).toContain("/home/node/runtime/python/bin:$PATH");
  });

  it("runs as the default node user, no custom uid/gid build args", async () => {
    const dockerfile = await read("Dockerfile");

    expect(dockerfile).toContain("USER node");
    expect(dockerfile).not.toContain("ARG AGENT_UID");
    expect(dockerfile).not.toContain("ARG AGENT_GID");
  });

  it("installs whisper-cli and piper TTS binaries", async () => {
    const dockerfile = await read("Dockerfile");

    // whisper-cli — speech-to-text
    expect(dockerfile).toContain("whisper-cli installed ok");
    expect(dockerfile).toContain("ln -s /opt/whisper.cpp/whisper-cli /usr/local/bin/whisper-cli");

    // piper — text-to-speech
    expect(dockerfile).toContain("piper installed ok");
    expect(dockerfile).toContain("ln -s /opt/piper/piper /usr/local/bin/piper");
  });

});
