import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("shipped workspace placement contract", () => {
  it("documents every canonical user-work category as an exhaustive layout", async () => {
    const structure = await fs.readFile("src/WORKSPACE_FOLDER_STRUCTURE.md", "utf8");

    expect(structure).toContain("projects/local/<project>/");
    expect(structure).toContain("projects/<provider>/<namespace>/<repo>/");
    expect(structure).toContain("files/<collection>/");
    expect(structure).toContain("sessions/<source>/<sid>/work/<work_name>/");
    expect(structure).toContain("sessions/<source>/<sid>/attachments/");
    expect(structure).toContain("$WORKSPACE_DIR");
    expect(structure).toContain("exhaustive");
    expect(structure).toContain("must not introduce");
  });

  it("routes ordinary file work through general without permissions", async () => {
    const general = await fs.readFile("skills/general/SKILL.md", "utf8");

    expect(general).toContain("File Collection");
    expect(general).toContain("Session work");
    expect(general).toContain("No permissions required");
    expect(general).toContain("explicit confirmation");
    expect(general).toMatch(/derive.*complete target/is);
    expect(general).toContain("WORKSPACE_FOLDER_STRUCTURE.md");
    expect(general).not.toContain("Reply-only.");
  });

  it("distinguishes permission-free Local Projects from protected Hosted Projects", async () => {
    const softwareDevelopment = await fs.readFile("skills/software-development/SKILL.md", "utf8");

    expect(softwareDevelopment).toContain("projects/local/<project>");
    expect(softwareDevelopment).toContain("Local Project");
    expect(softwareDevelopment).toContain("no permission");
    expect(softwareDevelopment).toContain("Hosted Project");
    expect(softwareDevelopment).toContain("software-development:repo.write");
    expect(softwareDevelopment).toMatch(/before.*promot.*software-development:repo\.write/is);
    expect(softwareDevelopment).toMatch(/Local Project.*explicit confirmation.*no Owner permission/is);
    expect(softwareDevelopment).toContain("automatically promote");
  });

  it("routes specialized user-work artifacts through the instruction contract", async () => {
    for (const skill of ["felix-browser", "listen-speak", "office-documents", "database", "google-workspace"]) {
      const raw = await fs.readFile(`skills/${skill}/SKILL.md`, "utf8");
      expect(raw, skill).toContain("thread_dir");
    }
    const browserCommands = await fs.readFile("skills/felix-browser/references/commands.md", "utf8");
    const sshTransfer = await fs.readFile("skills/ssh/references/transfer.md", "utf8");
    expect(browserCommands).toContain("{thread_dir}/attachments/");
    expect(browserCommands).not.toContain('mkdir -p "$THREAD_DIR/attachments"');
    expect(sshTransfer).toContain("WORKSPACE_FOLDER_STRUCTURE.md");
  });
});
