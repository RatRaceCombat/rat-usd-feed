require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
require('@nomicfoundation/hardhat-verify');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// Only the deploy script signs with this key (the reporter has its own, REPORTER_PRIVATE_KEY).
const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: { optimizer: { enabled: true, runs: 1000 }, evmVersion: 'cancun' },
  },
  networks: {
    hardhat: { chainId: 31337 },
    // Hyperliquid HyperEVM mainnet only: the guard reads RAT's HyperCore book, which testnet does not have
    hyperevm: { url: process.env.HYPEREVM_RPC || 'https://rpc.hyperliquid.xyz/evm', chainId: 999, accounts },
  },
  // source verification on hyperevmscan.io (Etherscan API v2, one key for every chain) and Sourcify
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || '',
    customChains: [
      { network: 'hyperevm', chainId: 999, urls: { apiURL: 'https://api.etherscan.io/v2/api', browserURL: 'https://hyperevmscan.io' } },
    ],
  },
  sourcify: { enabled: true },
};
