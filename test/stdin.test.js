// Automated Unit Tests: Synchronous stdin and Preloaded Stream

import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  StdinHost,
  createStdinReader,
  ESUCCESS,
  STATE_IDLE,
  STATE_WAITING,
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerHelperPath = path.join(__dirname, 'worker_helper.js');

test('Preloaded Stdin: Single Buffer Read and Stream Exhaustion', () => {
  const memory = new ArrayBuffer(65536);
  const view = new DataView(memory);
  const u8 = new Uint8Array(memory);

  const reader = createStdinReader({
    stdinBytes: 'alpha\nbeta\n',
    getMemory: () => memory,
  });

  // Setup iovec: buf at offset 1024, len = 6
  view.setUint32(0, 1024, true);
  view.setUint32(4, 6, true);
  const nreadPtr = 128;

  // First read: should read "alpha\n" (6 bytes)
  let ret = reader(0, 1, nreadPtr);
  assert.equal(ret, ESUCCESS);
  assert.equal(view.getUint32(nreadPtr, true), 6);
  let readStr = new TextDecoder().decode(u8.subarray(1024, 1030));
  assert.equal(readStr, 'alpha\n');

  // Second read: should read "beta\n" (5 bytes)
  view.setUint32(0, 1024, true);
  view.setUint32(4, 10, true);
  ret = reader(0, 1, nreadPtr);
  assert.equal(ret, ESUCCESS);
  assert.equal(view.getUint32(nreadPtr, true), 5);
  readStr = new TextDecoder().decode(u8.subarray(1024, 1029));
  assert.equal(readStr, 'beta\n');

  // Third read: stream exhausted, should return 0 bytes (EOF)
  ret = reader(0, 1, nreadPtr);
  assert.equal(ret, ESUCCESS);
  assert.equal(view.getUint32(nreadPtr, true), 0);
});

test('Preloaded Stdin: Multi-iovec Scatter-Gather', () => {
  const memory = new ArrayBuffer(65536);
  const view = new DataView(memory);
  const u8 = new Uint8Array(memory);

  const reader = createStdinReader({
    stdinBytes: '1234567890',
    getMemory: () => memory,
  });

  // Setup 2 iovecs at offset 0:
  // iov[0]: ptr 1000, len 4 -> "1234"
  // iov[1]: ptr 2000, len 6 -> "567890"
  view.setUint32(0, 1000, true);
  view.setUint32(4, 4, true);
  view.setUint32(8, 2000, true);
  view.setUint32(12, 6, true);

  const nreadPtr = 128;
  const ret = reader(0, 2, nreadPtr);
  assert.equal(ret, ESUCCESS);
  assert.equal(view.getUint32(nreadPtr, true), 10);

  const str1 = new TextDecoder().decode(u8.subarray(1000, 1004));
  const str2 = new TextDecoder().decode(u8.subarray(2000, 2006));
  assert.equal(str1, '1234');
  assert.equal(str2, '567890');
});

test('Multi-threaded Interactive Stdin: Worker Blocks and Resumes', async () => {
  const host = new StdinHost();
  const worker = new Worker(workerHelperPath);

  try {
    // 1. Initialize worker
    await new Promise((resolve) => {
      worker.once('message', (msg) => {
        assert.equal(msg.status, 'ready');
        resolve();
      });
      worker.postMessage({ cmd: 'init', sharedBuffer: host.getSharedBuffer() });
    });

    // 2. Instruct worker to read
    const requestPromise = new Promise((resolve) => {
      worker.on('message', function onReq(msg) {
        if (msg.type === 'stdin_request') {
          worker.off('message', onReq);
          resolve();
        }
      });
    });

    worker.postMessage({ cmd: 'read', iovs: [32] });

    // Wait until worker enters waiting state
    await requestPromise;
    assert.equal(host.isWaiting(), true);

    // 3. Send input from host
    const readDonePromise = new Promise((resolve) => {
      worker.on('message', function onDone(msg) {
        if (msg.status === 'read_done') {
          worker.off('message', onDone);
          resolve(msg);
        }
      });
    });

    const sent = host.sendInput('Hello WASI!\n');
    assert.equal(sent, 12);

    const result = await readDonePromise;
    assert.equal(result.ret, ESUCCESS);
    assert.equal(result.nread, 12);
    const text = new TextDecoder().decode(new Uint8Array(result.bytes));
    assert.equal(text, 'Hello WASI!\n');
    assert.equal(host.getState(), STATE_IDLE);
  } finally {
    await worker.terminate();
  }
});

test('Multi-threaded Interactive Stdin: Partial Reads and Scatter-Gather', async () => {
  const host = new StdinHost();
  const worker = new Worker(workerHelperPath);

  try {
    // 1. Initialize worker
    await new Promise((resolve) => {
      worker.once('message', (msg) => {
        assert.equal(msg.status, 'ready');
        resolve();
      });
      worker.postMessage({ cmd: 'init', sharedBuffer: host.getSharedBuffer() });
    });

    // 2. Send 10 bytes upfront before worker even asks
    host.sendInput('ABCDEFGHIJ');

    // 3. Worker reads first 4 bytes
    const read1Promise = new Promise((resolve) => {
      worker.on('message', function onDone(msg) {
        if (msg.status === 'read_done') {
          worker.off('message', onDone);
          resolve(msg);
        }
      });
    });
    worker.postMessage({ cmd: 'read', iovs: [4] });
    const res1 = await read1Promise;
    assert.equal(res1.nread, 4);
    assert.equal(new TextDecoder().decode(new Uint8Array(res1.bytes)), 'ABCD');

    // 4. Worker reads remaining 6 bytes across 2 iovecs [2, 4]
    const read2Promise = new Promise((resolve) => {
      worker.on('message', function onDone(msg) {
        if (msg.status === 'read_done') {
          worker.off('message', onDone);
          resolve(msg);
        }
      });
    });
    worker.postMessage({ cmd: 'read', iovs: [2, 4] });
    const res2 = await read2Promise;
    assert.equal(res2.nread, 6);
    assert.equal(new TextDecoder().decode(new Uint8Array(res2.bytes)), 'EFGHIJ');

    // Buffer fully drained, state returned to IDLE
    assert.equal(host.getState(), STATE_IDLE);
  } finally {
    await worker.terminate();
  }
});
