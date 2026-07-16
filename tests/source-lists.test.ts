import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

const MESSAGE_SOURCES = ["mattermost", "discord", "slack", "whatsapp", "telegram"];

describe("canonical message source lists", () => {
  it("keeps every production source available in configuration, documentation, and the owner UI", async () => {
    const [config, structure, contactEditor] = await Promise.all([
      fs.readFile("src/config.ts", "utf8"),
      fs.readFile("src/WORKSPACE_FOLDER_STRUCTURE.md", "utf8"),
      fs.readFile("web/src/pages/contact-editor.tsx", "utf8"),
    ]);

    for (const source of MESSAGE_SOURCES) {
      expect(config, `configuration omits ${source}`).toContain(`"${source}"`);
      expect(structure, `workspace documentation omits ${source}`).toContain(source);
      expect(contactEditor, `owner contact editor omits ${source}`).toContain(`"${source}"`);
    }
  });
});
