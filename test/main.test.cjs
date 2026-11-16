'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMain } = require('../src/main.cjs');

test('main-frame IPC binds remote host itself and never accepts a renderer path', async () =>
{
    const handlers = new Map();
    const registry = new Map();
    const remoteCalls = [];
    const api = { manifest: { id: 'com.kpk.daily-usage' }, fs: { dataDir: 'unused' },
        log: { info() {}, error() {} }, storage: { get: k => registry.get(k), set: (k, v) => registry.set(k, v) } };
    const service = { ready: Promise.resolve(), getState: () => ({ status: 'ok' }), refresh() {}, dispose: async () => {} };
    const main = createMain(api, {
        ipcMain: { handle: (k, v) => handlers.set(k, v), removeHandler: k => handlers.delete(k) },
        serviceFactory: () => service,
        remoteFactory: () => ({ get: async identity => { remoteCalls.push(identity); return { status: 'ok' }; }, dispose() {} }),
        transportFactory: () => ({ request() {}, dispose() {} }), bindingScript: 'binding-test'
    });
    const frame = { executeJavaScript: async () => [{ bound: { hostId: 'rc:test',
        threadId: '11111111-1111-4111-8111-111111111111' } }] };
    const event = { senderFrame: frame, sender: { mainFrame: frame } };
    const call = (method, arg, from = event) => handlers.get(`codexpp:com.kpk.daily-usage:${method}`)(from, arg);
    assert.equal((await call('report', { hostId: 'rc:test', path: 'secret' })).status, 'unavailable');
    await call('discover');
    await call('report', { hostId: 'rc:test' });
    assert.deepEqual(remoteCalls, [{ hostId: 'rc:test', threadId: '11111111-1111-4111-8111-111111111111' }]);
    await assert.rejects(async () => call('hosts', null, { ...event, senderFrame: {} }), /frame/);
    await main.stop();
    assert.equal(handlers.size, 0);
});
