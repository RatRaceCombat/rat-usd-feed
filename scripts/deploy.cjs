// Deploys RatUsdFeed on HyperEVM. Dry run by default: every check, the constructor arguments and the
// gas estimate, nothing sent. LIVE=1 deploys and writes deployments/<network>.json.
//
//   npm run deploy:mainnet               # dry run
//   LIVE=1 npm run deploy:mainnet        # deploys (DEPLOYER_PRIVATE_KEY pays the gas, gets no power)
//
// .env: FEED_OWNER (the team's Safe: it alone names reporters and sets the band), REPORTERS (the
// reporter addresses, comma separated), MAX_DEVIATION_BPS (1000 = 10%), MAX_OBSERVATION_AGE (300 s).
// The owner must be a Safe with at least 2 signers (the project's rule for anything that controls
// value); ALLOW_OWNER_THRESHOLD_1=1 accepts a 1-of-1 Safe while the second signer is not added yet.
const fs = require('fs');
const path = require('path');
const { ethers, network } = require('hardhat');

const INFO = 'https://api.hyperliquid.xyz/info';
const BBO = '0x000000000000000000000000000000000000080e';
const SPOT_INDEX = 157; // RAT/USDC on HyperCore

const info = async (body) => {
  const r = await fetch(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`info ${body.type}: HTTP ${r.status}`);
  return r.json();
};

async function main() {
  const live = process.env.LIVE === '1';
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 999n) throw new Error(`HyperEVM mainnet only (chain ${chainId}): the guard reads RAT's HyperCore book`);

  const owner = ethers.getAddress(process.env.FEED_OWNER || '');
  const reporters = (process.env.REPORTERS || '').split(',').map((a) => a.trim()).filter(Boolean).map((a) => ethers.getAddress(a));
  const band = Number(process.env.MAX_DEVIATION_BPS || 1000);
  const maxAge = Number(process.env.MAX_OBSERVATION_AGE || 300);
  if (!reporters.length) throw new Error('REPORTERS: at least one reporter address');
  if (reporters.includes(owner)) throw new Error('a reporter must not be the owner: the reporter key is a hot key');

  // the owner is a Safe, with two signatures (wallets rule)
  if ((await ethers.provider.getCode(owner)) === '0x') throw new Error(`FEED_OWNER ${owner} has no code: it must be the team's Safe`);
  const safe = new ethers.Contract(owner, ['function getThreshold() view returns (uint256)', 'function getOwners() view returns (address[])'], ethers.provider);
  const [threshold, signers] = await Promise.all([safe.getThreshold(), safe.getOwners()]);
  console.log(`owner: Safe ${owner}, ${threshold} of ${signers.length} (${signers.join(', ')})`);
  if (threshold < 2n && process.env.ALLOW_OWNER_THRESHOLD_1 !== '1') {
    throw new Error('the Safe asks one signature only: add the second signer with threshold 2 first (or ALLOW_OWNER_THRESHOLD_1=1)');
  }
  for (const r of reporters) {
    if (signers.map((s) => s.toLowerCase()).includes(r.toLowerCase())) throw new Error(`reporter ${r} is a Safe signer: give the reporter a key of its own`);
  }

  // the pair and its price decimals, from HyperCore itself
  const meta = await info({ type: 'spotMeta' });
  const pair = meta.universe.find((u) => u.index === SPOT_INDEX);
  const rat = meta.tokens[pair?.tokens?.[0]];
  if (pair?.name !== '@157' || rat?.name !== 'RAT' || pair.tokens[1] !== 0) throw new Error('spot pair 157 is not RAT/USDC any more: check before deploying');
  const coreAsset = 10000 + SPOT_INDEX;
  const corePxDecimals = 8 - rat.szDecimals;
  const out = await ethers.provider.call({ to: BBO, data: ethers.AbiCoder.defaultAbiCoder().encode(['uint32'], [coreAsset]) });
  const [bid, ask] = ethers.AbiCoder.defaultAbiCoder().decode(['uint64', 'uint64'], out);
  if (!(bid > 0n && ask >= bid)) throw new Error(`the HyperCore RAT book is not two-sided (bid ${bid}, ask ${ask})`);
  console.log(`HyperCore RAT/USDC: bid ${Number(bid) / 10 ** corePxDecimals}, ask ${Number(ask) / 10 ** corePxDecimals} (asset ${coreAsset}, ${corePxDecimals} decimals)`);

  const args = [owner, reporters, coreAsset, corePxDecimals, band, maxAge];
  console.log('constructor:', JSON.stringify({ owner, reporters, coreAsset, corePxDecimals, maxDeviationBps: band, maxObservationAge: maxAge }));
  const Feed = await ethers.getContractFactory('RatUsdFeed');
  const tx = await Feed.getDeployTransaction(...args);
  const [gas, block, fees] = await Promise.all([ethers.provider.estimateGas({ data: tx.data }), ethers.provider.getBlock('latest'), ethers.provider.getFeeData()]);
  // HyperEVM small blocks (block.gasLimit): a bigger deployment needs the deployer switched to big blocks
  const cost = ethers.formatEther(gas * (fees.maxFeePerGas || fees.gasPrice || 0n));
  console.log(`deployment: about ${gas} gas, at most ${cost} HYPE${gas > block.gasLimit ? ` (more than a small block of ${block.gasLimit}: switch the deployer to big blocks first)` : ` (fits a small block of ${block.gasLimit})`}`);

  const [deployer] = await ethers.getSigners().catch(() => []);
  if (!live) {
    console.log(`dry run: nothing sent${deployer ? ` (deployer ${deployer.address})` : ' (no DEPLOYER_PRIVATE_KEY)'}. LIVE=1 to deploy.`);
    return;
  }
  if (!deployer) throw new Error('LIVE=1 needs DEPLOYER_PRIVATE_KEY in .env');
  console.log(`deployer ${deployer.address}, ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} HYPE`);
  const feed = await Feed.connect(deployer).deploy(...args);
  const receipt = await feed.deploymentTransaction().wait();
  const address = await feed.getAddress();
  console.log(`RatUsdFeed at ${address} (tx ${receipt.hash}, block ${receipt.blockNumber})`);

  const file = path.join(__dirname, '..', 'deployments', `${network.name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    contract: 'RatUsdFeed', address, chainId: 999, tx: receipt.hash, block: receipt.blockNumber, deployedAt: new Date().toISOString(),
    constructorArgs: { owner, reporters, coreAsset, corePxDecimals, maxDeviationBps: band, maxObservationAge: maxAge },
  }, null, 2) + '\n');
  console.log(`written ${path.relative(process.cwd(), file)}; next: npm run verify:mainnet, then FEED_ADDRESS=${address} in .env for the reporter`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
