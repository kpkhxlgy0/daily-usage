'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { createCollector } = require('./collector.cjs');

const collector = createCollector({ ...workerData,
    onProgress: progress => parentPort.postMessage({ type: 'progress', progress }) });
parentPort.once('message', async message =>
{
    try
    {
        if (message?.type === 'scan') parentPort.postMessage({ type: 'result', report: await collector.scan() });
    }
    catch (error) { parentPort.postMessage({ type: 'error', error: error.code || 'collector-failed' }); }
    finally
    {
        await collector.dispose();
        parentPort.close();
    }
});
