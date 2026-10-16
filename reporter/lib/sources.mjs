// The RAT price, read from the two markets where RAT trades, straight from the chain's own APIs:
//   - HyperCore spot @157 (RAT/USDC): the order book mid, weighted by its USD depth within ±2%;
//   - the HyperSwap V3 RAT/WHYPE 0.3% pool on HyperEVM: slot0 times the HyperCore HYPE/USDC mid
//     (@107), weighted by what its in-range liquidity offers within ±2%.
// The price is the depth-weighted mean of the two, USDC taken as 1 USD. The same maths serves the
// game's public API (play.ratracecombat.com/api/feed/rat-usd), so both always tell the same price.

export const MARKET = Object.freeze({
  chainId: 999,
  rpc: 'https://rpc.hyperliquid.xyz/evm',
  info: 'https://api.hyperliquid.xyz/info',
  corePair: '@157', // HyperCore spot RAT/USDC
  coreSpotIndex: 157,
  corePxDecimals: 6, // 8 - szDecimals of RAT (2): the precompile's price unit
  hypePair: '@107', // HyperCore spot HYPE/USDC
  rat: '0xfdc42f844f3aa19f8fc0b2d67d3276cf1efdc4ca', // HyperEVM ERC-20 linked to RAT, 18 decimals
  pool: '0xd892fe85fa9ed0f20d5466e8dccc2e1d871d9404', // HyperSwap V3 RAT/WHYPE 0.3%: token0 WHYPE, token1 RAT
});

export const DECIMALS = 8;

export async function info(body, fetcher = globalThis.fetch) {
  const res = await fetcher(MARKET.info, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`info ${body.type}: HTTP ${res.status}`);
  return res.json();
}

/** One JSON-RPC batch on HyperEVM: [[method, params]] -> results in order (throws on any error). */
export async function rpcBatch(calls, { fetcher = globalThis.fetch, rpc = MARKET.rpc } = {}) {
  const body = calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }));
  const res = await fetcher(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HyperEVM RPC: HTTP ${res.status}`);
  const out = await res.json();
  const byId = new Map((Array.isArray(out) ? out : [out]).map((r) => [r.id, r]));
  return calls.map(([method], id) => {
    const r = byId.get(id);
    if (!r || r.error || r.result === undefined || r.result === null) throw new Error(`${method}: ${r?.error?.message || 'no result'}`);
    return r.result;
  });
}

/** Mid and USD depth within ±pct of a HyperCore l2Book; null when a side is empty or the book is crossed. */
export function bookSource(book, pct = 0.02) {
  const [bids = [], asks = []] = book?.levels || [];
  const bid = Number(bids[0]?.px);
  const ask = Number(asks[0]?.px);
  if (!(bid > 0) || !(ask > bid) || !Number.isFinite(ask)) return null;
  const mid = (bid + ask) / 2;
  const depth = (levels, near) => levels.reduce((sum, l) => {
    const px = Number(l.px);
    const sz = Number(l.sz);
    return near(px) && sz > 0 && Number.isFinite(px * sz) ? sum + px * sz : sum;
  }, 0);
  const depthUsd = depth(bids, (px) => px >= mid * (1 - pct)) + depth(asks, (px) => px <= mid * (1 + pct));
  return { price: mid, depthUsd, bid, ask };
}

/**
 * RAT in USD and the USD depth within ±pct of the RAT/WHYPE pool, from slot0's sqrtPriceX96 and the
 * in-range liquidity (both tokens have 18 decimals, so raw units cancel out). Null when it is empty.
 */
export function poolSource({ sqrtPriceX96, liquidity }, hypeUsd, pct = 0.02) {
  const s = Number(sqrtPriceX96) / 2 ** 96; // sqrt(RAT per WHYPE)
  const L = Number(liquidity);
  if (!(s > 0) || !(L > 0) || !(hypeUsd > 0) || !Number.isFinite(s * L * hypeUsd)) return null;
  // WHYPE paid in to lift RAT by pct, plus WHYPE taken out to drop it by pct (constant L in range)
  const whype = ((L / s) * (Math.sqrt(1 + pct) - 1 + (1 - Math.sqrt(1 - pct)))) / 1e18;
  return { price: hypeUsd / (s * s), depthUsd: whype * hypeUsd, hypeUsd };
}

/** Depth-weighted mean of the sources' prices (a plain mean when none reports depth). */
export function blend(sources) {
  const ok = sources.filter((s) => s && s.price > 0 && Number.isFinite(s.price));
  if (!ok.length) return null;
  const w = ok.reduce((sum, s) => sum + Math.max(0, s.depthUsd || 0), 0);
  if (!(w > 0)) return ok.reduce((sum, s) => sum + s.price, 0) / ok.length;
  return ok.reduce((sum, s) => sum + s.price * Math.max(0, s.depthUsd || 0), 0) / w;
}

const word = (hex, i) => BigInt('0x' + (String(hex).slice(2 + 64 * i, 2 + 64 * (i + 1)) || '0'));

/**
 * Reads both markets once. Returns { price, answer (bigint, 8 decimals) or null, blockTime (the
 * latest HyperEVM block's timestamp, the observation time pushed on chain), sources }.
 */
export async function readMarkets({ fetcher = globalThis.fetch, rpc = MARKET.rpc } = {}) {
  const [book, mids, evm] = await Promise.allSettled([
    info({ type: 'l2Book', coin: MARKET.corePair }, fetcher),
    info({ type: 'allMids' }, fetcher),
    rpcBatch([
      ['eth_call', [{ to: MARKET.pool, data: '0x3850c7bd' }, 'latest']], // slot0()
      ['eth_call', [{ to: MARKET.pool, data: '0x1a686502' }, 'latest']], // liquidity()
      ['eth_getBlockByNumber', ['latest', false]],
    ], { fetcher, rpc }),
  ]);
  const core = book.status === 'fulfilled' ? bookSource(book.value) : null;
  const hypeUsd = mids.status === 'fulfilled' ? Number(mids.value?.[MARKET.hypePair]) : NaN;
  const amm = evm.status === 'fulfilled' ? poolSource({ sqrtPriceX96: word(evm.value[0], 0), liquidity: word(evm.value[1], 0) }, hypeUsd) : null;
  const blockTime = evm.status === 'fulfilled' ? Number(BigInt(evm.value[2].timestamp)) : null;
  const price = blend([core, amm]);
  const answer = price && Math.round(price * 10 ** DECIMALS) >= 1 ? BigInt(Math.round(price * 10 ** DECIMALS)) : null;
  const view = (s) => (s ? { ok: true, price: s.price, depthUsd: Math.round(s.depthUsd * 100) / 100 } : { ok: false });
  return {
    price,
    answer,
    blockTime,
    sources: [
      { venue: 'HyperCore', market: `RAT/USDC spot ${MARKET.corePair}`, ...view(core), ...(book.status === 'rejected' ? { error: book.reason.message } : {}) },
      { venue: 'HyperSwap V3', market: 'RAT/WHYPE 0.3% x HYPE/USDC', ...view(amm), ...(evm.status === 'rejected' ? { error: evm.reason.message } : {}) },
    ],
  };
}
