# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository contains scripts for the **Scripting** iOS app (by Thom Fang). Scripts are self-contained mini-apps that run within the Scripting app environment. The main script is "Reader" - a web content reader that uses configurable rules to extract and display content from websites.

## Environment Requirements

- Node.js 24+
- pnpm 10+
- [Scripting](https://apps.apple.com/app/id1528069225) iOS/Mac App

## Development Commands

```bash
pnpm serve          # Start scripting-cli dev server (with Bonjour)
pnpm watch          # Watch files and sync to iCloud for Scripting app
pnpm type-check     # TypeScript type checking
pnpm lint           # Run ESLint with auto-fix
pnpm lint:check     # Run ESLint without fixing
pnpm format         # Format code with Prettier
pnpm code-quality   # Run lint + format + type-check
```

## Framework: Scripting

The `scripting` module is a React-like framework with custom JSX. Key differences from React:

- **JSX Factory**: Uses `createElement` and `Fragment` (configured in tsconfig.json), not React's
- **Imports**: Import hooks and components from `'scripting'`, not `'react'`
- **Components**: SwiftUI-inspired (VStack, HStack, Form, NavigationStack, NavigationLink, etc.)
- **Storage**: Use `Keychain` for key-value storage, `FileManager` for file operations
- **Dialogs**: Use `Dialog.alert()` and `Dialog.confirm()` for user prompts
- **Navigation**: Use `Navigation.present()` to launch screens

## Architecture

### Script Structure
Each script is a folder in `scripts/` containing:
- `script.json` - Manifest with name, version, icon, localization
- `index.tsx` - Entry point that calls `Navigation.present()`

### Reader Script (`scripts/Reader/`)
```
screens/          # UI screens (HomeScreen, ChapterListScreen, SearchScreen, etc.)
services/         # Business logic
  ├── ruleEngine.ts       # Executes rules using WebViewController
  ├── ruleParser.ts       # Rule expression parsing
  ├── ruleStorage.ts      # Persists rules to FileManager
  ├── bookshelfStorage.ts # Bookshelf/favorites persistence
  ├── webAnalyzer.ts      # CSS/XPath selector parsing in WebView
  └── logger.ts           # Logging service for debugging
components/       # Reusable UI components
types.ts          # TypeScript type definitions (Rule, SearchItem, ChapterItem, etc.)
docs/             # Documentation (rule-spec.md, development.md)
```

## Critical Technical Details

### WebViewController JavaScript Evaluation
When using `controller.evaluateJavaScript()`, you **must use top-level `return`** statements. IIFE patterns don't work:

```javascript
// ✅ CORRECT - top-level return
const script = `
  var result = document.querySelector('h1').textContent;
  return JSON.stringify({ data: result });
`

// ❌ WRONG - IIFE return doesn't work
const script = `
  (function() {
    return JSON.stringify({ data: 'test' });
  })()
`
```

### Rule Syntax
Rules support multiple selector types with prefixes:
- `@css:` or no prefix - CSS selectors (default)
- `@xpath:` or `//` prefix - XPath expressions
- `@js:` - JavaScript expressions
- `@json:` or `$.` prefix - JSONPath

Attribute extraction: `selector@attr` (e.g., `a@href`, `img@src`, `div@text`)

### Type Definitions
The `dts/scripting.d.ts` file contains all framework type definitions. Global types like `WebViewController`, `FileManager`, `Keychain`, and `Dialog` are available without imports.

### Debugging
Use the logger service for debugging:
```typescript
import { logger } from './services/logger'

logger.info('信息日志')
logger.debug('调试日志')
logger.error('错误日志', error)
```
