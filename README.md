# Murmur

Voice dictation for Windows that types into whatever app has focus, with speech recognition and AI clean-up running on your own machine.

Hold **Ctrl + Win**, speak, release. The text appears at the cursor.

## What it does

- **Push to talk** in any app. Double-tap, or press **Ctrl + Win + Space**, to stay on hands-free.
- **AI clean-up**: removes ums and repeats, applies "no, actually Wednesday" corrections, fixes punctuation. Four strengths from verbatim to heavy rewrite.
- **Styles per kind of app**: formal, casual or very casual for personal chat, work chat, email and everything else.
- **Command mode** (**Ctrl + Win + Alt**): select text and say how to change it, or say what to write.
- **Dictionary** for names and jargon, including how they get misheard. **Snippets** that expand a spoken phrase into saved text.
- **Voice commands**: "new line", "new paragraph", and "press enter" at the end to send.
- **Smart spacing**: reads the text around the cursor to add the right spaces and continue a sentence in lower case.
- **History** with search, word counts and a streak, stored locally.

## Privacy

Audio and text stay on the computer by default. Speech is transcribed by a local model and cleaned up by a local language model served on `127.0.0.1` with a per-run key. Nothing is uploaded unless you point a provider at a custom server in Settings. The app makes network requests only to download models you ask for.

## Install

Run `dist\Murmur Setup 0.1.0.exe`. The installer is not code-signed, so Windows SmartScreen will ask for confirmation.

First launch walks through downloading models:

| Download | Size | Needed |
|---|---|---|
| Parakeet TDT 0.6B v3 (speech) | 670 MB | Yes (or another speech model) |
| Gemma 3 4B (clean-up) | 2.5 GB | Optional |
| NVIDIA GPU acceleration | 660 MB | Optional, offered on NVIDIA machines |

Models are kept in `%LOCALAPPDATA%\Murmur\models`. Settings, history and logs are in `%APPDATA%\Murmur`.

## Develop

Requires Node 22+, the .NET 10 SDK, and Windows 10 or 11.

```
npm install
npm run resources     # builds the native helper, fetches llama.cpp, draws the icon
npm run dev           # run with hot reload
npm test              # unit tests
npm run test:prompts  # clean-up prompts against the installed local model
npm run test:hook     # global key hook against the real OS (modifier keys only)
npm run dist          # build the installer into dist/
```

Set `MURMUR_USER_DATA` to a scratch folder to run against a separate profile.

`MURMUR_SELFTEST=<output folder>` runs an end-to-end check in a dev build: it dictates recorded clips through the real helper and models into the app's own text box and writes `results.json` plus screenshots. It brings the Murmur window to the front while it runs.

## How it is built

| Part | Where | Role |
|---|---|---|
| Main process | `src/main` | Dictation state machine (`controller.ts`), settings, SQLite, model downloads |
| Speech | `src/main/asr` | sherpa-onnx in an Electron utility process |
| Language model | `src/main/llm` | Bundled llama.cpp server as a child process, or any OpenAI-compatible endpoint |
| Text pipeline | `src/main/text` | Clean-up, dictionary, snippets, spacing; pure functions |
| Native helper | `helper/Murmur.Helper` | C#: global key hook, paste, focused-app context over stdin/stdout JSON |
| Pill | `src/renderer/pill` | Floating indicator; also captures the microphone |
| Main window | `src/renderer/hub` | React UI |

`docs/reverse-engineering.md` records what was learned from Wispr Flow and how Murmur differs.

## Not included

Compared with Wispr Flow: no accounts, sync or teams; no meeting notetaker; no scratchpad notes; no automatic dictionary learning from your edits; no muting of other audio while dictating; no macOS build; no auto-update.
