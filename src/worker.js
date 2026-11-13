// Worker-side Standard Input (stdin) Reader and Coordinator for stdin-wasi

import {
  STATE_IDLE,
  STATE_WAITING,
  STATE_READY,
  STATE_EOF,
  CONTROL_STATE_IDX,
  CONTROL_LEN_IDX,
  CONTROL_READ_POS_IDX,
  DATA_OFFSET,
  ESUCCESS,
  EINVAL,
} from './buffer.js';

const encoder = new TextEncoder();

/**
 * Resolves WebAssembly memory views from various memory representations.
 * Supports WebAssembly.Memory, functions returning memory, buffers, or host memory adapters.
 */
function getMemoryViews(memorySource, host) {
  let mem = memorySource;
  if (typeof mem === 'function') {
    mem = mem();
  }
  if (!mem && host) {
    if (typeof host.memU8 === 'function' && typeof host.memU32 === 'function') {
      const u8 = host.memU8();
      return {
        u8,
        view: new DataView(u8.buffer, u8.byteOffset, u8.byteLength),
      };
    }
    if (host.memory) {
      mem = typeof host.memory === 'function' ? host.memory() : host.memory;
    }
  }

  if (!mem) {
    throw new Error('StdinWorker: WebAssembly memory is not accessible');
  }

  if (mem instanceof Uint8Array) {
    return {
      u8: mem,
      view: new DataView(mem.buffer, mem.byteOffset, mem.byteLength),
    };
  }

  const buffer = mem.buffer || mem;
  if (!(buffer instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer))) {
    throw new TypeError('StdinWorker: invalid memory buffer object');
  }

  return {
    u8: new Uint8Array(buffer),
    view: new DataView(buffer),
  };
}

/**
 * Normalizes input data into a Uint8Array.
 */
