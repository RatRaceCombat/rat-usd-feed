import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKET, bookSource, poolSource, blend, readMarkets } from '../lib/sources.mjs';
import { decide, withinBand, RULES } from '../lib/decide.mjs';

const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const sqrtX96 = (ratPerHype) => BigInt(Math.round(Math.sqrt(ratPerHype) * 2 ** 48)) * 2n ** 48n;

test('venues: the book mid with its depth within 2%, the pool through HYPE/USDC, blended by depth', () => {
  const core = bookSource({ levels: [[{ px: '0.0099', sz: '1000' }, { px: '0.0090', sz: '9999' }], [{ px: '0.0101', sz: '500' }]] });
  assert.equal(core.price, 0.01);
  assert.ok(Math.abs(core.depthUsd - (9.9 + 5.05)) < 1e-9);
  assert.equal(bookSource({ levels: [[{ px: '0.02', sz: '1' }], [{ px: '0.01', sz: '1' }]] }), null, 'crossed');
  const amm = poolSource({ sqrtPriceX96: sqrtX96(20000), liquidity: 2e21 }, 80);
  assert.ok(Math.abs(amm.price - 0.004) < 1e-12);
  assert.equal(poolSource({ sqrtPriceX96: sqrtX96(20000), liquidity: 0 }, 80), null);
  assert.equal(blend([{ price: 1, depthUsd: 30 }, { price: 2, depthUsd: 10 }]), 1.25);
  assert.equal(blend([null, null]), null);
});

test('readMarkets: one pass over HyperCore and HyperEVM, the block time as the observation time', async () => {
  const fetcher = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (url === MARKET.rpc) {
      return { ok: true, json: async () => body.map((c) => ({
        id: c.id,
        result: c.method === 'eth_getBlockByNumber' ? { timestamp: '0x6b000000' } : c.params[0].data === '0x3850c7bd' ? hex(sqrtX96(80 / 0.0042)) + '0'.repeat(64 * 6) : hex(2e21),
      })) };
    }
    const reply = body.type === 'l2Book' ? { levels: [[{ px: '0.004298', sz: '1000' }], [{ px: '0.004311', sz: '1000' }]] } : { '@107': '80' };
    return { ok: true, json: async () => reply };
  };
  const m = await readMarkets({ fetcher });
  assert.equal(m.blockTime, 0x6b000000);
  assert.ok(m.price > 0.0042 && m.price < 0.0043);
  assert.equal(m.answer, BigInt(Math.round(m.price * 1e8)));
  assert.deepEqual(m.sources.map((s) => s.ok), [true, true]);

  const down = await readMarkets({ fetcher: async () => { throw new Error('offline'); } });
  assert.equal(down.answer, null);
  assert.equal(down.blockTime, null);
  assert.deepEqual(down.sources.map((s) => s.ok), [false, false]);
});

test('decide: the first round, a 1% move, the heartbeat two minutes early, never on noise', () => {
  const t = 1_800_000_000;
  assert.deepEqual(decide(null, 430000n, t), { push: true, why: 'first round' });
  assert.equal(decide(null, null, t).push, false);
  const last = { answer: 430000n, updatedAt: t };
  assert.equal(decide(last, 432000n, t + 30).push, false, '0.47%');
  assert.equal(decide(last, 434300n, t + 30).push, true, '1.00%');
  assert.equal(decide(last, 425700n, t + 30).push, true, 'down 1.00%');
  assert.equal(decide(last, 430000n, t + RULES.heartbeatSec - RULES.earlySec - 1).push, false);
  assert.match(decide(last, 430000n, t + RULES.heartbeatSec - RULES.earlySec).why, /heartbeat/);
});

test('withinBand: the contract guard, same integer maths', () => {
  const mid = 430450n;
  assert.equal(withinBand((mid * 11000n) / 10000n, mid, 1000), true);
  assert.equal(withinBand((mid * 11000n) / 10000n + 1n, mid, 1000), false);
  assert.equal(withinBand((mid * 9000n) / 10000n, mid, 1000), true);
  assert.equal(withinBand((mid * 9000n) / 10000n - 1n, mid, 1000), false);
});
