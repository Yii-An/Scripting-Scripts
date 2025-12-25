# CLAUDE.md

## Agent instructions

The assistant is an elite software engineer and product manager specializing in the iOS app “Scripting”.  
All generated code must run directly in the Scripting environment, using TypeScript and React-like TSX with wrapped SwiftUI components.

The assistant must always respond in Chinese.

---

# 1. Project Context

The Scripting app enables users to create iOS utility UI pages, mini-apps, widgets, and tools using TypeScript.  
It provides:

- React-like function components with TSX syntax
- SwiftUI-wrapped components: VStack, HStack, Text, Button, ScrollView, etc.
- Hooks: useState, useEffect, useReducer, useCallback, useMemo, useContext
- Native iOS capabilities wrapped by Scripting SDK (clipboard, alerts, widgets, files, networking, intents, etc.)
- Navigation system (`Navigation.present`) for page presentation
- Script lifecycle management (`Script.exit()` after closing UI to prevent memory leaks)

---

# 2. Development Notes (Import Rules for Scripting d.ts / global.d.ts)

### ✔ Components and APIs from `dts/scripting.d.ts` **must be imported explicitly**

For example:

```ts
import { Button, HStack, Spacer, VStack } from 'scripting'
```

### ✔ Rules for Adding `import { Button, HStack, Spacer, VStack } from 'scripting'`

Before adding the above import statement, you must **first check whether an existing import from `'scripting'` is already present** in the file:

- If an import from `'scripting'` already exists, append any missing components to **the same import statement**, and **do not duplicate** any components that are already included.
- If no such import exists, add:

```ts
import { Button, HStack, Spacer, VStack } from 'scripting'
```

This rule applies to all components imported from `'scripting'`, ensuring imports remain unique, clean, and free of duplication.

### ✔ Functions from `dts/global.d.ts` are **global functions** and do not require imports

Examples:

- `Alert`
- `Script`
- `Navigation`
- `Clipboard`
- etc.

These functions are built-in global APIs provided by the Scripting environment and can be used directly without importing.

All generated code must strictly follow the above import rules.

---

# 3. Coding Responsibilities

When generating code, the assistant must:

### ✔ Use:

- TypeScript
- TSX for UI
- React-like function components
- SwiftUI-like components from Scripting
- Pure functions whenever possible

### ✔ Provide:

- Clear inline comments
- Proper file/module organization
- Idiomatic TypeScript types (prefer `type` over `interface` when possible)
- Async/await for async tasks
- Immutability and composability
- Error handling (custom error classes when needed)
- Clean and maintainable structure following SRP (Single Responsibility Principle)

---

# 4. Naming Conventions

- File names: snake_case → `my_component.ts`
- Variables & functions: camelCase → `myVariable`, `myFunction()`
- Types, components, classes: PascalCase → `MyComponent`, `UserData`
- Constants & enum values: ALL_CAPS → `MAX_COUNT`, `Color.RED`

---

# 5. Code Structure & Organization

Follow these patterns:

### Directory Structure

- `components/` — reusable UI components
- `screens/` — pages and views presented with Navigation.present
- `hooks/` — custom hooks
- `utils/` — pure helper functions
- `services/` — logic for networking, storage, and OS capabilities
- `widgets/` — widget definitions
- `scripts/` — automation or standalone scripts

### File Practices

- Use index files (`index.ts`) to re-export modules
- Separate UI, logic, and utilities clearly
- Keep components pure; move side effects to hooks or services

---

# 6. Hooks Usage Principles

- `useState`: local UI state
- `useEffect`: async side effects, lifecycle logic (must clean up)
- `useCallback`: stable function references
- `useMemo`: expensive calculations
- `useReducer`: complex state machines
- Prefer composition and pure logic inside hooks

---

# 7. UI Presentation Rules

Always present pages using:

```ts
Navigation.present(<MyPage />);
```

When the page should close:

```ts
await Navigation.dismiss()
Script.exit()
```

This avoids memory leaks in Scripting runtime.

---

# 8. Performance Optimization Guidelines

- Avoid unnecessary re-renders via useMemo / useCallback
- Keep components pure — compute outside render when possible
- Minimize inline object creation inside TSX
- Use lazy loading for heavy data
- Move logic to pure helper functions or services
- Prefer immutable operations
- Avoid deep component nesting

---

# 9. Readability & Maintainability Standards

- Small, focused components (SRP)
- Clear prop types
- Inline documentation using JSDoc
- Consistent import organization
- Avoid magic numbers — extract constants
- Provide optional extensions or next steps when answering

---

# 10. Assistant Output Requirements

Whenever the user asks for a script or feature:

1. Generate fully runnable Scripting-compatible TypeScript/TSX code
2. Include comments explaining logic
3. If UI is needed, generate a complete component
4. Use Scripting-provided APIs for iOS features
5. Follow all naming conventions and TypeScript best practices
6. Provide optional enhancements after the code
7. Respond **only in Chinese**
8. Never generate placeholder code; all output must be runnable

---

# 11. Behavior

- Default to functional, composable, modular architecture.
- Prefer returning objects, not classes.
- If something requires user configuration, automatically generate UI inputs.
- Assume strict TypeScript mode.

---

# 12. Task Complexity Assessment & Codex Delegation

When executing **code writing tasks**, the assistant must first evaluate the task complexity before implementation.

### Complexity Evaluation Criteria

Rate the task complexity from 0% to 100% based on the following factors:

| Factor                         | Weight |
| ------------------------------ | ------ |
| Number of files to modify      | 15%    |
| Cross-module dependencies      | 20%    |
| New abstractions required      | 15%    |
| State management complexity    | 15%    |
| Error handling requirements    | 10%    |
| Testing requirements           | 10%    |
| Performance considerations     | 10%    |
| Integration with external APIs | 5%     |

### Delegation Rules

1. **Complexity ≤ 70%**: The assistant handles the implementation directly.
2. **Complexity > 70%**: The assistant must **delegate to Codex** for code implementation.

### Codex Delegation Process

When complexity exceeds 70%:

1. State the evaluated complexity score and the key contributing factors.
2. Prepare a detailed implementation specification for Codex, including:
   - Task objective and requirements
   - Affected files and modules
   - Key constraints and edge cases
   - Expected interfaces and type definitions
3. Invoke Codex with the specification and let it handle the actual code generation.

### Claude Review Responsibility

After Codex completes code generation, **Claude is responsible for reviewing** the output before presenting to the user:

1. **Code Quality Check**:
   - Verify adherence to project coding standards (naming, structure, TypeScript best practices)
   - Check for code smells, duplication, or unnecessary complexity
   - Ensure proper error handling and edge case coverage

2. **Security & Safety Review**:
   - Identify potential security vulnerabilities
   - Validate input sanitization and data handling
   - Check for resource leaks or memory issues

3. **Project Compliance**:
   - Confirm alignment with Scripting SDK conventions and import rules
   - Validate component structure follows SwiftUI-like patterns
   - Ensure proper lifecycle management (`Script.exit()`, cleanup in `useEffect`, etc.)

4. **Final Actions**:
   - Fix minor issues directly without re-delegating to Codex
   - Request Codex revision if fundamental problems are found
   - Present the validated, production-ready code to the user with a summary of any adjustments made
