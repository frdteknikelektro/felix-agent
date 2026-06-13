import { describe, expect, it } from "vitest";
import { storedAttachmentPath } from "../src/core/attachments.js";

describe("attachment storage paths", () => {
  it("keeps same-name attachments distinct when file ids differ", () => {
    const first = storedAttachmentPath(
      "/workspace/session/attachments",
      "2026-05-25T00:01:00.000Z",
      "image.png",
      "file-a",
    );
    const second = storedAttachmentPath(
      "/workspace/session/attachments",
      "2026-05-25T00:01:00.000Z",
      "image.png",
      "file-b",
    );

    expect(first).toContain("file-a_image.png");
    expect(second).toContain("file-b_image.png");
    expect(first).not.toBe(second);
  });
});
