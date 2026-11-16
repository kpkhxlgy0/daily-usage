'use strict';
const os = require('node:os');
const path = require('node:path');

const Uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validHost = value => typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);

function createMain(api, dependencies = {})
{
    const ipcMain = dependencies.ipcMain || require('electron').ipcMain;
    const serviceFactory = dependencies.serviceFactory || require('./service.cjs').createService;
    const remoteFactory = dependencies.remoteFactory || require('./remote-store.cjs').createRemoteStore;
    const transportFactory = dependencies.transportFactory || require('./vendor/remote-transport.cjs').createRemoteTransport;
    const bindingScript = dependencies.bindingScript || require('./vendor/binding.cjs').bindingScript;
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const service = serviceFactory({ codexHome, dataDir: api.fs.dataDir });
    const remote = remoteFactory();
    const transport = transportFactory({ timeoutMs: 15000, maxChars: 4 * 1024 * 1024 });
    const hosts = new Map();
    const persisted = api.storage.get('knownHosts', []);
    if (Array.isArray(persisted))
    {
        for (const entry of persisted)
        {
            if (validHost(entry?.hostId) && entry.hostId !== 'local' && Uuid.test(entry.threadId))
                hosts.set(entry.hostId, { hostId: entry.hostId, threadId: entry.threadId });
        }
    }
    let stopped = false;
    const channels = [];
    const discovery = new Map();
    function register(name, fn)
    {
        const channel = `codexpp:${api.manifest.id}:${name}`;
        ipcMain.handle(channel, (event, payload) =>
        {
            if (stopped || !event.senderFrame || event.senderFrame !== event.sender.mainFrame)
                throw new Error('invalid-main-frame');
            return fn(event, payload);
        });
        channels.push(channel);
    }

    register('hosts', () => [{ hostId: 'local', label: `本机 · ${os.hostname()}` },
        ...[...hosts.values()].map(entry => ({ hostId: entry.hostId, label: `远程 · ${entry.hostId}` }))]);
    register('discover', event =>
    {
        const frame = event.senderFrame;
        if (discovery.has(frame)) return discovery.get(frame);
        const pending = Promise.resolve(frame.executeJavaScript(bindingScript)).then(bindings =>
        {
            if (stopped || !Array.isArray(bindings)) return;
            let changed = false;
            for (const { bound } of bindings)
            {
                if (!bound || !validHost(bound.hostId) || bound.hostId === 'local' || !Uuid.test(bound.threadId)) continue;
                if (hosts.get(bound.hostId)?.threadId === bound.threadId) continue;
                hosts.set(bound.hostId, { hostId: bound.hostId, threadId: bound.threadId });
                changed = true;
            }
            if (changed) api.storage.set('knownHosts', [...hosts.values()]);
        }).catch(() => {}).finally(() => discovery.delete(frame));
        discovery.set(frame, pending);
        return pending;
    });
    register('report', async (event, payload) =>
    {
        if (!payload || !validHost(payload.hostId)
            || Object.keys(payload).some(key => key !== 'hostId' && key !== 'refresh'))
            return { status: 'unavailable', error: 'invalid-host' };
        if (payload.hostId === 'local')
        {
            await service.ready;
            if (payload.refresh) service.refresh();
            return service.getState();
        }
        const identity = hosts.get(payload.hostId);
        if (!identity) return { status: 'unavailable', error: 'open-remote-conversation' };
        return remote.get(identity, (method, params, limits) =>
            transport.request(event.senderFrame, identity.hostId, method, params, limits));
    });
    api.log.info('Daily Usage main started; independent local collector and remote aggregate reader');
    return {
        async stop()
        {
            if (stopped) return;
            stopped = true;
            for (const channel of channels) ipcMain.removeHandler(channel);
            transport.dispose();
            await Promise.allSettled([service.dispose(), remote.dispose()]);
        }
    };
}

module.exports = { createMain };
