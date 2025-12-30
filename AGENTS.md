# Repository Guidelines

This repo hosts scripts for the **Scripting** iOS/macOS app. The primary script is **Reader**, a rule-driven web content reader (novel/manga/RSS, etc.).

## Project Structure & Module Organization

- `scripts/` — all Scripting app scripts (each script in its own folder).
  - `scripts/Reader/` — Reader entry (`index.tsx`), UI (`screens/`, `components/`), core logic (`services/`), utilities (`utils/`), and docs (`docs/`).
  - `scripts/Reader/script.json` — script metadata consumed by Scripting.
- `dts/` — TypeScript declaration files for the Scripting runtime.
- Root tooling/config: `tsconfig.json`, `eslint.config.mts`, `prettier.config.mts`, `watch.ts`.

## Build, Test, and Development Commands

- `pnpm install` — install dependencies.
- `pnpm serve` — start the `scripting-cli` dev server (connect from the Scripting app).
- `pnpm watch` — sync `scripts/` into Scripting’s iCloud scripts folder (see `watch.ts`).
- `pnpm type-check` — TypeScript type-check (`tsc --noEmit`).
- `pnpm lint` / `pnpm lint:check` — ESLint with/without auto-fix.
- `pnpm format` / `pnpm format:check` — Prettier write/check.
- `pnpm code-quality` — runs lint + format + type-check.

## Coding Style & Naming Conventions

- Indentation: 2 spaces; keep lines ≤160 chars.
- Formatting: Prettier (no semicolons, single quotes).
- Linting: ESLint + TypeScript ESLint; prefer type-only imports and keep imports sorted.
- Naming: React components in `PascalCase.tsx`; services/utils in `camelCase.ts`.

## Testing Guidelines

There is no dedicated unit test runner configured yet. Validate changes via:

- `pnpm type-check`, `pnpm lint:check`, `pnpm format:check`
- Manual verification inside the Scripting app (focus on Reader flows you touched).

If you add tests later, follow common globs such as `*.test.*`, `*.spec.*`, or `tests/`.

## Commit & Pull Request Guidelines

- Prefer Conventional Commits (common in history): `feat(Reader): ...`, `fix(Reader): ...`, `docs(README): ...`, `refactor(Reader): ...`, `chore: ...`.
- PRs should include: what changed, why, how you verified (commands + in-app steps). For UI changes, add screenshots/screen recordings when feasible.

## Security & Configuration Tips

- Never commit secrets (tokens, cookies, private URLs) or personal data.
- Avoid hard-coding device-specific paths outside `watch.ts`.
- Keep local-only artifacts out of git (e.g., logs, temporary files).
