// Hardhat config for Quai Network. Quai's plugins require Hardhat 2 (CommonJS).
require('@nomicfoundation/hardhat-toolbox')
require('@quai/hardhat-deploy-metadata') // pushes contract metadata to IPFS so Quaiscan can verify

require('dotenv').config()

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []

module.exports = {
  defaultNetwork: 'hardhat',
  networks: {
    // Quai Orchard testnet, zone Cyprus-1
    cyprus1: {
      url: process.env.RPC_URL || 'https://orchard.rpc.quai.network',
      accounts,
      chainId: Number(process.env.CHAIN_ID || 15000),
    },
    // Fallback: `npx hardhat node` in another terminal, then deploy with --network localhost
    localhost: {
      url: 'http://127.0.0.1:8545',
      chainId: 31337,
    },
  },
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: { enabled: true, runs: 1000 },
      // Required by @quai/hardhat-deploy-metadata and Quaiscan verification.
      metadata: { bytecodeHash: 'ipfs', useLiteralContent: true },
      // Quai's EVM does not support opcodes newer than London (e.g. PUSH0 from Shanghai).
      evmVersion: 'london',
    },
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  mocha: { timeout: 20000 },
}
