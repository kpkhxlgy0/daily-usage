'use strict';
const os = require('node:os');
const path = require('node:path');

const Uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validHost = value => typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const hostName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value.trim() : undefined;

function createMain(api, dependencies = {})
{
    const ipcMain = dependencies.ipcMain || require('electron').ipcMain;
    const serviceFactory = dependencies.serviceFactory || require('./service.cjs').createService;
    const demandFactory = dependencies.demandFactory || require('./demand-server.cjs').createDemandServer;
    const remoteFactory = dependencies.remoteFactory || require('./remote-store.cjs').createRemoteStore;
    const transportFactory = dependencies.transportFactory || require('./vendor/remote-transport.cjs').createRemoteTransport;
    const bindingScript = dependencies.bindingScript || require('./vendor/binding.cjs').bindingScript;
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const service = serviceFactory({ codexHome, dataDir: api.fs.dataDir });
    const demandServer = demandFactory({ codexHome, service });
    Promise.resolve(demandServer.ready).catch(error => api.log.error('Daily Usage demand receiver unavailable',
        error.code || 'initialization-failed'));
    const remote = remoteFactory();
    const transport = transportFactory({ timeoutMs: 15000, maxChars: 4 * 1024 * 1024 });
    const hosts = new Map();
    const persisted = api.storage.get('knownHosts', []);
    if (Array.isArray(persisted))
    {
        for (const entry of persisted)
        {
            if (validHost(entry?.hostId) && entry.hostId !== 'local' && Uuid.test(entry.threadId))
                hosts.set(entry.hostId, { hostId: entry.hostId, threadId: entry.threadId,
                    displayName: hostName(entry.displayName) });
        }
    }
    let stopped = false;
    const channels = [];
    const discovery = new Map();
    const owners = new Map();
    const BrowserWindow = dependencies.BrowserWindow
        || (!dependencies.ipcMain ? require('electron').BrowserWindow : null);

    function releaseOwner(owner)
    {
        if (owner.queries.size) return;
        for (const remove of owner.hooks) remove();
        owners.delete(owner.frame);
    }
    function abortOwner(owner)
    {
        for (const controller of owner.queries.values()) controller.abort();
    }
    function ownerFor(event)
    {
        let owner = owners.get(event.senderFrame);
        if (owner) return owner;
        owner = { frame: event.senderFrame, queries: new Map(), hooks: [] };
        const listen = (target, name, handler) =>
        {
            if (typeof target?.on !== 'function') return;
            target.on(name, handler);
            owner.hooks.push(() => target.removeListener(name, handler));
        };
        const cancel = () => abortOwner(owner);
        listen(event.sender, 'destroyed', cancel);
        listen(event.sender, 'render-process-gone', cancel);
        listen(event.sender, 'did-start-navigation', (_event, _url, _inPlace, main) =>
        {
            if (main !== false) cancel();
        });
        const window = BrowserWindow?.fromWebContents(event.sender);
        for (const name of ['hide', 'minimize', 'closed']) listen(window, name, cancel);
        owners.set(event.senderFrame, owner);
        return owner;
    }
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

    register('hosts', event =>
    {
        try
        {
            // 仅在页面请求机器列表时读取原生内存快照，不刷新连接或订阅后台变化。
            const services = dependencies.windowServices || globalThis.__codexpp_window_services__;
            const catalog = services?.getContextForWebContents?.(event.sender)?.remoteConnectionCatalog?.read?.();
            let changed = false;
            for (const group of [catalog?.ssh, catalog?.wsl, catalog?.remoteControl])
            {
                if (!Array.isArray(group)) continue;
                for (const connection of group)
                {
                    const entry = hosts.get(connection?.hostId);
                    const displayName = hostName(connection?.displayName);
                    if (!entry || !displayName || entry.displayName === displayName) continue;
                    entry.displayName = displayName;
                    changed = true;
                }
            }
            if (changed) api.storage.set('knownHosts', [...hosts.values()]);
        }
        catch { /* 原生目录不可用时保留上次名称；未识别过的连接使用 ID。 */ }
        return [{ hostId: 'local', label: `本机 · ${os.hostname()}` },
            ...[...hosts.values()].map(entry => ({ hostId: entry.hostId,
                label: `远程 · ${entry.displayName || entry.hostId}` }))];
    });
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
                hosts.set(bound.hostId, { ...hosts.get(bound.hostId), hostId: bound.hostId, threadId: bound.threadId });
                changed = true;
            }
            if (changed) api.storage.set('knownHosts', [...hosts.values()]);
        }).catch(() => {}).finally(() => discovery.delete(frame));
        discovery.set(frame, pending);
        return pending;
    });
    register('cancel', (event, payload) =>
    {
        if (!payload || !Uuid.test(payload.requestId)
            || Object.keys(payload).some(key => key !== 'requestId')) return;
        owners.get(event.senderFrame)?.queries.get(payload.requestId)?.abort();
    });
    register('report', async (event, payload) =>
    {
        if (!payload || !validHost(payload.hostId) || !Uuid.test(payload.requestId)
            || Object.keys(payload).some(key => key !== 'hostId' && key !== 'requestId'))
            return { status: 'unavailable', error: 'invalid-host' };
        const identity = payload.hostId === 'local' ? null : hosts.get(payload.hostId);
        if (payload.hostId !== 'local' && !identity)
            return { status: 'unavailable', error: 'open-remote-conversation' };
        const owner = ownerFor(event);
        if (owner.queries.has(payload.requestId)) return { status: 'unavailable', error: 'duplicate-query' };
        const controller = new AbortController();
        owner.queries.set(payload.requestId, controller);
        try
        {
            if (payload.hostId === 'local')
            {
                await service.ready;
                if (controller.signal.aborted) return { status: 'unavailable', error: 'cancelled' };
                return await service.query({ signal: controller.signal });
            }
            return await remote.get(identity, (method, params, limits) =>
                transport.request(event.senderFrame, identity.hostId, method, params, limits), {
                signal: controller.signal,
                watch: (target, options) => transport.watch(event.senderFrame, identity.hostId, target, options)
            });
        }
        catch (error)
        {
            return { status: 'unavailable', error: controller.signal.aborted || error.name === 'AbortError'
                ? 'cancelled' : 'query-failed' };
        }
        finally
        {
            owner.queries.delete(payload.requestId);
            releaseOwner(owner);
        }
    });
    api.log.info('Daily Usage main started; on-demand queries, idle filesystem listener, no background polling');
    return {
        async stop()
        {
            if (stopped) return;
            stopped = true;
            for (const channel of channels) ipcMain.removeHandler(channel);
            for (const owner of owners.values()) abortOwner(owner);
            await Promise.allSettled([demandServer.dispose(), service.dispose(), remote.dispose()]);
            transport.dispose();
            for (const owner of [...owners.values()])
            {
                owner.queries.clear();
                releaseOwner(owner);
            }
        }
    };
}

module.exports = { createMain };
