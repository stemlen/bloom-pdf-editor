# Contributing to Bloom PDF Editor

First off — **thank you** for considering contributing to Bloom! Every contribution matters, whether it's fixing a typo, improving documentation, reporting a bug, or building a new export plugin.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Code Style & Conventions](#code-style--conventions)
- [Writing an Export Plugin](#writing-an-export-plugin)
- [Testing](#testing)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)
- [License](#license)

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold this code. Please report unacceptable behavior to the maintainers.

---

## How Can I Contribute?

### 🐛 Fix a Bug
Check the [Issues](https://github.com/stemlen/bloom-pdf-editor/issues) tab for bugs labeled `good first issue` or `help wanted`.

### 📝 Improve Documentation
Documentation improvements are always welcome — from fixing typos to adding new engine explanations in `docs/ENGINE.md`.

### 🔌 Build an Export Plugin
The export system uses a plugin SDK. See [Writing an Export Plugin](#writing-an-export-plugin) below.

### 🧪 Add Tests
Both client and server engines use Vitest. More test coverage is always appreciated.

### ✨ Propose a Feature
Open an issue with the `feature request` label to discuss your idea before starting work.

---

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/bloom-pdf-editor.git
   cd bloom-pdf-editor
   ```
3. **Create a branch** for your work:
   ```bash
   git checkout -b feat/your-feature-name
   ```

---

## Development Setup

### Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9

### Install & Run

```bash
# Install all dependencies
npm install
# postinstall runs `npm --prefix server ci` for engine deps

# Start the development server
npm run dev
```

This builds the server engine and starts Next.js. Open [http://localhost:3000](http://localhost:3000).

### Available Scripts

| Command | What It Does |
|---------|-------------|
| `npm run dev` | Build server engine + start Next.js dev server |
| `npm run build` | Production build (server + Next.js) |
| `npm test` | Run client engine tests (Vitest) |
| `npm run test:watch` | Run client tests in watch mode |
| `npm run server:dev` | Start standalone server on :8787 |
| `npm run server:test` | Run server engine tests |
| `npm run server:build` | Build server engine to `server/dist/` |
| `npm run lint` | Run ESLint |

---

## Project Structure

```
bloom-pdf-editor/
├── src/engine/       # Client-side PDF engine (pure TypeScript)
├── server/src/       # Server document intelligence engine
│   └── engines/      # Parser → Layout → IDM → ... → Export
├── docs/             # Documentation
└── ...
```

See [docs/ENGINE.md](docs/ENGINE.md) for a deep dive into every engine module.

### Key Architectural Rules

1. **Never convert PDF → format directly.** All conversions go through the full pipeline (Parse → Layout → IDM → Semantic → ... → UDM → Export).
2. **Exporters depend only on UDM.** They never import from the parser, layout, or any intermediate engine.
3. **Parser produces `RawDocument` only.** No paragraph, table, or reading-order logic in the parser.
4. **All engines are interface-driven.** Every engine implements an interface from `server/src/engines/common/interfaces.ts`, making them testable and swappable.

---

## Code Style & Conventions

### TypeScript

- **Strict mode** — All code is compiled with strict TypeScript settings
- **Explicit types** — Export interfaces and types for all public APIs
- **Immutable data** — Prefer `readonly` properties and avoid mutation where possible
- **No `any`** — Avoid `any` types; use `unknown` with type narrowing when needed

### Naming

- **Files** — `kebab-case.ts` (e.g., `parser-engine.ts`, `export-manager.ts`)
- **Classes** — `PascalCase` (e.g., `ParserEngine`, `ExportManager`)
- **Interfaces** — Prefixed with `I` for engine interfaces (e.g., `IParserEngine`, `IExportPlugin`)
- **Types** — `PascalCase` (e.g., `ContentBlock`, `LayoutRegion`)
- **Functions** — `camelCase` (e.g., `extractContentBlocks`, `assembleUnifiedDocument`)
- **Constants** — `UPPER_SNAKE_CASE` (e.g., `IDM_VERSION`, `IDENTITY_MATRIX`)

### Imports

- Use relative imports within the same package
- Server engine uses `.js` extensions in imports (for ESM compatibility)
- Client engine uses `@/engine/` path alias

### Comments

- Add JSDoc comments for all exported functions and classes
- Explain **why**, not **what** — the code should be self-explanatory for the "what"
- Preserve existing comments when modifying code

---

## Writing an Export Plugin

The export system uses a plugin SDK defined in `server/src/engines/exporter/plugin.ts`:

```typescript
interface IExportPlugin {
  readonly target: ConvertTarget;  // e.g., 'docx', 'html', 'csv'
  readonly name: string;           // e.g., 'CsvExporter'

  // Optional: called before export for setup
  initialize?(udm: UnifiedDocumentModel): void | Promise<void>;

  // Required: performs the export
  export(udm: UnifiedDocumentModel): Promise<ExportResult>;

  // Optional: validates the output bytes
  validate?(bytes: Uint8Array): boolean;

  // Optional: packages multiple parts (e.g., ZIP)
  package?(parts: Record<string, string | Uint8Array>): Uint8Array;

  // Optional: cleanup after export
  cleanup?(): void;
}
```

### Step-by-Step

1. **Create a directory** under `server/src/engines/exporter/<format>/`

2. **Create your exporter class:**
   ```typescript
   // server/src/engines/exporter/csv/csv-exporter.ts
   import type { ExportResult } from '../../common/interfaces.js';
   import type { UnifiedDocumentModel } from '../../udm/types.js';
   import { extractContentBlocks, tableToRows } from '../content.js';

   export class CsvExporter {
     readonly name = 'CsvExporter' as const;

     async export(udm: UnifiedDocumentModel): Promise<ExportResult> {
       const blocks = extractContentBlocks(udm);
       // Use blocks to generate CSV content
       // ...
       return {
         bytes: new TextEncoder().encode(csvString),
         mimeType: 'text/csv; charset=utf-8',
         filename: 'document.csv',
       };
     }
   }
   ```

3. **Register in ExportManager** (`server/src/engines/exporter/export-manager.ts`):
   ```typescript
   import { CsvExporter } from './csv/csv-exporter.js';
   // ...
   const csv = new CsvExporter();
   this.registerPlugin(asPlugin('csv', csv.name, (u) => csv.export(u)));
   ```

4. **Add your format** to the `ConvertTarget` type in `server/src/jobs/types.ts`

5. **Write tests** in `server/src/tests/`

6. **Use shared content helpers** from `server/src/engines/exporter/content.ts`:
   - `extractContentBlocks(udm)` — Format-agnostic reading-order content blocks
   - `tableToRows(table)` — Convert `LogicalTable` to 2D string array
   - `escHtml(s)` / `escXml(s)` — HTML/XML escaping
   - `sanitizeFilename(name, fallback)` — Safe filename generation

---

## Testing

### Client Engine Tests

```bash
npm test                # Run once
npm run test:watch      # Watch mode
```

Tests use **Vitest** with **happy-dom** for DOM simulation.

### Server Engine Tests

```bash
npm run server:test
```

Server tests also use Vitest and test engines in isolation via their interfaces.

### Writing Tests

- Place test files next to the code they test (e.g., `src/engine/__tests__/`) or in `server/src/tests/`
- Use descriptive test names: `'ParserEngine should extract characters from content stream'`
- Test edge cases: empty documents, single-page, multi-page, rotated pages, encrypted PDFs
- Use the in-memory storage for server tests: `createContainer({ memoryStorage: true })`

---

## Submitting a Pull Request

1. **Ensure your code builds:**
   ```bash
   npm run build
   ```

2. **Run all tests:**
   ```bash
   npm test
   npm run server:test
   ```

3. **Run the linter:**
   ```bash
   npm run lint
   ```

4. **Commit with a clear message:**
   ```
   feat(exporter): add CSV export plugin

   - Implements IExportPlugin for CSV format
   - Extracts table data from UDM content blocks
   - Adds tests for single and multi-table documents
   ```

   Follow [Conventional Commits](https://www.conventionalcommits.org/) format:
   - `feat:` — New feature
   - `fix:` — Bug fix
   - `docs:` — Documentation only
   - `test:` — Adding or updating tests
   - `refactor:` — Code change that neither fixes a bug nor adds a feature
   - `chore:` — Build process, dependencies, tooling

5. **Push and open a PR** against the `main` branch

6. **Fill in the PR template** with:
   - What changed and why
   - How to test
   - Screenshots (for UI changes)

---

## Reporting Bugs

Open an issue with the `bug` label and include:

1. **Environment** — OS, Node.js version, browser
2. **Steps to reproduce** — Minimal steps to trigger the bug
3. **Expected behavior** — What you expected to happen
4. **Actual behavior** — What actually happened
5. **PDF sample** — If the bug relates to a specific PDF, attach it (redact sensitive content)

---

## Suggesting Features

Open an issue with the `feature request` label and include:

1. **Problem** — What problem does this feature solve?
2. **Proposed solution** — How would you like it to work?
3. **Alternatives** — Any alternative solutions you've considered?
4. **Context** — Any additional context, screenshots, or examples?

---

## License

By contributing to Bloom PDF Editor, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
