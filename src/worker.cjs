'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { createCollector } = require('./collector.cjs');

const collector = createCollector({ ...workerData,
    onProgress: progress => parentPort.postMessage({ type: 'progress', progress }) });
let running = false;
parentPort.on('message', async message =>
{
    if (message.type !== 'scan' || running) return;
    running = true;
    try { parentPort.postMessage({ type: 'result', report: await collector.scan() }); }
    catch (error) { parentPort.postMessage({ type: 'error', error: error.code || 'collector-failed' }); }
    finally { running = false; }
});
