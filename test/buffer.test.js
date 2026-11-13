// Automated Unit Tests: Buffer Layout, Constants, and StdinHost validation

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STATE_IDLE,
  STATE_WAITING,
  STATE_READY,
  STATE_EOF,
  CONTROL_STATE_IDX,
  CONTROL_LEN_IDX,
  CONTROL_READ_POS_IDX,
  CONTROL_RESERVED_IDX,
  DATA_OFFSET,
  DEFAULT_BUFFER_SIZE,
  ESUCCESS,
  EBADF,
  EINVAL,
  EIO,
  StdinHost,
} from '../src/index.js';

test('Buffer: Protocol Constants & Offsets', () => {
  assert.equal(STATE_IDLE, 0);
  assert.equal(STATE_WAITING, 1);
  assert.equal(STATE_READY, 2);
  assert.equal(STATE_EOF, -1);

  assert.equal(CONTROL_STATE_IDX, 0);
  assert.equal(CONTROL_LEN_IDX, 1);
  assert.equal(CONTROL_READ_POS_IDX, 2);
  assert.equal(CONTROL_RESERVED_IDX, 3);

  assert.equal(DATA_OFFSET, 16);
  assert.equal(DEFAULT_BUFFER_SIZE, 8192);

  assert.equal(ESUCCESS, 0);
  assert.equal(EBADF, 8);
  assert.equal(EINVAL, 28);
  assert.equal(EIO, 29);
});

test('StdinHost: Default Initialization', () => {
  const host = new StdinHost();
  assert.equal(host.bufferSize, 8192);
  assert.equal(host.maxPayload, 8192 - 16);
  assert.equal(host.getState(), STATE_IDLE);
  assert.equal(host.isWaiting(), false);

  const sab = host.getSharedBuffer();
  assert.ok(sab instanceof SharedArrayBuffer);
  assert.equal(sab.byteLength, 8192);
});

test('StdinHost: Custom Buffer Size & Attachment', () => {
  const customSize = 4096;
  const host = new StdinHost({ bufferSize: customSize });
  assert.equal(host.bufferSize, customSize);
  assert.equal(host.maxPayload, customSize - 16);

  // Attach second host to the same SharedArrayBuffer
  const sab = host.getSharedBuffer();
  const host2 = new StdinHost({ sharedBuffer: sab });
  assert.equal(host2.getSharedBuffer(), sab);
  assert.equal(host2.bufferSize, customSize);
});

test('StdinHost: Buffer Size Constraints and Validation', () => {
  assert.throws(() => {
    new StdinHost({ bufferSize: 10 }); // below DATA_OFFSET + 1 (17)
  }, /Buffer size/);

  assert.throws(() => {
    new StdinHost({ sharedBuffer: new ArrayBuffer(1024) }); // ArrayBuffer not SAB
  }, TypeError);
});

test('StdinHost: sendInput with String and Typed Arrays', () => {
  const host = new StdinHost();

  // String input
  const n1 = host.sendInput('hello\n');
  assert.equal(n1, 6);
  assert.equal(host.getState(), STATE_READY);
  assert.equal(Atomics.load(host.sharedInt32, CONTROL_LEN_IDX), 6);
  assert.equal(Atomics.load(host.sharedInt32, CONTROL_READ_POS_IDX), 0);

  // Inspect raw byte payload
  const u8 = new Uint8Array(host.getSharedBuffer());
  const str = new TextDecoder().decode(u8.subarray(DATA_OFFSET, DATA_OFFSET + 6));
  assert.equal(str, 'hello\n');

  // Uint8Array input
  const rawBytes = new Uint8Array([65, 66, 67, 10]); // "ABC\n"
  const n2 = host.sendInput(rawBytes);
  assert.equal(n2, 4);
  assert.equal(host.getState(), STATE_READY);
  assert.equal(Atomics.load(host.sharedInt32, CONTROL_LEN_IDX), 4);
  assert.equal(Atomics.load(host.sharedInt32, CONTROL_READ_POS_IDX), 0);

  // RangeError on payload exceeding buffer
  assert.throws(() => {
    const huge = new Uint8Array(host.maxPayload + 10);
    host.sendInput(huge);
  }, RangeError);

  // TypeError on invalid data type
  assert.throws(() => {
    host.sendInput(12345);
  }, TypeError);
});

test('StdinHost: Message Handling and Callback Dispatch', () => {
  let requested = false;
  const host = new StdinHost({
    onInputRequest: () => {
      requested = true;
    },
  });

  const handled = host.handleWorkerMessage({ type: 'stdin_request' });
  assert.equal(handled, true);
  assert.equal(requested, true);

  const ignored = host.handleWorkerMessage({ type: 'other_event' });
  assert.equal(ignored, false);
});
