// Publishes RatUsdFeed's source on hyperevmscan.io (Etherscan API v2: ETHERSCAN_API_KEY in .env) and
// on Sourcify, with the constructor arguments saved by the deployment (deployments/hyperevm.json).
//
//   npm run verify:mainnet
const fs = require('fs');
const path = require('path');
const hre = require('hardhat');

async function main() {
  const file = path.join(__dirname, '..', 'deployments', `${hre.network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`${path.relative(process.cwd(), file)} not found: deploy first`);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const a = d.constructorArgs;
  await hre.run('verify:verify', {
    address: d.address,
    contract: 'contracts/RatUsdFeed.sol:RatUsdFeed',
    constructorArguments: [a.owner, a.reporters, a.coreAsset, a.corePxDecimals, a.maxDeviationBps, a.maxObservationAge],
  });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
