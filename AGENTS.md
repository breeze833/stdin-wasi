# AGENTS.md: Developer and AI Agent Guidelines for `stdin-wasi`

This document provides architectural context, design invariants, coding conventions, and maintenance procedures for AI agents and human contributors working on `stdin-wasi`.

---

## 1. Project Mission & Architecture

`stdin-wasi` is a zero-dependency, high-performance, **synchronous standard input (stdin) coordinator and ring buffer protocol** for WebAssembly (WASI Preview 1) runtimes executing in browser Web Workers, Node.js worker threads, and sandboxed environments.

Designed specifically for multi-worker browser IDEs (such as [`wasm-c-ide`](https://github.com/breeze833/wasm-c-ide)), interactive WebAssembly CLI runtimes (Python/Pyodide, Ruby, Lua, SQLite, BusyBox ash), and local/remote WASI hosts, `stdin-wasi` provides:
1. **Synchronous Blocking Stdin Coordination**: Bridges synchronous WASI `fd_read(0)` syscalls (`scanf`, `cin`, `getchar`, `read`) with asynchronous browser terminal emulators ([`xterm.js`](https://github.com/xtermjs/xterm.js), LineEditor, DOM UI) via `SharedArrayBuffer` and `Atomics.wait()`.
2. **Zero-Overhead Sleeping**: Suspends the execution thread with 0% CPU consumption during input waits without polling or busy loops.
3. **Scatter-Gather `iovec` Conformance**: Full compliance with the `wasi_snapshot_preview1` ABI for multi-buffer scatter-gather reads.
4. **POSIX-Compliant EOF Signaling**: Clean `Ctrl-D` / EOF detection through `STATE_EOF` state transition returning `nread = 0`.
5. **Preloaded Non-Interactive Stream Support**: Synchronous feed from preloaded byte arrays for automated tests and pipeline/redirection execution.
6. **Zero Runtime Dependencies**: 100% pure vanilla JavaScript with zero third-party packages, zero native C/C++ bindings, and zero framework dependencies.

---

## 2. Core Design Invariants

When modifying or extending the codebase, strictly adhere to these fundamental invariants:

1. **Strict Specification Alignment**:
   - `SPEC.md` is the architectural ground truth. Autonomous agents must strictly adhere to the architecture, binary layout, and API contracts defined in `SPEC.md`. Do not deviate, substitute architectures, or introduce heavyweight dependencies.
2. **Zero External Runtime Dependencies**:
   - The core engine (`src/index.js`, `src/host.js`, `src/worker.js`, `src/buffer.js`) must remain 100% zero-dependency modern JavaScript.
3. **Deterministic Control Layout & Atomics**:
   - The first 16 bytes of the `SharedArrayBuffer` are strictly reserved for 4 x 32-bit control words (`STATE`, `LEN`, `READ_POS`, `RESERVED`).
   - All state transitions and offset mutations must strictly use `Atomics.load()`, `Atomics.store()`, `Atomics.wait()`, and `Atomics.notify()`.
4. **Safe Little-Endian Alignment**:
   - WebAssembly linear memory and `SharedArrayBuffer` control words use 32-bit little-endian alignment. All offset arithmetic must preserve 4-byte boundaries.
5. **POSIX-Compliant EOF Invariant**:
   - When `STATE_EOF` is set, `readStdin` must set `*nread_out = 0` and return `ESUCCESS` (0), allowing guest C/C++ programs to cleanly detect end-of-file.
6. **Cross-Origin Isolation Awareness**:
   - In browser environments, `SharedArrayBuffer` requires Cross-Origin Opener Policy (`COOP: same-origin`) and Cross-Origin Embedder Policy (`COEP: require-corp`).
7. **Process Abort Resilience**:
   - Calling `host.reset()` must clear all states and pointers to prevent state contamination on subsequent process runs or `Ctrl-C` process terminations.

---

## 3. Developer Collaboration & Revision Workflow

All agent-assisted development in this repository must strictly adhere to the developer's 4-phase revision workflow:

```
┌──────────────────────────────────────────────────────────────┐
│  Phase 1: Specification Revision & Developer Confirmation     │
│  - Propose/update SPEC.md changes first                      │
│  - Await explicit developer review & approval                │
└──────────────────────────────┬───────────────────────────────┘
                               │ Approved
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Phase 2: Specification-Compliant Implementation             │
│  - Strictly implement according to the confirmed SPEC.md     │
│  - Verify automated tests (npm test) with zero failures      │
└──────────────────────────────┬───────────────────────────────┘
                               │ Verified
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Phase 3: Developer Manual Verification                      │
│  - Prompt developer to perform interactive verification      │
│  - Developer tests StdinHost & StdinWorker via unit tests    │
└──────────────────────────────┬───────────────────────────────┘
                               │ Developer Confirmed
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Phase 4: Explicitly Instructed Document Alignment & Commit  │
│  - Await developer's explicit instruction                    │
│  - Align secondary docs (README.md, package.json, etc.)      │
│  - Stage and commit changes to git repository                │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Directory Structure & Key Files

```
stdin-wasi/
├── SPEC.md                    # Technical specification & architectural ground truth
├── AGENTS.md                  # Developer & AI agent operating protocols (this file)
├── README.md                  # User-facing documentation, architecture, and quick start
├── LICENSE                    # MIT license
├── package.json               # Package metadata, exports, and npm test scripts
├── Makefile                   # Convenience Makefile (test, dist, clean)
├── .gitignore                 # Standard git ignore definitions
├── .github/
│   └── workflows/
│       └── release.yml        # Automated release packaging on v* tag push (GitHub Releases)
├── src/
│   ├── index.js               # Main package entry point and unified exports
│   ├── buffer.js              # Control word indices, states, and buffer constants
│   ├── host.js                # Host-side StdinHost controller (writes, notifies, EOF)
│   └── worker.js              # Worker-side createStdinReader (Atomics.wait, scatter-gather)
└── test/
    ├── buffer.test.js         # Buffer layout, alignment, and constant tests
    ├── stdin.test.js          # Synchronous input delivery, scatter-gather, and multi-read tests
    └── eof.test.js            # Ctrl-D EOF signaling, reset, and preloaded stream tests
```

---

## 5. Development & Testing Commands

```bash
# Run automated test suite
npm test
# (or: node test/buffer.test.js && node test/stdin.test.js && node test/eof.test.js)

# Package release archive
make dist

# Clean temporary files
make clean
```

---

## 6. Verification Checklist Before Committing Changes

Before completing tasks or submitting PRs, verify:

- [ ] Specification updated in `SPEC.md` and confirmed by the developer prior to code changes.
- [ ] Implementation strictly conforms to the confirmed `SPEC.md`.
- [ ] Automated tests (`npm test`) pass with zero errors in standard Node.js.
- [ ] Little-endian memory alignment and `SharedArrayBuffer` / `Atomics` state transitions verified.
- [ ] Clean `STATE_EOF` handling verified with `nread = 0`.
- [ ] Preloaded `stdinBytes` execution verified without blocking on `Atomics.wait()`.
- [ ] Secondary documentation (`README.md`, `package.json`, etc.) aligned upon explicit developer instruction.
- [ ] Git commit performed only when explicitly instructed by the developer.
