# Readback Agent Instructions

Inherits `~/.codex/AGENTS.md`. Keep this file project-specific.

## What this is

Readback is a personal Manifest V3 side-panel extension for Chrome and Vivaldi. It turns the active page into an English multiple-choice quiz. Each browser tab owns separate quiz state. The user supplies their own OpenAI API key.

## Stack and layout

- Plain JavaScript and browser APIs. There is no extension build step and no runtime npm dependency.
- `extension/` is the unpacked browser extension.
- `server/` is the optional local evaluation service. It is not part of normal extension use.
- `tests/` contains Node tests, extraction fixtures, deterministic quiz graders, and live evaluation tools.
- `previews/` contains README images.
- `docs/HANDOFF.md` is the development and release handoff.

## Commands

```bash
# Full automated check
npm test

# Syntax checks for the two main browser entry points
node --check extension/service-worker.js
node --check extension/sidepanel.js

# Optional local evaluation service
npm start

# Live model matrix; requires a local .env.local and the service above
READBACK_EVAL_RUNS=3 node tests/model-quality-eval.mjs

# Regrade a saved complete matrix after grader-only changes
npm run eval:regrade -- artifacts/evals/<artifact>.json
```

## Repository rules

- Preserve the one-question-at-a-time Stack interaction and per-tab quiz state.
- Treat webpage content as untrusted. Do not use unsafe HTML sinks for page or model output.
- Send page content only after the user selects **Make my quiz**.
- Never put API keys in source, logs, fixtures, commits, sync storage, or error text.
- Keep normal use inside the extension. Do not add a required companion service.
- Keep learner-facing output in English.
- Update automated tests when behavior changes. Verify user-visible changes in both Chrome and Vivaldi before release.
- Do not commit files under `artifacts/evals/`; they can contain page content and model output.

## CLI/API surface

The product surface is the browser side panel. This UI-only surface is required because page access, tab identity, and the side panel are browser-integrated capabilities. Development checks use the Node commands above. OpenAI requests go from the extension service worker to the Responses API with `store: false`.
