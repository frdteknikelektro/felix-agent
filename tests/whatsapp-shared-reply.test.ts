import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWhatsAppAdapter,
  isFelixMessage,
  startWhatsAppSource,
} from "../src/adapters/whatsapp/index.js";
import type { FelixEngine } from "../src/engine.js";
import { makeTestConfig } from "./helpers/workspace.js";

describe("WhatsApp shared-number reply detection", () => {
  it("does not treat an unprefixed message from the shared JID as Felix", async () => {
    const cfg = await makeTestConfig("wa-shared-reply-", {
      WHATSAPP_OWNER_JID: "bot@s.whatsapp.net",
    });
    const bin = path.join(cfg.paths.bin, "fake-wacli");
    await fs.mkdir(path.dirname(bin), { recursive: true });
    await fs.writeFile(bin, [
      "#!/bin/sh",
      "if [ \"$1\" = \"doctor\" ]; then",
      "  printf '%s\\n' '{\"data\":{\"linked_jid\":\"bot@s.whatsapp.net\",\"connected\":true}}'",
      "fi",
      "exit 0",
      "",
    ].join("\n"), "utf8");
    await fs.chmod(bin, 0o755);
    cfg.WHATSAPP_WACLI_BIN = bin;

    const adapter = createWhatsAppAdapter(cfg);
    const source = await startWhatsAppSource(cfg, {} as FelixEngine, adapter);
    try {
      expect(isFelixMessage({
        senderJid: "bot@s.whatsapp.net",
        text: "Owner note without prefix",
        mediaCaption: "",
      }, "Felix")).toBe(false);
    } finally {
      source.stop();
      await source.done;
    }
  });
});
