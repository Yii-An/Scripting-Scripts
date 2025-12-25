# Repository Guidelines

This repository hosts scripts for the **Scripting** iOS/macOS app. The primary script is **Reader**, a rule-driven web content reader (novel/manga, etc.).

## Project Structure

- `scripts/` — Scripting app scripts (each script lives in its own folder).
  - `scripts/Reader/` — Reader script entry (`index.tsx`), UI (`screens/`), shared UI (`components/`), core logic (`services/`), and docs (`docs/`).
  - `scripts/Reader/script.json` — Script metadata/config consumed by Scripting.
- `dts/` — TypeScript declaration files for the Scripting runtime.
- Root tooling: `eslint.config.mts`, `prettier.config.mts`, `tsconfig.json`, `watch.ts`.

## Build, Test, and Development Commands

- `pnpm install` — Install dependencies.
- `pnpm serve` — Start `scripting-cli` dev server (connect from the Scripting app).
- `pnpm watch` — Sync `scripts/` into Scripting’s iCloud scripts folder (see `watch.ts`).
- `pnpm type-check` — TypeScript type checking (`tsc --noEmit`).
- `pnpm lint` / `pnpm lint:check` — ESLint with/without auto-fix.
- `pnpm format` / `pnpm format:check` — Prettier write/check.
- `pnpm code-quality` — Runs lint + format + type-check.

## Coding Style & Naming Conventions

- Indentation: 2 spaces (see `.editorconfig`); max line length 160.
- Formatting: Prettier (`prettier.config.mts`), no semicolons, single quotes.
- Linting: ESLint + TypeScript ESLint (`eslint.config.mts`). Prefer type imports and keep imports sorted.
- Files/folders: React-style components in `PascalCase.tsx`; utilities/services in `camelCase.ts`.

## Testing Guidelines

There is no dedicated unit test runner configured in `package.json` currently. Validate changes via `pnpm type-check`, `pnpm lint`, and manual runs inside the Scripting app. If you add tests later, follow the existing ESLint test globs (`*.test.*`, `*.spec.*`, or `tests/`).

## Commit & Pull Request Guidelines

- Prefer Conventional Commits: `feat: ...`, `fix(Reader): ...`, `docs(README): ...`, `refactor(Reader): ...`, `chore: ...`.
- PRs should include: what changed, why, manual verification steps (device + flow), and any breaking behavior. For UI changes, include screenshots/screen recordings when feasible.

## Security & Configuration Tips

Do not commit secrets (tokens, cookies, private URLs). Keep local-only files out of git (e.g., `node_modules/`, logs) and avoid hard-coding device-specific paths outside `watch.ts`.
