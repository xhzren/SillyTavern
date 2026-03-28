# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SillyTavern is an LLM Frontend for Power Users — a web-based chat interface that connects to various LLM backends (OpenAI, Claude, Gemini, Ollama, Kobold, etc.). It provides character chat, group chats, world info/lorebooks, prompt templates, and a plugin/extension system.

## Commands

```bash
# Start the server (default port 8089)
npm start

# Start with Node debugger
npm run debug

# Start with --global flag (cross-user data)
npm run start:global

# Disable CSRF protection (dev only)
npm run start:no-csrf

# Lint
npm run lint
npm run lint:fix

# Plugin management
npm run plugins:install
npm run plugins:update
```

**Tests** are in the `tests/` directory which has its own package.json:
```bash
cd tests && npm test              # Run all tests
cd tests && npm run test:unit    # Unit tests only
cd tests && npm run test:e2e     # Playwright e2e tests only
```

## Architecture

### Backend (`src/`)

- **`server.js`** — Entry point; parses CLI args and imports `server-main.js`
- **`server-main.js`** — Express app setup, middleware chain, route registration
- **`src/endpoints/`** — API route handlers organized by domain:
  - `characters.js`, `chats.js`, `groups.js` — Core entity CRUD
  - `openai.js`, `anthropic.js`, `novelai.js`, etc. — LLM backend integrations
  - `backends/` — Generic adapter patterns (`chat-completions.js`, `text-completions.js`, `kobold.js`)
  - `extensions.js`, `settings.js`, `worldinfo.js`, `vectors.js` — Feature endpoints
- **`src/plugin-loader.js`** — Server-side plugin system (loaded at startup)
- **`src/users.js`** — User auth, sessions, data storage management
- **`src/vectors/`** — Embedding/vector store integrations (multiple backends)

### Frontend (`public/`)

- **`public/index.html`** — Main SPA entry
- **`public/script.js`** — Main frontend bundle (compiled via webpack)
- **`public/scripts/extensions/`** — Frontend extensions (user-installed)
  - `third-party/` — Bundled third-party extensions
  - `tts/`, `voice/` — Built-in extension subdirectories

### Configuration

- **`config.yaml`** — Runtime configuration (port, SSL, CORS, rate limiting, feature flags)
- **`data/`** — User data directory (overridable via CLI `--data-root` or config `dataRoot`)
- **`default/`** — Scaffold/default content (character cards, backgrounds, presets)

### Key Patterns

- **ES Modules**: All source code uses `"type": "module"` (`.js` files are ESM)
- **Node.js >= 18** required
- **CSRF protection** enabled by default; `--disableCsrf` flag available for local dev
- **Extensions** (frontend) vs **Plugins** (server-side) are separate systems
- **Settings** are stored per-user in the data directory

## Contribution Guidelines

- PRs target `staging` branch (not `release`)
- Soft limit of ~200 lines per PR
- Run `npm run lint` before committing and fix errors
- Use existing naming conventions and code style
