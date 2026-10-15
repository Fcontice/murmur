# Command mode evolution: design

Date: 2026-10-14
Status: approved

Command mode (Ctrl + Win + Alt) today rewrites the selection or writes new text at the cursor. This round adds PC actions (open apps and sites, web search), saved commands, and on-screen context for writing commands. A command-only cloud model is deferred until the local results have been used for a while.

## Scope

In:
- Trigger-word routing between actions and writing.
- "Open X": your Sites list, installed apps, domains, then web search as a fallback.
- "Search for X" in the default browser with a configurable search engine.
- Saved commands: named instructions managed in a Commands page.
- Window text as context for writing commands when nothing is selected, sent only to the local model.

Out: media and volume control, window control, follow-ups on the last result, preview-before-insert, a command-only cloud model.

## Routing

`routeCommand(transcript, savedCommands)` in `src/main/command/router.ts` is a pure function returning one route:

| Route | Matches | Example |
|---|---|---|
| `open` | starts with "open", "launch", "start", "go to" | "open spotify", "go to github.com" |
| `search` | starts with "search for", "search", "look up", "google" | "look up electron release notes" |
| `saved` | starts with a saved command's name | "spanish", "bulletize this" |
| `write` | anything else | current behaviour plus screen context |

Matching ignores case, leading fillers ("um, open…") and trailing punctuation from speech recognition. A trigger word only counts as the first word of the command followed by a target, so "open-minded people…" and "search engines are…" stay writing commands.

## Open and search

"Open X" resolves in order:
1. The Sites list in Settings ("gmail" → `mail.google.com`), exact match ignoring case.
2. Installed apps from the helper's `listApps`, which reads `shell:AppsFolder` (Win32 and Store apps). Results are cached and refreshed every few minutes. Matching is fuzzy, so "VS Code" finds "Visual Studio Code".
3. Text that looks like a domain opens as `https://…`.
4. Otherwise, a web search for X, with a pill notice saying no app was found.

Search uses a configurable URL template: Google by default, with DuckDuckGo and Bing presets or a custom template.

URLs open through `shell.openExternal`, restricted to `http` and `https`. Apps launch through the helper's `launchApp` by app ID only. A transcript never becomes a command line. Actions show a short pill confirmation and are recorded in History with a new `action` status.

## Saved commands

- Migration 2 adds a `commands` table (id, name unique ignoring case, prompt, created_at, uses).
- A Commands page in the hub, modelled on Snippets, ships with editable examples: Spanish, Bulletize, Shorten.
- Words spoken after the name are appended to the saved instruction. The command then runs as a writing command on the selection, or on screen text when nothing is selected.
- Names that clash with trigger words or with another saved command are rejected with a reason.

## Screen context

- The helper's `getWindowText(maxChars)` walks the focused window's UI Automation tree. It collects document, edit and text content, and skips password fields, offscreen elements and duplicates. Gloop Voice asks for 16,000 characters (the helper allows up to 20,000), keeping the text nearest the focus, and has a 1.5 s budget. On timeout or failure the command runs without context.
- When nothing is selected, the writing prompt gets a `<screen_text>` reference block. The model is told to produce what was asked for, not to restate the source.
- Screen text goes only to the local model. With a remote provider it is left out, and the pill says so once.
- Screen text is never logged. Only its length and timing are.
- The local model runs with an 8,192-token context. Screen text gets about 5,000 estimated tokens of it (16,000 characters of Latin text is about 4,800), which leaves room for the prompt and the output.

## Errors

| Situation | Behaviour |
|---|---|
| App launch fails | Notice; History status `failed` |
| Browser open fails | Notice; URL copied to the clipboard |
| Window text read fails or times out | Runs without context |
| No language model | Actions and search still work; writing commands show the existing notice |
| Saved command name clash | Rejected in the UI with the reason |

## Testing

1. Unit tests (vitest): router cases including lookalikes, open-target resolution order, domain detection, search URL encoding, prompt builders with and without screen text and with a remote provider, migration 2 and saved-command CRUD, and controller flows for every route and error path using a fake helper.
2. Model evals (`npm run test:prompts`) against the installed local model: reply, summarize and saved commands on fixture screen text, checked for output shape.
3. Helper smoke test: `listApps` returns real apps with IDs, `getWindowText` reads a known Gloop Voice window within budget, and `launchApp` opens and then closes Notepad.
4. End-to-end self-test (`GLOOP_VOICE_SELFTEST`) with recorded clips for open, search, go to, a saved command and summarize. It asserts real effects (process launched, exact URL requested, text inserted into Gloop Voice's own box) and saves screenshots. Paste steps keep the `requireForeground` guard.
5. A packaged build installed over the current copy, the self-test re-run on the installed app, and a manual checklist for physical key presses.

## Changes during implementation

- No bare "search X" or "start X" triggers: both start too many ordinary sentences. Search is "search for", "look up" or "google"; open is "open", "open up", "launch", "go to" or "pull up".
- Lookalike rules: an open target has at most 6 words and no clause words (a comma, a long "and", "then", "write", "make", "about"). Pronoun and filler targets ("open it", "open this up", "look up that") stay writing commands.
- "Go to" and "pull up" are everyday writing phrases too. When what follows matches no site, app or domain ("go to the next paragraph"), the command runs as a writing instruction instead of a web search. "Open X" with no match still searches.
- Spoken "dot" and "slash" are joined, so "github dot com slash murmur" opens `https://github.com/murmur`.
- Domain detection needs a top-level domain from an allowlist, so file names like "next.js" or "notes.py" are not sites.
- App matching was tuned on a probe of 210 real installed apps: whole-word matches beat prefix matches; documentation, help, installer and uninstaller entries are skipped unless asked for by name; "cmd" and "to do" are aliases for Command Prompt and Microsoft To Do.
- Site names are keyed the same way as the resolver matches them, so a saved name always matches what is spoken.
- Screen text is read only when a model can use it and nothing is selected, not on every command.
- The screen budget is counted in estimated tokens (about 5,000) rather than characters, and with the built-in model a selection over about 3,000 tokens is refused with a notice. Remote models keep a 12,000-character limit.
- Prompt tags and forged labels ("The user's instruction:") in screen text and selections are neutralised before the prompt is built and restored in the output.
- The end-to-end self-test runs only in a dev build and refuses to start without `GLOOP_VOICE_USER_DATA`.
- Known limit: Gemma 3 4B still obeys a short command at the end of the screen text. The eval keeps it as an expected failure; the impact is wrong typed text, not an action.
