# What Wispr Flow does, and how Gloop Voice relates to it

Findings from static analysis of Wispr Flow 1.6.1102 for Windows (the public installer, fetched with `winget download`, never installed or run). Gloop Voice is an independent implementation of the same kind of product: no Wispr code, assets, prompts or services are used.

## Method

1. REA `inspect_pe_resources` located the installer payload (a Squirrel package in PE resource `DATA/131`); it was carved out and unpacked.
2. REA `analyze_javascript_application` built an application graph of `app.asar`: 213 files parsed, 1,474 modules. Coverage was partial: the 9.5 MB main-process bundle exhausted the analyzer's heap, so IPC handlers were not resolved in the graph.
3. That gap was filled by targeted reading of the extracted bundles (string tables, schema maps, log strings) and string-scanning the native helper. No native decompiler was configured, so the helper's internal constants are unknown.

Everything below is from shipped artifacts. Server-side behaviour (the speech and language models, their prompts) is not in the client and is unknown.

## Architecture

| Piece | Finding |
|---|---|
| Shell | Electron 42, React, electron-forge, Squirrel installer, Sequelize over SQLite (`flow.sqlite`, 170+ migrations) |
| Native helper | `Wispr Flow Helper.exe`, C# NativeAOT (Swift on macOS), JSON-schema-defined protocol of about 290 types |
| Helper transport | Child process; JSON messages on stdin and fd 3, `\|`-delimited with `+` escaping, 100,000-character cap, 3 s request timeout, keepalive and relaunch with backoff |
| Speech and formatting | Remote. gRPC bidirectional stream (`flow_api.v1.TranscriptionService/TranscribeStream`), HTTP fallbacks |
| Windows | Hub, floating status bar, overlay, scratchpad, context menu, feature tour, meeting recorder |

## Dictation pipeline

- **Capture**: `getUserMedia` in a renderer, 16 kHz mono, processing disabled, AudioWorklet in 640-sample (40 ms) blocks, sent as 16-bit PCM with a parallel Opus encode. No client VAD.
- **Request**: audio plus app name and URL, app category, up to 500 characters each side of the caret, selected text, dictionary lists, replacement and snippet maps, language list, per-category style, editing strength.
- **Response**: raw transcript, formatted text, final text to paste, timings, audio-quality signals.
- **Fallbacks**: parallel HTTP race when the stream lags, chunked HTTP, then a plain ASR endpoint. 35 s processing timeout.
- **Client-side text rules** (used when the server does not return final text): case-insensitive dictionary and snippet replacement; whole-utterance snippet match; lower-case the first letter mid-sentence unless it is a proper noun; strip the trailing full stop before lower-case text; leading and trailing space rules; drop the final full stop in casual chat; "press enter" at the end sends Enter.

## Shortcuts and timing

| Action | Windows default |
|---|---|
| Push to talk | Ctrl + Win |
| Hands-free | Ctrl + Win + Space |
| Command mode | Ctrl + Win + Alt |
| Paste last transcript | Shift + Alt + Z |
| Cancel | Esc |

- The helper forwards every key press and release; matching happens in Electron. A shortcut fires when the held set exactly equals a binding.
- One 500 ms window drives the gestures: a release sooner than that is a tap (dismissed with a "hold" hint unless a second press locks hands-free).
- An unrelated key within 1 s of starting cancels. Sessions are capped at 20 minutes.

## Inserting text

- Clipboard snapshot of all formats, write with clipboard-history exclusion formats, simulated Ctrl + V, short sleep, restore unless the clipboard changed.
- Failure causes tracked: clipboard write failed, modifiers still held, focus moved, target window elevated.
- Context comes from UI Automation (`TextPattern`, `ValuePattern` fallback); password fields return nothing.
- After pasting, the helper watches the field for edits and feeds corrections to dictionary learning.

## Product surface

Dictionary (vocabulary and "replace X with Y" rows), snippets (stored as dictionary rows), styles per app category (personal, work, email, other × formal, casual, very casual, excited), auto clean-up levels, history with audio retry, transforms on selected text, command mode, scratchpad notes, meeting notetaker, calendar, teams and billing.

## What Gloop Voice does the same way

- The gesture model: exact-set chord matching, the 500 ms tap window, double-tap lock, the 1 s other-key cancel, the 20-minute cap, the same default chords.
- 16 kHz mono capture in 40 ms blocks with processing off.
- Paste by clipboard snapshot and restore with the history-exclusion formats.
- Caret context from UI Automation and the same family of spacing rules.
- App categories mapped to writing styles; editing strengths.

## What Gloop Voice does differently

| Area | Wispr Flow | Gloop Voice |
|---|---|---|
| Speech recognition | Cloud | Local (Parakeet or Whisper via sherpa-onnx), or your own endpoint |
| Formatting | Cloud LLM | Local Gemma via llama.cpp, or your own endpoint; deterministic fallback |
| Keystrokes | Helper streams all key events to the app | Helper matches shortcuts itself; key identities never leave it |
| Line-break commands | Not advertised | "new line" and "new paragraph", applied outside the model |
| Model replies | Trusted | Rejected if not plausibly a clean-up of what was said |
| Accounts, sync, telemetry | Yes | None |
| Scope | Dictation, notes, meetings, teams | Dictation and command mode only |
