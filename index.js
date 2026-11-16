'use strict';

let controller;
let epoch = 0;
const DrainKey = Symbol.for('com.kpk.daily-usage.drain');

module.exports = {
    start(api)
    {
        module.exports.stop();
        const generation = ++epoch;
        if (api.process === 'renderer')
        {
            controller = require('./src/renderer.cjs').startRenderer(api);
            return;
        }
        if (api.process === 'main')
        {
            const preceding = globalThis[DrainKey] || Promise.resolve();
            globalThis[DrainKey] = preceding.then(() =>
            {
                if (generation === epoch) controller = require('./src/main.cjs').createMain(api);
            }).catch(error => api.log.error('Daily Usage startup failed', error.message));
        }
    },
    stop()
    {
        epoch++;
        if (!controller) return;
        const previous = controller;
        controller = null;
        const stopped = Promise.resolve(previous.stop());
        globalThis[DrainKey] = Promise.allSettled([globalThis[DrainKey], stopped]);
    }
};
