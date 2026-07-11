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
    // Permission model — contact/request based, not thread-scoped
    expect(agentsMd).toContain("allowed_permissions");
    expect(agentsMd).toContain("contact-based");
    expect(agentsMd).toContain("request-based");
    expect(agentsMd).toContain("not thread-scoped");
    expect(agentsMd).not.toContain("owner_permission");
    // The server-computed gate is authoritative over disk-derivation
    expect(agentsMd).toContain("permissions_per_skill");
    // Refusal / safety rules
    expect(agentsMd).toContain("reveal secrets, credentials, tokens, env files");
    expect(agentsMd).toContain("filesystem-probing");
    expect(agentsMd).toContain("Never `source` a secret env file");
    // Session context pointer
    expect(agentsMd).toContain("initial_md");
  });

  it("points audio attachments at the listen-speak skill", () => {
    expect(agentsMd).toContain("## Audio attachments");
    expect(agentsMd).toContain("catalog/skills/listen-speak/SKILL.md");
  });
});
