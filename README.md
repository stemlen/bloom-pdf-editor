<div align="center">

# 🌸 Bloom PDF Editor

### A Pure-Engine, Open-Source PDF Editor & Document Intelligence Platform

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**Edit PDFs in the browser. Convert to 12+ formats. Zero external dependencies for the core engine.**

[Quick Start](#-quick-start) · [Architecture](#-architecture) · [Engine Deep Dive](docs/ENGINE.md) · [Contributing](CONTRIBUTING.md)

---

</div>

## ✨ What is Bloom?

Bloom is a **full-featured PDF editor** built with Next.js and React, powered by a **custom-written, dependency-free TypeScript PDF engine**. Unlike other PDF tools that wrap native C/C++ libraries or call external APIs, Bloom parses, renders, edits, and serializes PDFs using **pure TypeScript** — from the binary lexer all the way to the Canvas renderer.

The project has two major subsystems:

| Subsystem | Location | Purpose |
|-----------|----------|---------|
| **Client Engine** | `src/engine/` | PDF parsing, rendering, editing, signatures, security, forms, OCR layout, and more — runs in the browser |
| **Server Engine** | `server/src/engines/` | Document intelligence pipeline — structure-preserving conversion to DOCX, XLSX, PPTX, HTML, Markdown, EPUB, and 6 more formats |

> **🚧 Export Engine Status:** The server-side export/conversion pipeline is **currently in progress**. The full pipeline (Parse → Layout → IDM → Semantic → Tables → Graphics → Structure → UDM → Export) is architecturally complete, and all 12 exporter plugins are wired up. Active work continues on improving conversion fidelity and edge-case handling.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (Client)                         │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐│
│  │  React UI    │  │  Zustand     │  │   Client PDF Engine    ││
│  │  (Radix +   │──│  Store       │──│   (src/engine/)        ││
│  │   Fabric.js) │  │              │  │                        ││
│  └──────────────┘  └──────────────┘  │  Parser → Renderer    ││
│                                       │  Editor → Writer      ││
│                                       │  Signatures → Security││
│                                       │  Forms → Flow → Bloom ││
│                                       └────────────────────────┘│
│                            │                                    │
│                     /api/bloom/*                                │
│                    (Route Handlers)                              │
├─────────────────────────────────────────────────────────────────┤
│                     Server (In-Process)                          │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Bloom Document Intelligence Engine             ││
│  │                                                             ││
│  │  Parse → OCR → Layout → IDM → Typography → Semantic        ││
│  │  → Tables → Graphics → Structure → UDM → Export            ││
│  │                                                             ││
│  │  Priority Queue (high/normal/low) │ Retry + Dead Letter     ││
│  │  Telemetry │ Storage │ Job Manager │ DI Container           ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

The server engine runs **inside the Next.js process** — no separate server, no API key, no second terminal. Optional standalone HTTP mode (`npm run server:dev` on `:8787`) is available for Docker/ops deployments.

---

## 🔧 Built with Pure Engines — No Wrappers

Bloom's core differentiator is that the **entire PDF engine is hand-written in TypeScript**. Here's what that means:

### Client-Side Engine (`src/engine/`)

The client engine handles everything from raw binary parsing to pixel-perfect Canvas rendering:

| Module | What It Does | Key Data Structures |
|--------|-------------|-------------------|
| **Parser** (`parser/`) | Binary lexer tokenizes raw PDF bytes → cross-reference table resolution → object graph construction | `PDFDict`, `PDFArray`, `PDFStream`, `PDFRef`, `XRefTable`, `PDFDocumentData` (all custom classes, no wrappers) |
| **Content Interpreter** (`content/`) | Walks PDF content streams, executing operators (Tj, TJ, cm, re, m, l…) to produce positioned text runs, path items, and images | `TextRun`, `GlyphPosition`, `PathItem`, `GraphicsState`, `Matrix` (6-element affine transform array) |
| **Font System** (`fonts/`) | Parses TrueType/OpenType binary tables, CMap encodings, GSUB ligature substitution, and GPOS pair kerning | `TTFFont`, `FontData`, `CMapData`, `LigatureRule`, `GPOSPairAdjustment` |
| **Renderer** (`render/`) | Full Canvas 2D rendering pipeline — color spaces (DeviceRGB, DeviceCMYK, ICCBased), transparency, soft masks, tiling patterns, shading, clipping paths, Type 3 fonts | `GraphicsStateStack`, `ColorSpace`, `TilingPattern`, `SoftMaskInfo`, `Shading` |
| **Flow Engine** (`flow/`) | Line reconstruction → paragraph detection → Knuth-Plass line breaking → BiDi text reordering → justification → grapheme cluster segmentation | `TextLine`, `Paragraph`, `StyledSegment`, `DocumentFlow`, `ShapedGlyph`, `DetectedTable` |
| **Bloom Model** (`bloom/`) | Word-processor-like document model — ingests parsed PDF pages into editable blocks with runs, layout, and hit-testing | `BloomBlock`, `BloomRun`, `BloomPage`, `BloomDocument`, `BloomCaret` |
| **Editor** (`editor/`) | Text editing, image insertion, object transforms, redaction, highlights, annotations (9 types), links, invisible text layers | `TextEdit`, `Annotation` (union of 10 subtypes), `EditableObject`, `Affine` |
| **Writer** (`writer/`) | Incremental PDF save (append-only updates), full serialization, page operations (insert, delete, reorder, rotate, extract) | `IncrementalUpdateSession`, `RevisionChain`, `OffsetManager` |
| **Signatures** (`signatures/`) | Complete digital signature engine — visual signatures (draw/type/upload), signature fields, DER/CMS parsing, PKCS#12 import, timestamp authority, LTV, DSS, ByteRange finalization | `VisualSignature`, `CMSSignedData`, `CertificateInfo`, `SignatureField`, `SignatureLibrary` |
| **Security** (`security/`) | Full PDF encryption/decryption engine — RC4, AES, password auth, permissions, public-key encryption, metadata stripping, JavaScript scanning, redaction verification, integrity scanning | `EncryptionContext`, `PdfPermissions`, `SecurityPolicy`, `FullSecurityReport` |
| **Forms** (`forms/`) | AcroForm parsing, widget detection, field value setting, appearance stream generation, checkbox/radio/choice support, calculation order | `AcroFormField`, `AcroFormWidget`, `FlattenFieldResult` |
| **Editing Infrastructure** (`editing/`) | QuadTree spatial index, undo/redo transaction stack, scene graph, affine transforms, snap-to-guide alignment | `QuadTree`, `TransactionStack`, `EditorHistory`, `SceneGraph`, `SnapGuide` |
| **Color** (`color/`) | ICC profile parsing, LUT-based color transforms, DeviceCMYK→RGB conversion | `ICCProfile`, `ICCLutInfo`, `Mft2Table` |
| **Watermark** (`watermark/`) | Text/image/pattern watermark creation, detection, and removal | `Watermark`, `DetectedWatermark`, `RemovalResult` |
| **AI** (`ai/`) | Document chunking, semantic search index (TF-IDF), text diff/compare | `DocumentChunk`, `SemanticSearchIndex`, `DocumentCompareResult` |
| **Optimize** (`optimize/`) | Garbage collection of unreferenced objects, stream deduplication, image recompression | `GarbageCollectResult`, `DeduplicateResult`, `ReachabilityResult` |
| **OCR** (`ocr/`) | Page layout analysis — projection profiles, region detection, deskew angle computation | `LayoutRegion`, `PageLayout`, `ProjectionProfile` |
| **Accessibility** (`accessibility/`) | Scaffolded for tagged PDF structure | — |

### Server-Side Engine (`server/src/engines/`)

The conversion pipeline transforms PDF binary data into editable document formats through a **12-stage pipeline**:

```
PDF bytes
  │
  ▼
┌──────────────────┐
│  1. ParserEngine  │  PDF → RawDocument + ObjectGraph + PageSpatialIndex
│                    │  Binary lexer, object resolver, content extractor
│                    │  Data: Map<string, GraphNode> (directed object graph)
│                    │       PageSpatialIndex (grid-based spatial lookup)
└────────┬─────────┘
         ▼
┌──────────────────┐
│  2. OCR/Fusion   │  Pluggable OCR provider + recognition fusion
│                    │  Merges OCR text with parser-extracted text
└────────┬─────────┘
         ▼
┌──────────────────┐
│  3. LayoutEngine │  RawDocument → LayoutDocument
│                    │  Normalize → SpatialIndex → Cluster → Whitespace
│                    │  → XY-Cut Segment → Classify → Reading Order
│                    │  Data: LayoutRegion[], ReadingOrderGraph
└────────┬─────────┘
         ▼
┌──────────────────┐
│  4. IDM Engine   │  Layout → IntermediateDocument
│                    │  Canonical, format-independent document tree
│                    │  Section → Page → Block → Run → Word → Character
│                    │  Data: IntermediateDocument (immutable tree + nodeIndex)
└────────┬─────────┘
         ▼
┌──────────────────┐
│  5. Typography   │  Style profiling and clustering
│                    │  Font/size/weight clustering → style graph
│                    │  Data: TypographyAnalysis { profiles[], graph }
└────────┬─────────┘
         ▼
┌──────────────────┐
│  6. Semantic     │  Heading detection, list detection, quote detection
│                    │  Produces semantic node graph + reading order
│                    │  Data: SemanticDocument { nodes{}, readingOrder[] }
└────────┬─────────┘
         ▼
┌──────────────────┐
│  7. Table Engine │  Bordered + borderless table detection
│                    │  Grid reconstruction → cell merging → header detection
│                    │  Data: LogicalTable { rows[], columns[], cells[] }
└────────┬─────────┘
         ▼
┌──────────────────┐
│  8. Graphics     │  Image/vector/chart reconstruction
│                    │  Caption association, text wrapping analysis
│                    │  Data: GraphicsModel { objects[], resources }
└────────┬─────────┘
         ▼
┌──────────────────┐
│  9. Structure    │  Headers/footers, TOC, bookmarks, footnotes,
│                    │  page numbers, sections, hyperlinks
│                    │  Data: DocumentStructureModel
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 10. UDM Assembly │  Merges IDM + Semantic + Tables + Graphics +
│                    │  Structure + Recognition + Typography
│                    │  into UnifiedDocumentModel
│                    │  → Sole input to all exporters
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 11. Export       │  Plugin SDK — each format is an IExportPlugin
│  (In Progress)   │  DOCX │ XLSX │ PPTX │ HTML │ Markdown │ EPUB
│                    │  RTF │ ODT │ TXT │ JSON │ XML │ SVG
└──────────────────┘
```

> **Architecture rule:** Exporters depend **only** on the UDM — they never touch the PDF parser, raw model, or layout objects. This clean separation means adding a new export format requires zero knowledge of PDF internals.

### Key Data Structures

| Structure | Module | Implementation |
|-----------|--------|---------------|
| **ObjectGraph** | Server Parser | Directed graph (`Map<string, GraphNode>`) linking every extracted PDF object with parent/child/sibling relationships and spatial metadata |
| **PageSpatialIndex** | Server Parser | Grid-based spatial index (configurable cell size, default 72pt) for O(1) nearest-neighbor and rectangle queries |
| **QuadTree** | Client Editing | Recursive quadrant subdivision for spatial hit-testing of display items on the canvas |
| **XRefTable** | Client Parser | Cross-reference table (`Map<string, XRefEntry>`) mapping object numbers to byte offsets, supporting both cross-reference tables and cross-reference streams |
| **TransactionStack** | Client Editing | Undo/redo stack storing immutable snapshots of document state for each editing operation |
| **ReadingOrderGraph** | Server Layout | Directed acyclic graph of region reading order with weighted edges and topological sort |
| **IntermediateDocument** | Server IDM | Immutable tree (Section → Page → Block → Run → Word → Character) with flat `nodeIndex` for O(1) lookup by ID |
| **UnifiedDocumentModel** | Server UDM | Composite model merging IDM + semantic + tables + graphics + structure + recognition + typography — the single source of truth for all exporters |
| **InMemoryJobQueue** | Server Queue | Priority queue with three lanes (high/normal/low), automatic retry with exponential backoff, and dead-letter queue for failed jobs |

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9

### Installation

```bash
# Clone the repository
git clone https://github.com/stemlen/bloom-pdf-editor.git
cd bloom-pdf-editor

# Install dependencies (also installs server engine deps via postinstall)
npm install

# Start development server
npm run dev                   # Builds engine → starts Next.js
```

Open [http://localhost:3000](http://localhost:3000) — that's it. No API keys, no second terminal, no external services.

### How It Works

```
Browser → /api/bloom/* (Next.js Route Handlers) → server/dist (compiled engine)
```

The server engine runs **in the same Node.js process** as Next.js. Route Handlers under `/api/bloom/*` call into `@bloom/document-engine` directly — no network hop, no separate service.

### Convert a PDF

1. Upload a PDF in the editor
2. Toolbar → **Export** → **Document Convert**
3. Pick a target format → Convert → Download

Client-side exports (PNG, JPEG, SVG render, plain text) are available directly from the export panel without the server pipeline.

### Run Tests

```bash
npm test                      # Client engine tests (Vitest)
npm run server:test           # Server engine tests
```

### Docker (Optional)

```bash
cd server
docker build -t bloom-engine .
docker run --rm -p 8787:8787 bloom-engine
```

---

## 📁 Project Structure

```
bloom-pdf-editor/
├── src/
│   ├── app/                  # Next.js app router (pages, layouts)
│   ├── engine/               # ★ Client-side PDF engine (pure TypeScript)
│   │   ├── parser/           #   Binary PDF lexer + parser
│   │   ├── content/          #   Content stream interpreter
│   │   ├── fonts/            #   TrueType/CMap/GSUB/GPOS
│   │   ├── render/           #   Canvas 2D renderer
│   │   ├── flow/             #   Line/paragraph/Knuth-Plass
│   │   ├── bloom/            #   Word-processor document model
│   │   ├── editor/           #   Text/image/object editing
│   │   ├── writer/           #   PDF serialization + incremental save
│   │   ├── signatures/       #   Digital signature engine
│   │   ├── security/         #   Encryption/decryption/permissions
│   │   ├── forms/            #   AcroForm support
│   │   ├── editing/          #   QuadTree, undo/redo, scene graph
│   │   ├── color/            #   ICC profiles, color transforms
│   │   ├── image/            #   Image decoding
│   │   ├── watermark/        #   Watermark create/detect/remove
│   │   ├── ai/               #   Semantic search, text compare
│   │   ├── optimize/         #   GC, dedup, image compression
│   │   ├── ocr/              #   Layout analysis
│   │   ├── accessibility/    #   Tagged PDF (scaffolded)
│   │   ├── qa/               #   Quality assurance tests
│   │   ├── index.ts          #   Public API (730+ exports)
│   │   └── types.ts          #   Core PDF object types
│   └── lib/                  # Shared utilities
├── server/
│   └── src/
│       ├── engines/          # ★ Server document intelligence engines
│       │   ├── parser/       #   PDF → RawDocument + ObjectGraph
│       │   ├── layout/       #   Layout analysis (XY-Cut, clustering)
│       │   ├── ocr/          #   Recognition fusion
│       │   ├── idm/          #   Intermediate Document Model
│       │   ├── typography/   #   Style profiling
│       │   ├── semantic/     #   Semantic structure detection
│       │   ├── table/        #   Table detection + reconstruction
│       │   ├── graphics/     #   Graphics reconstruction
│       │   ├── structure/    #   Document structure (TOC, headers…)
│       │   ├── udm/          #   Unified Document Model assembly
│       │   ├── exporter/     #   12 format exporters + plugin SDK
│       │   └── common/       #   Shared geometry + interfaces
│       ├── api/              # HTTP API (Hono)
│       ├── workers/          # Conversion pipeline worker
│       ├── queues/           # Priority queue + retry + DLQ
│       ├── jobs/             # Job lifecycle management
│       ├── storage/          # Local filesystem / in-memory storage
│       ├── cache/            # Cache layer
│       ├── telemetry/        # Observability + metrics
│       └── container.ts      # Dependency injection container
├── docs/
│   └── ENGINE.md             # Deep dive into every engine
├── CONTRIBUTING.md           # How to contribute
├── CODE_OF_CONDUCT.md        # Community guidelines
└── LICENSE                   # Apache License 2.0
```

---

## 🔌 Server API

When running the standalone server (`npm run server:dev`):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness + queue depth + supported formats |
| `GET` | `/metrics` | Queue stats + telemetry averages |
| `POST` | `/convert` | Upload PDF (multipart `file` + `target`, or raw body + `x-target` header) |
| `POST` | `/batch` | JSON `{ items: [{ filename, target, contentBase64 }] }` → batch job IDs |
| `GET` | `/jobs/:id` | Job status + progress |
| `GET` | `/download/:id` | Download converted file |
| `DELETE` | `/jobs/:id` | Cancel a pending job |

**Optional headers:** `x-api-key` (when `BLOOM_API_KEY` is set), `x-correlation-id`, `x-priority` (`high` | `normal` | `low`).

```bash
# Convert a PDF to HTML
curl -F file=@document.pdf -F target=html http://localhost:8787/convert

# Check job status
curl http://localhost:8787/jobs/<id>

# Health check
curl http://localhost:8787/health
```

---

## 🗺️ Roadmap

- [x] Pure TypeScript PDF parser (binary lexer, xref, object graph)
- [x] Full Canvas 2D renderer (color spaces, transparency, patterns, shading)
- [x] Text editing with Knuth-Plass line breaking and BiDi support
- [x] Complete digital signature engine (visual, cryptographic, LTV)
- [x] PDF encryption/decryption (RC4, AES, public-key)
- [x] AcroForm support (text, checkbox, radio, choice, calculation order)
- [x] Incremental save + full serialization
- [x] Server conversion pipeline (12-stage)
- [x] 12 export format plugins (DOCX, XLSX, PPTX, HTML, MD, EPUB, RTF, ODT, TXT, JSON, XML, SVG)
- [x] Priority job queue with retry + dead-letter
- [x] Docker support
- [ ] 🚧 Improve export fidelity across all formats
- [ ] Accessibility — tagged PDF structure
- [ ] Plugin marketplace for third-party exporters
- [ ] Collaborative editing
- [ ] Mobile-optimized UI

---

## 🤝 Contributing

We'd love your help! Whether it's fixing a bug, improving docs, or building a new exporter plugin — all contributions are welcome.

**See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide**, including:

- Setting up the development environment
- Code style and conventions
- How to write an exporter plugin
- How to submit a pull request

---

## 📄 License

This project is licensed under the **Apache License 2.0** — see the [LICENSE](LICENSE) file for details.

---

<div align="center">

**Built with ❤️ by the Bloom community**

[⬆ Back to top](#-bloom-pdf-editor)

</div>
