# SPEC.md: Architectural Specification for `stdin-wasi`

---

## 1. Architectural Ground Truth & Mission Statement

`stdin-wasi` is a zero-dependency, high-performance, **synchronous standard input (stdin) coordinator and ring buffer protocol** for WebAssembly (WASI Preview 1) runtimes executing in browser Web Workers, Node.js worker threads, and sandboxed environments.

Designed specifically for multi-worker browser IDEs (such as [`wasm-c-ide`](https://github.com/breeze833/wasm-c-ide)), interactive WebAssembly CLI runtimes (Python/Pyodide, Ruby, Lua, SQLite, BusyBox ash), and local/remote WASI hosts, `stdin-wasi` bridges the fundamental impedance mismatch between **synchronous blocking WASI `fd_read(0)` syscalls** (`scanf`, `cin`, `getchar`, `read`) and **asynchronous event-driven browser terminal emulators** ([`xterm.js`](https://github.com/xtermjs/xterm.js), LineEditor, DOM UI) via `SharedArrayBuffer` and `Atomics.wait()`.

---

## 2. Motivation & Architectural Problem Statement

In POSIX environments, reading from standard input is inherently synchronous and blocking:
```c
int val;
printf("Enter a number: ");
fflush(stdout);
scanf("%d", &val); // Blocks thread execution until user presses Enter
```

When compiled to WebAssembly targeting WASI Preview 1 (`wasm32-wasip1`), the C standard library emits the standard `fd_read` syscall:
```wasm
(import "wasi_snapshot_preview1" "fd_read" (func (param i32 i32 i32 i32) (result i32)))
```

### 2.1 The Browser Asynchrony Impasse
Web browsers and JavaScript event loops are single-threaded and non-blocking:
1. When WebAssembly calls `fd_read(0, ...)` inside a browser runtime, the host cannot simply suspend execution with `await` because WASI Preview 1 imports are strictly synchronous (`(result i32)`).
2. If `fd_read(0)` returns immediately without data (e.g. `EAGAIN` or `0`), POSIX programs treat it as `EOF` or spin in a 100% CPU busy-loop.
3. If WebAssembly runs on the main browser thread, calling blocking primitives like `Atomics.wait()` is explicitly forbidden by the HTML specification and throws a `TypeError`.

### 2.2 The Multi-Thread Atomics Solution
By running the WebAssembly execution inside a dedicated background Web Worker, `stdin-wasi` solves this problem cleanly:
1. **Worker Thread (Wasm Execution)**: Calls `Atomics.wait(int32View, STATE_IDX, STATE_WAITING)` inside the synchronous `fd_read(0)` import. The worker thread sleeps with 0% CPU overhead until data arrives.
2. **Main Thread (UI / Terminal)**: Captures user keystrokes from the terminal emulator, line editor, or DOM input. When the user completes a line (Enter) or delivers data, the main thread writes the payload into the `SharedArrayBuffer` and issues `Atomics.notify(int32View, STATE_IDX)`.
3. **Deterministic Waking & Scatter-Gather Transfer**: The worker thread immediately wakes up, copies bytes into WebAssembly linear memory across the requested `iovec` arrays, advances read offsets, and resumes the guest program without stutter or latency.

---

## 3. Target Platform & Environment Profile

- **Host Runtimes**:
  - Modern web browsers with Cross-Origin Opener Policy (`COOP: same-origin`) and Cross-Origin Embedder Policy (`COEP: require-corp`) enabling `window.crossOriginIsolated === true` and `SharedArrayBuffer`.
  - Node.js (>= 18) with standard `worker_threads` and `SharedArrayBuffer`.
  - Headless CI environments and automated test runners.
- **Zero Runtime Dependencies**: 100% pure vanilla JavaScript with zero third-party dependencies, zero native compilation, and zero framework lock-in.
- **WASI Specification Alignment**: Strictly conforms to the `wasi_snapshot_preview1` `fd_read` ABI layout and scatter-gather `ciovec_t` pointers.

---

## 4. Core Design Invariants

When implementing or extending `stdin-wasi`, strictly adhere to these fundamental design invariants:

1. **Deterministic Little-Endian Control Layout**:
   - The first 16 bytes (4 x 32-bit words) of the `SharedArrayBuffer` are permanently reserved for integer control fields:
     - Word 0 (`CONTROL_STATE_IDX = 0`): Channel state (`STATE_IDLE = 0`, `STATE_WAITING = 1`, `STATE_READY = 2`, `STATE_EOF = -1`).
     - Word 1 (`CONTROL_LEN_IDX = 1`): Total bytes currently written into the data payload buffer.
     - Word 2 (`CONTROL_READ_POS_IDX = 2`): Total bytes read from the payload buffer by the worker so far.
     - Word 3 (`CONTROL_RESERVED_IDX = 3`): Reserved for 16-byte cache line alignment and future flags.
   - All control index operations must strictly use `Atomics.load()`, `Atomics.store()`, `Atomics.wait()`, and `Atomics.notify()`.

2. **Zero-Copy Payload Alignment**:
   - Data payload begins immediately at byte offset 16 (`DATA_OFFSET = 16`).
   - Slices into the data payload must safely avoid multi-byte buffer misalignment.

3. **Scatter-Gather `iovec` Conformance**:
   - WASI `fd_read` passes an array of buffer descriptors `iovec` pointers `[ptr_0, len_0, ptr_1, len_1, ...]`.
   - The worker reader must iterate through the iovecs and fill them sequentially up to the available bytes in the channel or until all iovecs are satisfied.

4. **POSIX-Compliant EOF Signaling (`STATE_EOF`)**:
   - When the user presses `Ctrl-D` (`\x04`) on an empty line or input stream closes:
     - Host transitions state to `STATE_EOF` (-1) and calls `Atomics.notify()`.
     - Worker detects `STATE_EOF`, sets `*nread_out = 0`, and returns `ESUCCESS` (0).
     - Standard C runtimes interpret `nread == 0` as clean `EOF`, causing `scanf` to return `EOF` (-1) and `getchar` to return `EOF`.

5. **Preloaded Non-Interactive Stream Support**:
   - In automated tests or shell stream redirections (`./a.out < input.txt`, pipeline buffers `cat | ./a.out`), user interaction is not required.
   - `createStdinReader` must accept an optional preloaded `stdinBytes` (`Uint8Array` or `ArrayBuffer`).
   - When preloaded bytes are provided, the reader feeds from the preloaded stream synchronously without blocking on `Atomics.wait()`, transitioning seamlessly to EOF when depleted.

6. **Process Cancellation & Worker Abort Safety**:
   - If the host terminates the worker (e.g. `worker.terminate()` on `Ctrl-C`), the channel is safely cleared via `host.reset()`.
   - Subsequent process invocations must never encounter stale or poisoned `STATE_WAITING` locks.

---

## 5. Binary Memory Layout & Protocol Specification

### 5.1 SharedArrayBuffer Layout
```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       STATE (Int32, idx 0)                    |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      DATA_LEN (Int32, idx 1)                  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      READ_POS (Int32, idx 2)                  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      RESERVED (Int32, idx 3)                  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                   DATA PAYLOAD (Bytes 16..N)                  |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### 5.2 State Machine Transitions

```
           ┌──────────┐
           │   IDLE   │ ◄──────────────────────────────┐
           │ (state 0)│                                │
           └────┬─────┘                                │
                │ worker needs input                   │
                │ Atomics.store(state, 1)              │ host.reset()
                ▼                                      │
           ┌──────────┐                                │
           │ WAITING  │ ── host calls sendEof() ───────┤
           │ (state 1)│    Atomics.store(state, -1)    │
           └────┬─────┘    Atomics.notify()            │
                │ host calls sendInput(data)           │
                │ Atomics.store(state, 2)              │
                │ Atomics.notify()                     │
                ▼                                      │
           ┌──────────┐                                │
           │  READY   │ ───────────────────────────────┘
           │ (state 2)│ worker finishes reading buffer
           └──────────┘ Atomics.store(state, 0)
```

---

## 6. Public API Specification

### 6.1 Subpath Exports
The package provides modular subpath exports via `package.json`:
- **`stdin-wasi`**: Main unified entry point exporting `StdinHost`, `StdinWorker`, `createStdinReader`, and constants.
- **`stdin-wasi/host`**: Host-side manager (`StdinHost`).
- **`stdin-wasi/worker`**: Worker-side reader (`StdinWorker`, `createStdinReader`).
- **`stdin-wasi/buffer`**: Protocol constants, states, and buffer indices.

### 6.2 `StdinHost` (`src/host.js`)
Class instantiated on the main browser thread or host process:
- **`new StdinHost(options = {})`**:
  - `options.bufferSize`: Size of `SharedArrayBuffer` in bytes (default: `8192` / 8 KB).
  - `options.sharedBuffer`: Existing `SharedArrayBuffer` to attach to (optional).
  - `options.onInputRequest`: Callback invoked when worker begins waiting for input.
- **Methods**:
  - **`getSharedBuffer(): SharedArrayBuffer`**: Returns underlying `SharedArrayBuffer` to transfer/post to worker.
  - **`sendInput(data: string | Uint8Array): number`**: Writes text or byte payload into channel, advances control length, and notifies worker. Returns number of bytes written.
  - **`sendEof(): void`**: Transitions channel to `STATE_EOF` (-1) and notifies worker.
  - **`isWaiting(): boolean`**: Returns `true` if worker is currently suspended inside `Atomics.wait()`.
  - **`reset(): void`**: Resets buffer pointers and sets state back to `STATE_IDLE`.

### 6.3 `createStdinReader` (`src/worker.js`)
Factory function creating a synchronous `fd_read` standard input handler for WASI Preview 1 host:
- **`createStdinReader(options = {})`**:
  - `options.sharedBuffer`: `SharedArrayBuffer` provided by the host.
  - `options.stdinBytes`: Optional preloaded `Uint8Array` or `ArrayBuffer` for non-interactive execution.
  - `options.notifyHost`: Callback to post non-blocking message to host when blocking (e.g. `self.postMessage({ type: 'stdin_request' })`).
  - `options.getMemory`: Function returning the WebAssembly linear memory `WebAssembly.Memory`.
- **Returns**:
  - `readStdin(iovs: number, iovs_len: number, nread_out: number): number`:
    Standard WASI Preview 1 compliant reader function returning `ESUCCESS` (0) or error errno.

---

## 7. Verification & Testing Requirements

To guarantee rock-solid reliability across multi-worker environments, the automated test suite must verify:

1. **State Machine Integrity**:
   - Deterministic transitions across `IDLE` $\to$ `WAITING` $\to$ `READY` $\to$ `IDLE` and `WAITING` $\to$ `EOF`.
2. **Synchronous Data Delivery**:
   - Host `sendInput("hello\n")` resumes worker blocked in `Atomics.wait()`.
   - Worker extracts `"hello\n"` into WebAssembly memory with byte-for-byte fidelity.
3. **Partial & Multi-Chunk Reads**:
   - Sending more data than requested by a single `iovec` preserves unread bytes in buffer; subsequent `fd_read` calls consume remainder without blocking or losing data.
4. **Clean EOF Signaling (`Ctrl-D`)**:
   - Calling `sendEof()` wakes waiting worker, sets `nread = 0`, and cleanly terminates input loops.
5. **Preloaded Non-Interactive Stream**:
   - Preloaded `stdinBytes` stream feeds all bytes synchronously with zero `Atomics.wait()` blocks, terminating cleanly at EOF.
6. **Multi-Buffer Scatter-Gather**:
   - Multiple `iovec` buffers are filled contiguously up to available bytes.
7. **Reset & Reuse**:
   - Resetting channel clears all states and offsets for subsequent process launches without memory reallocation.
