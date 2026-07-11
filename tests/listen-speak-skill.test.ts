import fs from "node:fs";
import { describe, expect, it } from "vitest";

// Audio handling is instruction-driven: adapters no longer inject audio
// instructions into turn context — the LLM reads the listen-speak skill
// (pointed at from src/AGENTS.md). These assertions pin the load-bearing
// content of that skill so edits can't silently drop the contract.
const skillMd = fs.readFileSync("skills/listen-speak/SKILL.md", "utf8");

describe("listen-speak skill contract", () => {
  it("classifies voice notes by ogg+opus MIME", () => {
    expect(skillMd).toContain("ogg");
    expect(skillMd).toContain("opus");
    expect(skillMd).toContain("audio/ogg; codecs=opus");
  });

  it("guards transcription with the 15-minute ffprobe duration check", () => {
    expect(skillMd).toContain("ffprobe -v error -show_entries format=duration");
    expect(skillMd).toContain("15 minutes");
  });

  it("uses the multilingual whisper model, never an English-only one", () => {
    expect(skillMd).toContain("whisper-cli");
    expect(skillMd).toContain("ggml-medium-q5_1.bin");
    expect(skillMd).toContain("`.en`");
  });

  it("converts to 16kHz mono WAV and passes a language hint", () => {
    expect(skillMd).toContain("-ar 16000 -ac 1");
    expect(skillMd).toContain("--language");
  });

  it("forbids auto-transcribing uploaded audio files", () => {
    expect(skillMd).toContain("Do NOT auto-transcribe");
  });

  it("covers TTS via piper with downloadable voices and opus delivery", () => {
    expect(skillMd).toContain("piper");
    expect(skillMd).toContain("piper-voices");
    expect(skillMd).toContain("libopus");
  });
});
