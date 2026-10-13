# Murmur

Local voice dictation for Windows (Electron + C# helper). See `README.md` for layout and commands.

## Technical traps

- **Do not load an LLM library inside Electron.** `node-llama-cpp` crashes Electron 44 on model load in the main process, a utility process, and under `ELECTRON_RUN_AS_NODE`; it only works under plain Node. The local model runs as a separate `llama-server.exe` child process (`src/main/llm/service.ts`).
- **llama.cpp's Vulkan build crashes on this machine's NVIDIA driver** (stack overflow in `nvoglv64.dll` at model load; larger stack and disabling overlay layers do not help). The service tries CUDA pack, then bundled Vulkan, then CPU, and moves on when a backend exits during load. Keep that fallback chain.
- `LLAMA_TAG` in `src/main/models.ts` and `TAG` in `scripts/fetch-llama.cjs` must name the same llama.cpp release.
- The key hook ignores injected input by design. `npm run test:hook` sets `MURMUR_HELPER_TEST=1` to lift that, and presses modifier keys only. Never inject Esc, Space or letters in tests: they reach whatever window the user has focused.
- The end-to-end self-test pastes into the foreground window. It sets `controller.requireForeground` so the helper refuses unless Murmur is in front; keep that guard on any test that pastes.
- `sherpa-onnx-node` decoding is a blocking native call; it lives in a utility process (`src/main/asr/worker.ts`) and must stay in `asarUnpack`.
- Dictated text must not be written to the log. Log lengths and timings.
- PowerShell 5.1 `Set-Content -Encoding utf8` adds a BOM. Edit source files with the editor tools.
