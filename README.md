# stdin-wasi

> Zero-dependency, high-performance synchronous standard input (stdin) coordinator and ring buffer protocol for WebAssembly (WASI Preview 1) runtimes.

[![Release](https://img.shields.io/github/v/release/breeze833/stdin-wasi)](https://github.com/breeze833/stdin-wasi/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Overview

In POSIX environments, standard input (`scanf`, `cin`, `getchar`, `read(0, ...)`) is inherently synchronous and blocking. When compiling C/C++ or language runtimes to WebAssembly targeting **WASI Preview 1 (`wasm32-wasip1`)**, the program issues synchronous `fd_read` imports.

However, browser JavaScript and terminal emulators ([`xterm.js`](https://github.com/xtermjs/xterm.js)) are asynchronous and event-driven. Calling `Atomics.wait()` on the main thread is forbidden by the browser specification.

`stdin-wasi` solves this problem by coordinating standard input across Web Workers:
1. **Worker Side**: WebAssembly executes inside a background Web Worker. When calling `fd_read(0)`, it calls `Atomics.wait()` on a `SharedArrayBuffer` and sleeps with **0% CPU usage** until input arrives.
2. **Host Side**: The main thread captures user keystrokes from the terminal or LineEditor, writes the line payload into the `SharedArrayBuffer`, and calls `Atomics.notify()` to resume the worker instantly.
3. **Deterministic Scatter-Gather**: The worker wakes up, fills the requested `iovec` arrays in WebAssembly linear memory, and returns execution cleanly.

---

## Key Features

- **Synchronous Blocking Stdin Coordination**: Enables standard C/C++ `scanf`, `cin`, `getchar`, and REPL loops in browser Web Workers.
- **Zero-CPU Waiting**: Uses `Atomics.wait()` to sleep the thread without busy loops or polling intervals.
- **WASI Preview 1 ABI Conformance**: Conforms to the `wasi_snapshot_preview1` scatter-gather `ciovec_t` memory layout.
- **POSIX EOF Signaling**: Clean `Ctrl-D` / EOF detection through `STATE_EOF` state transition returning `nread = 0`.
- **Preloaded Stream Support**: Feeds preloaded byte arrays synchronously for automated tests and pipeline/redirection execution without blocking on Atomics.
- **Process Cancellation Resilient**: Safely clears locks via `host.reset()` upon `Ctrl-C` or worker termination.
- **Zero Runtime Dependencies**: 100% pure vanilla JavaScript. Zero third-party npm packages, zero native C/C++ bindings, and zero framework dependencies.

---

## Architecture & Memory Layout

```
Main Thread (Terminal / UI)                    Web Worker (Wasm Runtime)
 ┌─────────────────────────┐                   ┌─────────────────────────┐
 │   StdinHost             │                   │   createStdinReader     │
 │                         │                   │                         │
 │ 1. onInputRequest()     │ ◄── postMessage ──│ 1. fd_read(0, iovs, ...)│
 │ 2. sendInput(text)      │                   │ 2. Atomics.wait(...)    │
 │    - write payload      │                   │    (sleeps with 0% CPU) │
 │    - Atomics.notify()   │ ── SharedBuffer ─►│ 3. Wakes up, copies to  │
 │                         │                   │    Wasm linear memory   │
 └─────────────────────────┘                   └─────────────────────────┘
```

The first 16 bytes (4 x 32-bit words) of the `SharedArrayBuffer` define the control channel:
- **`Word 0`**: Channel state (`IDLE = 0`, `WAITING = 1`, `READY = 2`, `EOF = -1`).
- **`Word 1`**: Total payload bytes written by the host.
- **`Word 2`**: Total payload bytes read by the worker.
- **`Word 3`**: Reserved for 16-byte alignment.
- **`Bytes 16..N`**: Data payload bytes.

---

## Installation

`stdin-wasi` is published directly to [GitHub Releases](https://github.com/breeze833/stdin-wasi/releases) as pre-packaged `.tgz` distribution archives.

### Install via GitHub Releases Tarball

```bash
npm install https://github.com/breeze833/stdin-wasi/releases/download/latest/stdin-wasi-0.1.0.tgz
```

Or add directly to `package.json`:

```json
{
  "dependencies": {
    "stdin-wasi": "https://github.com/breeze833/stdin-wasi/releases/download/latest/stdin-wasi-0.1.0.tgz"
  }
}
```

---

## Quick Start

### 1. Host Side (Main Thread / UI)

```javascript
import { StdinHost } from 'stdin-wasi/host';

// 1. Allocate SharedArrayBuffer and initialize host coordinator
const stdinHost = new StdinHost({ bufferSize: 8192 });

// 2. Pass the SharedArrayBuffer to the Web Worker during initialization
worker.postMessage({
  type: 'init',
  sharedBuffer: stdinHost.getSharedBuffer(),
});

// 3. Listen for worker input requests
worker.onmessage = (event) => {
  if (event.data.type === 'stdin_request') {
    terminal.setPrompt('Input: ');
  }
};

// 4. Send entered line when user presses Enter
terminal.onLine((line) => {
  stdinHost.sendInput(line + '\n');
});

// 5. Send EOF when user presses Ctrl-D
terminal.onEof(() => {
  stdinHost.sendEof();
});
```

### 2. Worker Side (WebAssembly / WASI Runtime)

```javascript
import { createStdinReader } from 'stdin-wasi/worker';

self.onmessage = async (event) => {
  const { sharedBuffer, wasmModule } = event.data;

  let instance = null;

  // 1. Create the synchronous stdin reader
  const readStdin = createStdinReader({
    sharedBuffer,
    getMemory: () => instance.exports.memory,
    notifyHost: () => self.postMessage({ type: 'stdin_request' }),
  });

  // 2. Attach to WASI fd_read import
  const wasiImports = {
    fd_read: (fd, iovs, iovs_len, nread_out) => {
      if (fd === 0) {
        return readStdin(iovs, iovs_len, nread_out);
      }
      // handle other file descriptors...
    },
  };

  instance = await WebAssembly.instantiate(wasmModule, {
    wasi_snapshot_preview1: wasiImports,
  });

  instance.exports._start();
};
```

### 3. Non-Interactive Stream Redirection (Preloaded Bytes)

For automated tests or shell redirections (`./a.out < input.txt`), pass preloaded bytes without allocating `SharedArrayBuffer`:

```javascript
const readStdin = createStdinReader({
  stdinBytes: new TextEncoder().encode("42\n"),
  getMemory: () => instance.exports.memory,
});
```

---

## Subpath Exports

```javascript
// Unified package import
import { StdinHost, StdinWorker, createStdinReader, STATE_EOF } from 'stdin-wasi';

// Subpath imports
import { StdinHost } from 'stdin-wasi/host';
import { createStdinReader, StdinWorker } from 'stdin-wasi/worker';
import { STATE_IDLE, STATE_WAITING, STATE_READY, STATE_EOF, DATA_OFFSET } from 'stdin-wasi/buffer';
```

---

## Development & Testing

```bash
# Run automated tests
npm test

# Build distribution tarball
make dist
```

---

## License

This project is licensed under the [MIT License](LICENSE).
