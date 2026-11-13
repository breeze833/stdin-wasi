// Host-side Standard Input (stdin) Coordinator for stdin-wasi

import {
  STATE_IDLE,
  STATE_WAITING,
  STATE_READY,
  STATE_EOF,
  CONTROL_STATE_IDX,
  CONTROL_LEN_IDX,
  CONTROL_READ_POS_IDX,
  DATA_OFFSET,
  DEFAULT_BUFFER_SIZE,
} from './buffer.js';

const encoder = new TextEncoder();

export class StdinHost {
  constructor(options = {}) {
    this.bufferSize = options.bufferSize || DEFAULT_BUFFER_SIZE;
    if (this.bufferSize < DATA_OFFSET + 1) {
      throw new Error(`Buffer size (${this.bufferSize}) must be at least ${DATA_OFFSET + 1} bytes`);
    }

    if (options.sharedBuffer) {
      if (!(options.sharedBuffer instanceof SharedArrayBuffer)) {
        throw new TypeError('sharedBuffer must be an instance of SharedArrayBuffer');
      }
      this.sharedBuffer = options.sharedBuffer;
      this.bufferSize = this.sharedBuffer.byteLength;
    } else {
      if (typeof SharedArrayBuffer === 'undefined') {
        throw new Error('SharedArrayBuffer is not supported in this environment');
      }
      this.sharedBuffer = new SharedArrayBuffer(this.bufferSize);
    }

    this.sharedInt32 = new Int32Array(this.sharedBuffer);
    this.sharedUint8 = new Uint8Array(this.sharedBuffer);
    this.maxPayload = this.bufferSize - DATA_OFFSET;
    this.onInputRequest = typeof options.onInputRequest === 'function' ? options.onInputRequest : null;

    // Initialize state to IDLE
    this.reset();
  }

  getSharedBuffer() {
    return this.sharedBuffer;
  }

  sendInput(data) {
    let bytes;
    if (typeof data === 'string') {
      bytes = encoder.encode(data);
    } else if (data instanceof Uint8Array) {
      bytes = data;
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      throw new TypeError('sendInput accepts string, Uint8Array, or ArrayBuffer');
    }

    if (bytes.length > this.maxPayload) {
      throw new RangeError(`Input payload (${bytes.length} bytes) exceeds maximum buffer payload (${this.maxPayload} bytes)`);
    }

    // Copy bytes into payload section starting at DATA_OFFSET
    this.sharedUint8.set(bytes, DATA_OFFSET);

    // Update control pointers and notify worker
    Atomics.store(this.sharedInt32, CONTROL_READ_POS_IDX, 0);
    Atomics.store(this.sharedInt32, CONTROL_LEN_IDX, bytes.length);
    Atomics.store(this.sharedInt32, CONTROL_STATE_IDX, STATE_READY);
    Atomics.notify(this.sharedInt32, CONTROL_STATE_IDX);

    return bytes.length;
  }

  sendEof() {
    Atomics.store(this.sharedInt32, CONTROL_STATE_IDX, STATE_EOF);
    Atomics.notify(this.sharedInt32, CONTROL_STATE_IDX);
  }

  getState() {
    return Atomics.load(this.sharedInt32, CONTROL_STATE_IDX);
  }

  isWaiting() {
    return Atomics.load(this.sharedInt32, CONTROL_STATE_IDX) === STATE_WAITING;
  }

  reset() {
    Atomics.store(this.sharedInt32, CONTROL_STATE_IDX, STATE_IDLE);
    Atomics.store(this.sharedInt32, CONTROL_LEN_IDX, 0);
    Atomics.store(this.sharedInt32, CONTROL_READ_POS_IDX, 0);
  }

  handleWorkerMessage(msg) {
    if (msg && msg.type === 'stdin_request') {
      if (typeof this.onInputRequest === 'function') {
        this.onInputRequest();
      }
      return true;
    }
    return false;
  }
}
