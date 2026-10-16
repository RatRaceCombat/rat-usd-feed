// A full rehearsal on a local chain, before mainnet: puts a stand-in of HyperCore's precompile
// holding the live RAT bid and ask at its address, deploys a RatUsdFeed with Hardhat's account #1
// as reporter, and prints how to run the real reporter against it.
//
//   npx hardhat node                                   # terminal 1
//   npx hardhat run scripts/rehearse-local.cjs --network localhost
//   FEED_RPC=http://127.0.0.1:8545 CHAIN_ID=31337 FEED_ADDRESS=<printed> LIVE=1 \
//     REPORTER_PRIVATE_KEY=<Hardhat account #1, printed by `npx hardhat node`> npm run reporter -- once
const { ethers, network } = require('hardhat');

const BBO = '0x000000000000000000000000000000000000080e';
const ASSET = 10157;

async function main() {
  if (network.name !== 'localhost' && network.name !== 'hardhat') throw new Error('local chains only');
  const [owner, reporter] = await ethers.getSigners();
  const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'l2Book', coin: '@157' }) });
  const book = await r.json();
  const toPx = (s) => BigInt(Math.round(Number(s) * 1e6)); // RAT's HyperCore prices have 6 decimals
  const bid = toPx(book.levels[0][0].px);
  const ask = toPx(book.levels[1][0].px);

  const mock = await (await ethers.getContractFactory('MockBbo')).deploy();
  await network.provider.send('hardhat_setCode', [BBO, await ethers.provider.getCode(await mock.getAddress())]);
  await (await ethers.getContractAt('MockBbo', BBO)).set(ASSET, bid, ask);

  const feed = await (await ethers.getContractFactory('RatUsdFeed')).deploy(owner.address, [reporter.address], ASSET, 6, 1000, 300);
  await feed.waitForDeployment();
  console.log(`HyperCore stand-in: bid ${bid}, ask ${ask} (live book, 6 decimals); coreMid() = ${await feed.coreMid()}`);
  console.log(`FEED_ADDRESS=${await feed.getAddress()} (owner ${owner.address}, reporter ${reporter.address})`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
