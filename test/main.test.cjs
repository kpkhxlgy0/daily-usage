'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMain } = require('../src/main.cjs');
const QueryA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const QueryB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function harness(t, service, remote, options = {})
{
    const handlers = new Map();
    const registry = new Map([['knownHosts', options.knownHosts || []]]);
    const sender = new EventEmitter();
    const frame = { executeJavaScript: async () => [{ bound: { hostId: 'rc:test',
        threadId: '11111111-1111-4111-8111-111111111111' } }] };
    sender.mainFrame = frame;
    const event = { senderFrame: frame, sender };
    const main = createMain({ manifest: { id: 'com.kpk.daily-usage' }, fs: { dataDir: 'unused' },
        log: { info() {}, error() {} }, storage: { get: k => registry.get(k), set: (k,v) => registry.set(k,v) } }, {
        ipcMain: { handle: (k,v) => handlers.set(k,v), removeHandler: k => handlers.delete(k) },
        serviceFactory: () => ({ ready: Promise.resolve(), dispose: async () => {}, ...service }),
        demandFactory: () => ({ ready: Promise.resolve(), dispose: async () => {} }),
        remoteFactory: () => ({ get: async () => ({ status: 'ok' }), dispose: async () => {}, ...remote }),
        transportFactory: () => ({ request() {}, watch() {}, dispose() {} }), bindingScript: 'binding-test',
        windowServices: options.windowServices
    });
    t.after(() => main.stop());
    const call = (method,arg,from=event) => handlers.get('codexpp:com.kpk.daily-usage:'+method)(from,arg);
    return { call,main,sender,event,handlers,registry,frame };
}

function pendingQueries()
{
    const calls = [];
    return { calls, query({signal})
    {
        return new Promise((resolve,reject) =>
        {
            const entry = {signal,resolve}; calls.push(entry);
            const abort = () => reject(Object.assign(new Error('cancelled'), {name:'AbortError'}));
            signal.addEventListener('abort',abort,{once:true});
            if(signal.aborted)abort();
        });
    } };
}

test('main starts no report scan and only accepted visible-page requests invoke query', async t =>
{
    const service=pendingQueries();
    const h=harness(t,service);
    assert.equal(service.calls.length,0);
    assert.equal((await h.call('report',{hostId:'local',path:'secret',requestId:QueryA})).status,'unavailable');
    const promise=h.call('report',{hostId:'local',requestId:QueryA});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(service.calls.length,1);
    service.calls[0].resolve({status:'ok',snapshot:{revision:1}});
    assert.equal((await promise).snapshot.revision,1);
    await assert.rejects(async()=>h.call('hosts',null,{...h.event,senderFrame:{}}),/frame/);
});

test('cancel is owner-scoped and navigation cancels remaining queries', async t =>
{
    const service=pendingQueries();
    const h=harness(t,service);
    const one=h.call('report',{hostId:'local',requestId:QueryA});
    const two=h.call('report',{hostId:'local',requestId:QueryB});
    await new Promise(resolve=>setImmediate(resolve));
    const otherFrame={};
    await h.call('cancel',{requestId:QueryA},{senderFrame:otherFrame,sender:{mainFrame:otherFrame}});
    assert.equal(service.calls[0].signal.aborted,false);
    await h.call('cancel',{requestId:QueryA});
    assert.equal(service.calls[0].signal.aborted,true);
    assert.equal(service.calls[1].signal.aborted,false);
    assert.equal((await one).error,'cancelled');
    h.sender.emit('did-start-navigation',{},'next',false,true);
    assert.equal(service.calls[1].signal.aborted,true);
    assert.equal((await two).error,'cancelled');
    await h.main.stop();
    assert.equal(h.handlers.size,0);
});

test('remote demand receives native watcher and page cancellation signal', async t =>
{
    let received;
    const h=harness(t,{query:async()=>({status:'ok'})},{get:async(identity,rpc,options)=>
    {
        received={identity,rpc,options};
        return {status:'ok'};
    }});
    assert.equal((await h.call('report',{hostId:'rc:test',requestId:QueryA})).status,'unavailable');
    await h.call('discover');
    assert.equal((await h.call('report',{hostId:'rc:test',requestId:QueryB})).status,'ok');
    assert.equal(received.identity.hostId,'rc:test');
    assert.equal(typeof received.options.watch,'function');
    assert.equal(received.options.signal.aborted,false);
});

test('host list reads native display names on demand and preserves routing when renamed', async t =>
{
    let reads = 0;
    let displayName = '办公室电脑';
    let routed;
    const h = harness(t, {}, { get: async identity => { routed = identity; return { status: 'ok' }; } }, {
        windowServices: { getContextForWebContents(sender)
        {
            assert.equal(sender, h.sender);
            return { remoteConnectionCatalog: { read()
            {
                reads++;
                return { ssh: [{ hostId: 'another-host', displayName: '其他机器' }],
                    remoteControl: [{ hostId: 'rc:test', displayName }] };
            } } };
        } }
    });
    await h.call('discover');
    assert.equal(reads, 0);
    assert.deepEqual((await h.call('hosts'))[1], { hostId: 'rc:test', label: '远程 · 办公室电脑' });
    displayName = '  工作电脑  ';
    assert.equal((await h.call('hosts'))[1].label, '远程 · 工作电脑');
    assert.equal(h.registry.get('knownHosts')[0].displayName, '工作电脑');
    await h.call('report', { hostId: 'rc:test', requestId: QueryA });
    assert.equal(routed.hostId, 'rc:test');
    assert.equal(reads, 2);
});

test('host names survive rediscovery and unavailable catalogs, with IDs for unknown names', async t =>
{
    const h = harness(t, {}, {}, { knownHosts: [
        { hostId: 'rc:test', threadId: '11111111-1111-4111-8111-111111111111', displayName: '已知电脑' },
        { hostId: 'rc:unnamed', threadId: '22222222-2222-4222-8222-222222222222', displayName: '\u0000bad' }
    ], windowServices: { getContextForWebContents() { throw new Error('unavailable'); } } });
    h.frame.executeJavaScript = async () => [{ bound: { hostId: 'rc:test',
        threadId: '33333333-3333-4333-8333-333333333333' } }];
    await h.call('discover');
    assert.deepEqual((await h.call('hosts')).slice(1), [
        { hostId: 'rc:test', label: '远程 · 已知电脑' },
        { hostId: 'rc:unnamed', label: '远程 · rc:unnamed' }
    ]);
    assert.equal(h.registry.get('knownHosts')[0].threadId, '33333333-3333-4333-8333-333333333333');
});

test('leaving before initialization completes does not start a late scan', async t =>
{
    let ready;
    let queried = false;
    const h = harness(t, { ready: new Promise(resolve => { ready = resolve; }),
        query: async () => { queried = true; return { status: 'ok' }; } });
    const pending = h.call('report', { hostId: 'local', requestId: QueryA });
    await h.call('cancel', { requestId: QueryA });
    ready();
    assert.equal((await pending).error, 'cancelled');
    assert.equal(queried, false);
});