function normalizeBytes(data) {
  if (!data) return null;
  if (typeof data === 'string') {
    return encoder.encode(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

/**
 * Creates a synchronous WASI Preview 1 fd_read reader for standard input (fd 0).
 *
 * @param {object} [options]
 * @param {SharedArrayBuffer} [options.sharedBuffer]
 * @param {Uint8Array|ArrayBuffer|string} [options.stdinBytes]
 * @param {Function} [options.notifyHost]
 * @param {Function|WebAssembly.Memory} [options.getMemory]
 * @returns {Function} (iovs: number, iovs_len: number, nread_out: number, host?: object) => number
 */
export function createStdinReader(options = {}) {
  let sharedBuffer = options.sharedBuffer || null;
  let sharedInt32 = sharedBuffer ? new Int32Array(sharedBuffer) : null;
  let sharedUint8 = sharedBuffer ? new Uint8Array(sharedBuffer) : null;

  let preloadedStdin = normalizeBytes(options.stdinBytes);
  let stdinPos = 0;

  const notifyHost = typeof options.notifyHost === 'function'
    ? options.notifyHost
    : options.notifyHost === false
      ? null
      : () => {
          if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
            try {
              self.postMessage({ type: 'stdin_request' });
            } catch (_) {}
          }
        };

  function updateSharedBuffer(buf) {
    sharedBuffer = buf;
    if (sharedBuffer) {
      sharedInt32 = new Int32Array(sharedBuffer);
      sharedUint8 = new Uint8Array(sharedBuffer);
    } else {
      sharedInt32 = null;
      sharedUint8 = null;
    }
  }

  function updatePreloadedStdin(bytes) {
    preloadedStdin = normalizeBytes(bytes);
    stdinPos = 0;
  }

  function readStdin(iovs, iovs_len, nread_out, host) {
    const memorySource = options.getMemory || (host && host.memory) || null;
    const { u8, view } = getMemoryViews(memorySource, host);

    // 1. Preloaded non-interactive stdin mode
    if (preloadedStdin) {
      let totalRead = 0;
      for (let i = 0; i < iovs_len; i++) {
        const bufPtr = view.getUint32(iovs + i * 8, true);
        const bufLen = view.getUint32(iovs + i * 8 + 4, true);

        const available = preloadedStdin.length - stdinPos;
        if (available <= 0) {
          break;
        }

        const toCopy = Math.min(bufLen, available);
        u8.set(preloadedStdin.subarray(stdinPos, stdinPos + toCopy), bufPtr);
        stdinPos += toCopy;
        totalRead += toCopy;

        if (toCopy < bufLen) {
          // Current iovec wasn't even completely filled, so no more preloaded bytes remain
          break;
        }
      }

      view.setUint32(nread_out, totalRead, true);
      return ESUCCESS;
    }

    // 2. Interactive SharedArrayBuffer mode
    if (!sharedInt32 || !sharedUint8) {
      // No input channel attached, return EOF immediately
      view.setUint32(nread_out, 0, true);
      return ESUCCESS;
    }

    let totalRead = 0;

    for (let i = 0; i < iovs_len; i++) {
      const bufPtr = view.getUint32(iovs + i * 8, true);
      const origBufLen = view.getUint32(iovs + i * 8 + 4, true);
      let bufLen = origBufLen;

      while (bufLen > 0) {
        let curLen = Atomics.load(sharedInt32, CONTROL_LEN_IDX);
        let curPos = Atomics.load(sharedInt32, CONTROL_READ_POS_IDX);
        let available = curLen - curPos;

        // If no bytes currently available in buffer
        if (available <= 0) {
          // If we already read some bytes across iovecs, do not block again;
          // return what we have so far (POSIX non-blocking readv behavior).
          if (totalRead > 0) {
            break;
          }

          // Check if already in EOF state
          const currentState = Atomics.load(sharedInt32, CONTROL_STATE_IDX);
          if (currentState === STATE_EOF) {
            break;
          }

          // Notify host that worker is waiting for stdin input
          if (notifyHost) {
            notifyHost();
          }

          // Transition to STATE_WAITING and block synchronously
          Atomics.store(sharedInt32, CONTROL_STATE_IDX, STATE_WAITING);
          Atomics.wait(sharedInt32, CONTROL_STATE_IDX, STATE_WAITING);

          const state = Atomics.load(sharedInt32, CONTROL_STATE_IDX);
          if (state === STATE_EOF) {
            // EOF signaled (Ctrl-D or stream end)
            break;
          }

          curLen = Atomics.load(sharedInt32, CONTROL_LEN_IDX);
          curPos = Atomics.load(sharedInt32, CONTROL_READ_POS_IDX);
          available = curLen - curPos;
          if (available <= 0) {
            break;
          }
        }

        // Copy available bytes into linear memory
        const toCopy = Math.min(bufLen, available);
        const sourceSlice = sharedUint8.subarray(
          DATA_OFFSET + curPos,
          DATA_OFFSET + curPos + toCopy
        );
        u8.set(sourceSlice, bufPtr + (origBufLen - bufLen));

        Atomics.add(sharedInt32, CONTROL_READ_POS_IDX, toCopy);
        bufLen -= toCopy;
        totalRead += toCopy;

        // Check if current payload was completely consumed
        if (curPos + toCopy >= curLen) {
          Atomics.store(sharedInt32, CONTROL_STATE_IDX, STATE_IDLE);
        }
      }

      // If available data in current input payload is exhausted, return immediately
      const curLen = Atomics.load(sharedInt32, CONTROL_LEN_IDX);
      const curPos = Atomics.load(sharedInt32, CONTROL_READ_POS_IDX);
      if (curLen - curPos <= 0 && totalRead > 0) {
        break;
      }
    }

    view.setUint32(nread_out, totalRead, true);
    return ESUCCESS;
  }

  readStdin.updateSharedBuffer = updateSharedBuffer;
  readStdin.updatePreloadedStdin = updatePreloadedStdin;

  return readStdin;
}

/**
 * Worker-side coordinator class for managing stdin state and providing reader functions.
 */
export class StdinWorker {
  constructor(options = {}) {
    this.options = { ...options };
    this.reader = createStdinReader(this.options);
  }

  setSharedBuffer(sharedBuffer) {
    this.options.sharedBuffer = sharedBuffer;
    this.reader.updateSharedBuffer(sharedBuffer);
  }

  setPreloadedStdin(stdinBytes) {
    this.options.stdinBytes = stdinBytes;
    this.reader.updatePreloadedStdin(stdinBytes);
  }

  getReader() {
    return this.reader;
  }

  read(iovs, iovs_len, nread_out, host) {
    return this.reader(iovs, iovs_len, nread_out, host);
  }
}
