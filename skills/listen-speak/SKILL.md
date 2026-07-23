---
name: listen-speak
description: >-
  Transcribe voice notes and handle audio attachments. Also provides TTS
  (text-to-speech) synthesis via piper. Use when the event contains
  audio attachments or the user asks to transcribe/synthesize audio.
metadata:
  author: felix-agent
  kind: operational
  version: "1.0.0"
  match: audio, voice, transcribe, transcription, speak, tts, voice note
---

# Listen & Speak

Builtin skill for audio I/O — voice-note transcription (STT) and text-to-speech (TTS).

## Permissions

No permissions required. Audio processing and generated replies remain inside
the active thread and its workspace-scoped runtime directories.

## STT — Voice-note transcription

Attachments appear in the turn prompt as `<local_path> (<content_type>)`. Classify each audio attachment and handle it as described below.

### Voice recordings

Audio attachments whose MIME type contains both `ogg` and `opus` (case-insensitive, e.g. `audio/ogg; codecs=opus`) are voice recordings — this is how most chat apps' built-in voice recorders encode them, and it's how you tell a voice message apart from an uploaded/shared audio file. If an audio attachment shows no MIME type, identify it first with `file <path>` or `ffprobe <path>` and classify by the detected codec.

A voice message IS the user talking to you, so always transcribe it and treat the transcript as the user's message content before answering.

1. Check duration: `ffprobe -v error -show_entries format=duration -of csv=p=0 <path>` — if it exceeds ~15 minutes, tell the user it's too long to auto-transcribe and ask for a shorter one instead. Do not attempt the transcription.
2. `whisper-cli` is already installed in the runtime image (no install step needed). Check for the **multilingual** model at `${WORKSPACE_DIR}/runtime/whisper-models/ggml-medium-q5_1.bin`; if missing, create the directory and download it once: `curl -fL -o <that path> https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_1.bin` — it persists in the workspace runtime so later turns reuse it. Do NOT substitute a `.en`-suffixed model, those are English-only and will mis-transcribe or fail on other languages.
3. Derive the intermediate WAV at `{thread_dir}/work/audio-transcription/<filename>.wav`, apply the Session-work rules in `WORKSPACE_FOLDER_STRUCTURE.md`, and convert to that path with `ffmpeg -i <input-path> -ar 16000 -ac 1 "$WAV_PATH"`.
4. Run `whisper-cli -m <model path> -f "$WAV_PATH" --no-timestamps` — if the conversation language is identifiable from context (e.g. the user's prior messages or the language they appear to be speaking), add `--language <ISO 639-1 code>` (e.g. `--language en`, `--language id`, `--language ja`) so whisper uses the correct language model; only omit `--language` if you truly cannot determine the language.
5. Use the printed transcript as the message content.

### Uploaded audio files

Any other `audio/*` attachment (MIME does not contain both `ogg` and `opus` — e.g. mp3, m4a, wav, aac) is an uploaded/shared audio file, not speech directed at you — treat it like a document. Do NOT auto-transcribe it.

1. First reply describing what you received: filename/local path, MIME type, and duration (same `ffprobe` command as above).
2. Only run the transcription flow (same whisper-cli/ffmpeg steps and 15-minute duration guard as above) if the user's accompanying text explicitly asks about the audio's content (e.g. "what does this say", "transcribe this", "summarize this recording").

## TTS — Text-to-speech

`piper` is installed in the runtime image. Use it to synthesize speech from text.

### Setup (first use only)

1. Choose a voice model from https://huggingface.co/rhasspy/piper-voices. For English, `en_US-lessac-medium` is a good default. For other languages, pick a matching voice (e.g. `id_ID-news_tts-medium` for Indonesian) — verify the exact name against the repo's `voices.json` before downloading.
2. Download the `.onnx` model file and its `.onnx.json` config:
   ```bash
   mkdir -p "${WORKSPACE_DIR}/runtime/piper-voices"
   curl -fL -o "${WORKSPACE_DIR}/runtime/piper-voices/en_US-lessac-medium.onnx" \
     "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx"
   curl -fL -o "${WORKSPACE_DIR}/runtime/piper-voices/en_US-lessac-medium.onnx.json" \
     "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"
   ```
3. The model persists in the workspace runtime so later turns reuse it.

### Synthesis

```bash
echo "<text to speak>" | piper \
  --model "${WORKSPACE_DIR}/runtime/piper-voices/<voice>.onnx" \
  --output_file "<output_path>.wav"
```

- Put intermediate audio under the current `{thread_dir}/work/speech-synthesis/` and the delivered file under the current `{thread_dir}/attachments/`; apply the corresponding rules in `WORKSPACE_FOLDER_STRUCTURE.md` before writing.
- Output is a WAV file. Convert to OGG/Opus for WhatsApp: `ffmpeg -i <path>.wav -c:a libopus <path>.ogg`
- Use `--length-scale` for speed (default 1.0, lower = faster), `--speaker` for multi-speaker models.
- Keep synthesized text under 500 characters for reasonable response times.

### Delivering audio replies

After synthesizing, deliver the audio file using the adapter's source-API posting capability (file upload). Mention that you're sending a voice reply in your `FELIX_REPLY` text.
