# RAT / USD price feed

An on-chain RAT / USD price feed on HyperEVM, compatible with Chainlink: `RatUsdFeed` implements
Chainlink's `AggregatorV2V3Interface`, so any contract, indexer or tool written for a Chainlink feed
reads it unchanged.

RAT is the token of [Rat Race Combat](https://ratracecombat.com), a HIP-1 spot token on Hyperliquid
(HyperCore token index 253) linked to the HyperEVM ERC-20
[`0xFdC42f844f3aa19F8Fc0b2d67d3276cf1eFdC4CA`](https://hyperevmscan.io/token/0xFdC42f844f3aa19F8Fc0b2d67d3276cf1eFdC4CA).

| | |
|---|---|
| Network | HyperEVM mainnet (chain id 999) |
| Feed | not deployed yet (`deployments/hyperevm.json` once it is) |
| Pair | RAT / USD, 8 decimals |
| Deviation threshold | 1% |
| Heartbeat | 3,600 s |
| Guard | an answer must sit within 10% of the HyperCore RAT/USDC mid of the same block |
| Owner | the team's Safe `0xA86c36f0031142BAafc173df2B91640F0F4f97e6` |

The same price, with the same method, is also served as JSON by the game's API:
`https://play.ratracecombat.com/api/feed/rat-usd`.

## Read it

```solidity
import {AggregatorV3Interface} from "./interfaces/AggregatorV2V3Interface.sol";

AggregatorV3Interface feed = AggregatorV3Interface(FEED_ADDRESS);
(, int256 answer, , uint256 updatedAt, ) = feed.latestRoundData();
require(block.timestamp - updatedAt <= 3600 + 300, "RAT / USD is stale");
uint256 ratUsd = uint256(answer); // 8 decimals: 428372 = $0.00428372
```

```js
import { Contract, JsonRpcProvider } from 'ethers';
const feed = new Contract(FEED_ADDRESS, ['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'],
  new JsonRpcProvider('https://rpc.hyperliquid.xyz/evm'));
const [roundId, answer, startedAt, updatedAt] = await feed.latestRoundData();
console.log(Number(answer) / 1e8); // USD per RAT
```

As with Chainlink, check `updatedAt` yourself. `latestRoundData()` and `getRoundData()` revert with
`No data present` before the first round or for an unknown round; the v2 getters (`latestAnswer()`,
`getAnswer()`, ...) return 0 instead.

## How the price is made

A reporter (`reporter/`) reads the two markets where RAT trades, every 30 s, from the chain's own APIs:

1. **HyperCore spot `@157` (RAT/USDC)**: the order book mid, weighted by the USD depth of the book
   within ±2% of it.
2. **HyperSwap V3 RAT/WHYPE 0.3%** ([`0xD892FE85fa9ED0f20d5466e8dCcC2e1D871d9404`](https://hyperevmscan.io/address/0xD892FE85fa9ED0f20d5466e8dCcC2e1D871d9404)):
   `slot0()` times the HyperCore HYPE/USDC mid (`@107`), weighted by the USD its in-range liquidity
   takes to move RAT 2% up plus 2% down.

The answer is the depth-weighted mean of the two, USDC taken as 1 USD. A venue that cannot be read
(a one-sided or crossed book, an empty pool, no HYPE price) is left out; with neither, nothing is pushed.

A round is pushed, like Chainlink's push feeds, when the answer moves 1% or more from the last round,
or two minutes before the 3,600 s heartbeat runs out. Each round stores the answer, `startedAt` (the
HyperEVM block time when the markets were read) and `updatedAt` (the block that recorded it).
`roundId` starts at 1 and `answeredInRound == roundId`.

## Trust model

- **The contract guards every round.** `transmit` reads HyperCore's best bid and offer for RAT/USDC
  through the precompile `0x...080e`, inside the same transaction, and refuses (`OffMarket`) an answer
  more than `maxDeviationBps` (10%) away from that mid. The HyperCore book is HyperCore state: an EVM
  transaction cannot move it, so no flash loan can either. It also refuses an observation from the
  future, one older than `maxObservationAge` (300 s), and one not newer than the last round's
  (`StaleObservation`), so an old price cannot be replayed.
- **A reporter** is a hot key with a little HYPE for gas. The worst a stolen reporter key can do is
  push prices inside the 10% band around the live HyperCore mid, or stop pushing (the feed then goes
  stale, which `updatedAt` shows). The owner removes it with `setReporter(key, false)`.
- **The owner** is the team's Safe (2 signatures). It can only name reporters and set the band between
  1% and 30%. Ownership moves in two steps and cannot be renounced. No upgrade, no pause, no fee; the
  contract holds no token.
- **Limits, plainly.** RAT is a thin market (about $50 of depth within 2% on both venues together on
  2026-10-12): a few dozen dollars move it, and the feed follows the market. It is a spot feed, not a
  TWAP. Use it to display or account for RAT; do not use it as the only oracle securing collateral.
  One reporter means one point of liveness: run a second one on another machine with its own key for
  redundancy (the contract accepts any number of reporters).

## Contract reference

`contracts/RatUsdFeed.sol` (Solidity 0.8.24, OpenZeppelin `Ownable2Step`).

| Function | |
|---|---|
| `decimals()`, `description()`, `version()` | `8`, `"RAT / USD"`, `1` |
| `latestRoundData()`, `getRoundData(uint80)` | Chainlink v3 |
| `latestAnswer()`, `latestTimestamp()`, `latestRound()`, `getAnswer(uint256)`, `getTimestamp(uint256)` | Chainlink v2 |
| `coreMid()` | the HyperCore RAT/USDC mid of this block, 8 decimals (the guard's reference) |
| `transmit(int256 answer, uint32 observedAt)` | reporters only: records a round |
| `setReporter(address, bool)`, `setMaxDeviationBps(uint16)` | owner only |
| `isReporter(address)`, `maxDeviationBps()`, `coreAsset()`, `corePxDecimals()`, `maxObservationAge()` | settings |

Events: `NewRound(roundId, startedBy, startedAt)` and `AnswerUpdated(current, roundId, updatedAt)`
(Chainlink's), `ReporterSet`, `MaxDeviationSet`. Errors: `NotReporter`, `BadAnswer`, `StaleObservation`,
`NoCorePrice`, `OffMarket(answer, coreMid)`, `BadConfig`, `RenounceDisabled`.

Constructor: `(owner, reporters[], coreAsset = 10157, corePxDecimals = 6, maxDeviationBps = 1000,
maxObservationAge = 300)`. `coreAsset` is 10000 + the spot index for the precompile;
`corePxDecimals` is 8 minus RAT's `szDecimals` (2). The deploy script reads both from HyperCore.

## Run it

```sh
npm install
npm test               # the contract (Hardhat, a stand-in for the precompile) and the reporter
npm run check:live     # the real contract against the real HyperCore precompile, by eth_call: no deploy, no gas
```

`check:live` runs `contracts/test/LiveCheck.sol`'s constructor in an `eth_call` on mainnet: it builds a
throwaway feed, reads the precompile, records a round and checks that twice the market is refused.
It must end with `errors: none`.

Rehearsal on a local chain (the precompile stand-in holds the live RAT book):

```sh
npx hardhat node                                               # terminal 1
npx hardhat run scripts/rehearse-local.cjs --network localhost # prints FEED_ADDRESS
FEED_RPC=http://127.0.0.1:8545 CHAIN_ID=31337 FEED_ADDRESS=... LIVE=1 REPORTER_PRIVATE_KEY=<Hardhat account #1> npm run reporter -- once
```

### Deploy (mainnet)

1. Copy `.env.example` to `.env`. Fill `FEED_OWNER` (the Safe), `REPORTERS` and `DEPLOYER_PRIVATE_KEY`.
2. `npm run deploy:mainnet`: a dry run. It checks that the owner is a Safe with at least 2 signers,
   that no reporter is a Safe signer, that spot pair 157 is still RAT/USDC and its book is two-sided,
   and prints the constructor arguments and the gas (about 1.13M gas, about 0.0002 HYPE).
3. `LIVE=1 npm run deploy:mainnet`: deploys and writes `deployments/hyperevm.json`. The deployer gets
   no power.
4. `npm run verify:mainnet` with `ETHERSCAN_API_KEY`: source on hyperevmscan.io and Sourcify.

### Reporter

```sh
npm run reporter               # dry run: reads, decides, simulates, sends nothing
LIVE=1 npm run reporter        # pushes rounds
```

`.env`: `FEED_ADDRESS`, `REPORTER_PRIVATE_KEY`. A round costs about 68,000 gas (about 0.000007 HYPE
at 0.1 gwei): 0.05 HYPE lasts thousands of rounds. The reporter warns under `MIN_GAS_HYPE` (0.01), and
refuses to push a price outside the contract's band (it logs a warning instead).

## Layout

```
contracts/RatUsdFeed.sol                      the feed
contracts/interfaces/AggregatorV2V3Interface.sol  Chainlink's interfaces
contracts/test/MockBbo.sol, LiveCheck.sol     a precompile stand-in for tests; the live eth_call check
test/RatUsdFeed.test.cjs                      contract tests
reporter/reporter.mjs                         the reporter (dry run by default)
reporter/lib/sources.mjs, decide.mjs          the market maths; when to push
reporter/test/                                reporter tests (node --test)
scripts/deploy.cjs, verify.cjs                mainnet deployment and source verification
scripts/check-live.mjs, rehearse-local.cjs    the live check; the local rehearsal
```
