'use strict';

const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');

const ChunkBytes = 64 * 1024;

function sameOrGrowing(before, after)
{
    return before.dev === after.dev && before.ino === after.ino && before.birthtimeMs === after.birthtimeMs
        && (after.size > before.size || after.size === before.size
            && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs);
}

async function scanPlainRollout(filename, onChunk, checkActive)
{
    const changed = () => Object.assign(new Error('Plain rollout changed while reading'), { code: 'ERR_ROLLOUT_CHANGED' });
    const input = await fs.open(filename, 'r');
    try
    {
        const stat = await input.stat();
        if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) throw changed();
        let latest = stat;
        async function checkPath()
        {
            const handleStat = await input.stat();
            const pathStat = await fs.stat(filename);
            if (!sameOrGrowing(latest, handleStat) || !sameOrGrowing(handleStat, pathStat)) throw changed();
            latest = pathStat;
            checkActive();
        }
        async function readPrefix(consume)
        {
            const hash = createHash('sha256');
            let position = 0;
            while (position < stat.size)
            {
                const buffer = Buffer.allocUnsafeSlow(Math.min(ChunkBytes, stat.size - position));
                const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
                checkActive();
                if (!bytesRead) throw changed();
                const chunk = buffer.subarray(0, bytesRead);
                hash.update(chunk);
                if (consume) consume(chunk);
                position += bytesRead;
            }
            return hash.digest('hex');
        }

        await checkPath();
        const original = await readPrefix(onChunk);
        await checkPath();
        const prefix = latest.size > stat.size;
        // 文件变长不一定是追加；重新校验已读取的固定字节范围。
        if (prefix)
        {
            if (original !== await readPrefix()) throw changed();
            await checkPath();
        }
        return { stat, prefix };
    }
    finally
    {
        await input.close();
    }
}

module.exports = { scanPlainRollout };
