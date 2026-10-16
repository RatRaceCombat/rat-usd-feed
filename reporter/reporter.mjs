// The reporter: reads the two RAT markets every 30 s (lib/sources.mjs) and pushes a round to the
// RatUsdFeed contract on a 1% move or on the hourly heartbeat (lib/decide.mjs). Dry run by
// default: it reads everything, simulates the transaction and says what it would send.
//
//   npm run reporter                  # dry run, loops
//   npm run reporter -- once          # one pass, then exits
//   LIVE=1 npm run reporter           # sends the transactions
//
// .env next to package.json (git-ignored): FEED_ADDRESS (without it: markets only), REPORTER_PRIVATE_KEY
// (a key of its own with a little HYPE on HyperEVM for gas and nothing else: it can only push prices
// the contract accepts), HYPEREVM_RPC (the node for the markets and the feed), SAMPLE_SEC (30),
// MIN_GAS_HYPE (0.01). FEED_RPC and CHAIN_ID put the feed on another chain than the markets (a local
// test chain; the markets are always read on HyperEVM mainnet).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Contract, JsonRpcProvider, Wallet, formatEther, isAddress, parseEther } from 'ethers';
import { MARKET, DECIMALS, readMarkets } from './lib/sources.mjs';
import { RULES, decide, withinBand } from './lib/decide.mjs';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const LIVE = process.env.LIVE === '1';
const ONCE = process.argv.includes('once');
const SAMPLE_SEC = Number(process.env.SAMPLE_SEC || 30);
const MIN_GAS = parseEther(String(process.env.MIN_GAS_HYPE || '0.01'));
const MARKET_RPC = process.env.HYPEREVM_RPC || MARKET.rpc;
const FEED_RPC = process.env.FEED_RPC || MARKET_RPC;
const CHAIN_ID = Number(process.env.CHAIN_ID || MARKET.chainId);

export const FEED_ABI = [
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function coreMid() view returns (uint256)',
  'function maxDeviationBps() view returns (uint16)',
  'function isReporter(address) view returns (bool)',
  'function transmit(int256 answer, uint32 observedAt) returns (uint80)',
  'error NotReporter()',
  'error BadAnswer()',
  'error StaleObservation()',
  'error NoCorePrice()',
  'error OffMarket(int256 answer, uint256 coreMid)',
];

const log = (...a) => console.log(new Date().toISOString(), '[reporter]', ...a);
const usd = (answer) => `$${(Number(answer) / 10 ** DECIMALS).toFixed(8)}`;
// a revert's name (custom errors) or its message (require strings, revert.name 'Error'), else the error's text
const why = (e) => (e?.revert && e.revert.name !== 'Error' ? e.revert.name : e?.reason || e?.shortMessage || e?.message || String(e));

async function latestRound(feed) {
  try {
    const r = await feed.latestRoundData();
    return { roundId: r.roundId, answer: r.answer, updatedAt: Number(r.updatedAt) };
  } catch (e) {
    if (/No data present/.test(why(e))) return null;
    throw e;
  }
}

async function pass({ feed, wallet, provider, state }) {
  const m = await readMarkets({ rpc: MARKET_RPC });
  const venues = m.sources.map((s) => `${s.venue} ${s.ok ? `$${s.price.toFixed(8)} ($${s.depthUsd} deep)` : `down${s.error ? ` (${s.error})` : ''}`}`).join(', ');
  if (m.answer === null || !m.blockTime) return log(`no market read: ${venues}`);
  if (!feed) return log(`${usd(m.answer)} from ${venues} (no FEED_ADDRESS: markets only)`);

  const latest = await latestRound(feed);
  const d = decide(latest, m.answer, Math.floor(Date.now() / 1000));
  if (!d.push) {
    if (Date.now() - state.quietAt > 10 * 60_000) {
      state.quietAt = Date.now();
      log(`${usd(m.answer)}, nothing to push (${d.why})`);
    }
    return;
  }
  const [mid, band] = await Promise.all([feed.coreMid(), feed.maxDeviationBps()]);
  if (!withinBand(m.answer, mid, band)) {
    return log(`WARNING ${usd(m.answer)} is more than ${Number(band) / 100}% from the HyperCore mid ${usd(mid)}: not pushed (${venues})`);
  }
  const what = `round ${(latest?.roundId ?? 0n) + 1n} at ${usd(m.answer)} (${d.why}; ${venues})`;
  if (!LIVE) {
    if (!wallet) return log(`dry run, would push ${what}`);
    try {
      await feed.transmit.staticCall(m.answer, m.blockTime);
      return log(`dry run, would push ${what}: the simulation passes`);
    } catch (e) {
      return log(`dry run, would push ${what}: the simulation fails with ${why(e)}`);
    }
  }
  const balance = await provider.getBalance(wallet.address);
  if (balance < MIN_GAS) log(`WARNING the reporter holds ${formatEther(balance)} HYPE for gas: top it up`);
  const tx = await feed.transmit(m.answer, m.blockTime);
  log(`sent ${what}: ${tx.hash}`);
  const receipt = await tx.wait();
  log(`recorded in block ${receipt.blockNumber}, ${receipt.gasUsed} gas`);
}

async function main() {
  const provider = new JsonRpcProvider(FEED_RPC, CHAIN_ID, { staticNetwork: true });
  const key = process.env.REPORTER_PRIVATE_KEY;
  if (LIVE && !key) throw new Error('LIVE=1 needs REPORTER_PRIVATE_KEY in .env');
  const wallet = key ? new Wallet(key, provider) : null;
  const address = process.env.FEED_ADDRESS;
  if (LIVE && !isAddress(address || '')) throw new Error('LIVE=1 needs FEED_ADDRESS in .env');
  let feed = null;
  if (address) {
    if (!isAddress(address)) throw new Error(`FEED_ADDRESS ${address} is not an address`);
    feed = new Contract(address, FEED_ABI, wallet || provider);
    const [desc, dec] = await Promise.all([feed.description(), feed.decimals()]);
    if (desc !== 'RAT / USD' || Number(dec) !== DECIMALS) throw new Error(`${address} is not the RAT / USD feed (${desc}, ${dec} decimals)`);
    if (wallet && !(await feed.isReporter(wallet.address))) {
      if (LIVE) throw new Error(`${wallet.address} is not a reporter of the feed: the owner (the Safe) adds it with setReporter`);
      log(`note: ${wallet.address} is not a reporter of the feed yet`);
    }
  }
  log(`${LIVE ? 'LIVE' : 'dry run'}; feed ${address || '(none)'}; reporter ${wallet?.address || '(no key)'}; a round on a ${RULES.deviationBps / 100}% move or every ${RULES.heartbeatSec} s; reads every ${SAMPLE_SEC} s`);
  const state = { quietAt: 0 };
  for (;;) {
    try {
      await pass({ feed, wallet, provider, state });
    } catch (e) {
      log(`error: ${why(e)}`);
      if (ONCE) process.exitCode = 1;
    }
    if (ONCE) break;
    await new Promise((r) => setTimeout(r, SAMPLE_SEC * 1000));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    log(`stopped: ${why(e)}`);
    process.exit(1);
  });
}
