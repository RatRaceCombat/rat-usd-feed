// Proves the feed contract on the real HyperEVM without deploying anything: an eth_call runs the
// constructor of contracts/test/LiveCheck.sol, which builds a throwaway RatUsdFeed, reads the real
// HyperCore precompile, records a round and checks that twice the market is refused. Compares the
// contract's HyperCore mid with Hyperliquid's API. No key, no gas.
//
//   npm run check:live            # mainnet (HYPEREVM_RPC to change the node)
import fs from 'node:fs';
import { AbiCoder, JsonRpcProvider } from 'ethers';
import { MARKET, info } from '../reporter/lib/sources.mjs';

const rpc = process.env.HYPEREVM_RPC || MARKET.rpc;
const artifact = JSON.parse(fs.readFileSync(new URL('../artifacts/contracts/test/LiveCheck.sol/LiveCheck.json', import.meta.url), 'utf8'));
const coder = AbiCoder.defaultAbiCoder();

const errors = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) errors.push(what);
};

// the pair and its price decimals, read from HyperCore (never from memory alone)
const meta = await info({ type: 'spotMeta' });
const pair = meta.universe.find((u) => u.index === MARKET.coreSpotIndex);
const rat = meta.tokens[pair?.tokens?.[0]];
check(pair?.name === MARKET.corePair && rat?.name === 'RAT' && pair.tokens[1] === 0, `spot pair ${MARKET.corePair} is RAT/USDC`);
const pxDecimals = 8 - rat.szDecimals;
check(pxDecimals === MARKET.corePxDecimals, `HyperCore price decimals ${pxDecimals} (8 - szDecimals ${rat.szDecimals})`);

const provider = new JsonRpcProvider(rpc, MARKET.chainId, { staticNetwork: true });
const data = artifact.bytecode + coder.encode(['uint32', 'uint8'], [10000 + MARKET.coreSpotIndex, pxDecimals]).slice(2);
const [out, book] = await Promise.all([provider.call({ data }), info({ type: 'l2Book', coin: MARKET.corePair })]);
const [mid, roundId, answer, startedAt, updatedAt, offMarket, block] = coder.decode(['uint256', 'uint80', 'int256', 'uint256', 'uint256', 'bool', 'uint256'], out);

const apiMid = (Number(book.levels[0][0].px) + Number(book.levels[1][0].px)) / 2;
const contractMid = Number(mid) / 1e8;
console.log(`HyperEVM block ${block}: contract mid $${contractMid}, API mid $${apiMid}`);
check(contractMid > 0, 'the bbo precompile answers inside a contract');
check(Math.abs(contractMid - apiMid) / apiMid < 0.02, 'the contract mid matches the order book (within 2%, the book moves)');
check(roundId === 1n && answer === mid && startedAt === updatedAt && updatedAt > 0n, 'transmit recorded round 1 and latestRoundData returns it');
check(offMarket, 'twice the market is refused with OffMarket');

console.log(errors.length ? `errors: ${errors.length}` : 'errors: none');
process.exitCode = errors.length ? 1 : 0;
