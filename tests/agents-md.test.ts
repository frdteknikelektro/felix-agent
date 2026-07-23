import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const agentsMd = readFileSync(path.resolve(import.meta.dirname, "../src/AGENTS.md"), "utf8");

describe("AGENTS.md", () => {
  it("is a non-empty file", () => {
    expect(agentsMd.length).toBeGreaterThan(0);
  });

  it("contains no template placeholders", () => {
    expect(agentsMd).not.toContain("{{");
    expect(agentsMd).not.toContain("}}");
  });

  it("contains key sections", () => {
    expect(agentsMd).toContain("# AGENTS.md");
    expect(agentsMd).toContain("Core rules");
    expect(agentsMd).toContain("Workspace layout");
    expect(agentsMd).toContain("Key paths");
    expect(agentsMd).toContain("Permissions");
    expect(agentsMd).toContain("Skill invocation");
    expect(agentsMd).toContain("Turn structure");
  });

  // Regression guard: the security-critical contract was once silently dropped
  // from the turn prompt without any test failing. These assert it stays here —
  // the parser (parseAgentOutput) and the approval flow depend on it.
  it("carries the load-bearing behavior contract", () => {
    // Output format the parser expects
    expect(agentsMd).toContain("FELIX_REPLY");
    expect(agentsMd).toContain("END_FELIX_REPLY");
    expect(agentsMd).toContain("PERMISSION_REQUIRED");
    expect(agentsMd).toContain("END_PERMISSION_REQUIRED");
    expect(agentsMd).toContain("direct file-edit workflow");
    expect(agentsMd).toContain("is_owner");
    // Permission model — contact/request based, not thread-scoped
    expect(agentsMd).toContain("allowed_permissions");
    expect(agentsMd).toContain("contact-based");
    expect(agentsMd).toContain("request-based");
    expect(agentsMd).toContain("not thread-scoped");
    expect(agentsMd).not.toContain("owner_permission");
    // The server-computed gate is authoritative over disk-derivation
    expect(agentsMd).toContain("permissions_per_skill");
    // Scoped permission matching — exact scope or full wildcard, bare ≠ scoped
    expect(agentsMd).toContain("name.<scope>");
    expect(agentsMd).toContain("narrowest scope");
    // Refusal / safety rules
    expect(agentsMd).toContain("reveal secrets, credentials, tokens, env files");
    expect(agentsMd).toContain("filesystem-probing");
    expect(agentsMd).toContain("Never `source` a secret env file");
    // Session context pointer
    expect(agentsMd).toContain("initial_md");
    expect(agentsMd).toMatch(/AGENTS\.md.*(?:overrides|higher priority).*PERSONALITY\.md/i);
  });

  it("points audio attachments at the listen-speak skill", () => {
    expect(agentsMd).toContain("## Audio attachments");
    expect(agentsMd).toContain(".agents/skills/listen-speak/SKILL.md");
  });

  it("makes Memory always-on and retires Legacy wiki recall", () => {
    expect(agentsMd).toContain("## Always-on Memory");
    expect(agentsMd).toContain(".agents/skills/memory/SKILL.md");
    expect(agentsMd).toContain("MEMORY.md");
    expect(agentsMd).toContain("memory/daily/");
    expect(agentsMd).toContain("memory/weekly/");
    expect(agentsMd).toContain("memory/monthly/");
    expect(agentsMd).toContain("is_owner");
    expect(agentsMd).toContain("memory:write");
    expect(agentsMd).toContain("memory/wiki/` is inactive Legacy memory");
    expect(agentsMd).not.toContain("personal knowledge wiki");
  });

  it("defines computer use through the closed workspace placement contract", () => {
    expect(agentsMd).toContain("computer-using assistant");
    expect(agentsMd).toContain("perform the work");
    expect(agentsMd).toContain("verify");
    expect(agentsMd).toContain("WORKSPACE_FOLDER_STRUCTURE.md");
    expect(agentsMd).toContain("exhaustive placement contract");
    expect(agentsMd).toContain("projects/local/<project>/");
    expect(agentsMd).toContain("projects/<provider>/<namespace>/<repo>/");
    expect(agentsMd).toContain("files/<collection>/");
    expect(agentsMd).toContain("{thread_dir}/work/<work_name>/");
    expect(agentsMd).toContain("{thread_dir}/attachments/");
    expect(agentsMd).toContain("felix-workspace-path");
    expect(agentsMd).toMatch(/before every user-work filesystem mutation/i);
    expect(agentsMd).toContain("Skills cannot override");
    expect(agentsMd).toContain("explicit confirmation");
    expect(agentsMd).toContain("symbolic link");
    expect(agentsMd).not.toContain("Workspace root = `$HOME`");
  });
});
