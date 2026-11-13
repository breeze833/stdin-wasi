// Helper worker script for testing synchronous Atomics.wait in Node.js worker_threads
import { parentPort } from 'node:worker_threads';
import { createStdinReader, ESUCCESS } from '../src/index.js';

let reader = null;
let linearMemory = null;
let memoryView = null;
let memoryU8 = null;

function setupMemory(size = 65536) {
  linearMemory = new ArrayBuffer(size);
  memoryView = new DataView(linearMemory);
  memoryU8 = new Uint8Array(linearMemory);
}

setupMemory();

parentPort.on('message', (msg) => {
  if (msg.cmd === 'init') {
    reader = createStdinReader({
      sharedBuffer: msg.sharedBuffer,
      notifyHost: () => {
        parentPort.postMessage({ type: 'stdin_request' });
      },
      getMemory: () => linearMemory,
    });
    parentPort.postMessage({ status: 'ready' });
    return;
  }

  if (msg.cmd === 'read') {
    // Layout iovec array at memory offset 1024
    const iovsPtr = 1024;
    const iovs = msg.iovs; // Array of buffer lengths, e.g. [16, 32]
    let curBufPtr = 2048;

    for (let i = 0; i < iovs.length; i++) {
      const len = iovs[i];
      memoryView.setUint32(iovsPtr + i * 8, curBufPtr, true);
      memoryView.setUint32(iovsPtr + i * 8 + 4, len, true);
      curBufPtr += len;
    }

    const nreadOut = 512;
    memoryView.setUint32(nreadOut, 0, true);

    const ret = reader(iovsPtr, iovs.length, nreadOut);
    const nread = memoryView.getUint32(nreadOut, true);

    // Collect all read bytes across iovecs
    const resultBytes = [];
    curBufPtr = 2048;
    let remainingToCollect = nread;

    for (let i = 0; i < iovs.length; i++) {
      const len = iovs[i];
      const take = Math.min(len, remainingToCollect);
      if (take > 0) {
        resultBytes.push(...memoryU8.subarray(curBufPtr, curBufPtr + take));
        remainingToCollect -= take;
      }
      curBufPtr += len;
    }

    parentPort.postMessage({
      status: 'read_done',
      ret,
      nread,
      bytes: resultBytes,
    });
  }
});
