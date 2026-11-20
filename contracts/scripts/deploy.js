// Deploys FairPass, creates the demo event, adds the deployer as gate staff, and writes
// {address, abi, chainId, ...} to backend/src/contract.json and frontend/src/contract.json.
//
//   Quai Orchard:  npx hardhat run scripts/deploy.js --network cyprus1   (uses quais)
//   Local fallback: npx hardhat node  +  npx hardhat run scripts/deploy.js --network localhost  (uses hre.ethers)
const fs = require('fs')
const path = require('path')
const hre = require('hardhat')
require('dotenv').config()

const NAME = process.env.TICKET_NAME || 'FairPass Ticket'
const SYMBOL = process.env.TICKET_SYMBOL || 'FPASS'
const EVENT_NAME = process.env.DEMO_EVENT_NAME || '[Headliner] World Tour'
const FACE_QUAI = process.env.DEMO_FACE_PRICE_QUAI || '0.01'
const MAX_SUPPLY = Number(process.env.DEMO_MAX_SUPPLY || 100)
const CAP_PCT = Number(process.env.DEMO_RESALE_CAP_PCT || 10)
const EVENT_DATE = Math.floor(Date.now() / 1000) + 60 * 86400 // 60 days from now

const OUTPUTS = [
  path.join(__dirname, '../../backend/src/contract.json'),
  path.join(__dirname, '../../frontend/src/contract.json'),
]

function writeOutputs(info) {
  for (const file of OUTPUTS) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(info, null, 2) + '\n')
    console.log('  wrote', path.relative(path.join(__dirname, '../..'), file))
  }
}

// quais requires the IPFS CID of the contract metadata (it is embedded in the bytecode).
// We compute it locally instead of relying on @quai/hardhat-deploy-metadata, whose IPFS client is
// incompatible with the IPFS server at ipfs.qu.ai (kubo 0.17) and silently returns "" on failure.
const IPFS_API = 'https://ipfs.qu.ai/api/v0'
let metadataJson

async function metadataCid(artifact) {
  const Hash = require('ipfs-only-hash')
  const bs58 = require('bs58').default || require('bs58')
  const fqn = `${artifact.sourceName}:${artifact.contractName}`
  const buildInfo = await hre.artifacts.getBuildInfo(fqn)
  metadataJson = buildInfo.output.contracts[artifact.sourceName][artifact.contractName].metadata
  const cid = await Hash.of(metadataJson) // CIDv0 "Qm..." (46 chars), same as solc's bytecodeHash: 'ipfs'
  const multihashHex = Buffer.from(bs58.decode(cid)).toString('hex')
  if (!artifact.deployedBytecode.toLowerCase().includes(multihashHex)) {
    throw new Error(`Metadata CID ${cid} is not embedded in the bytecode. Recompile and try again.`)
  }
  return cid
}

async function uploadMetadata(expectedCid) {
  try {
    const form = new FormData()
    form.append('file', new Blob([metadataJson]), 'metadata.json')
    // Adding with pin=true makes ipfs.qu.ai time out (504); add first, then pin separately (best effort).
    const res = await fetch(`${IPFS_API}/add?pin=false&cid-version=0`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`IPFS returned HTTP ${res.status}`)
    const { Hash: uploaded } = await res.json()
    if (uploaded !== expectedCid) throw new Error(`uploaded CID ${uploaded} != bytecode CID ${expectedCid}`)
    console.log('    uploaded to ipfs.qu.ai')
    const pin = await fetch(`${IPFS_API}/pin/add?arg=${uploaded}`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null)
    console.log(pin?.ok ? '    pinned' : '    (pin request did not finish; the file is uploaded but may not be pinned)')
  } catch (err) {
    console.warn('    WARNING: metadata upload failed, deploying anyway (source won\'t show on Quaiscan):', err.message)
  }
}

async function deployQuai(artifact) {
  const quais = require('quais')
  const { url, accounts } = hre.network.config
  if (!accounts.length) throw new Error('PRIVATE_KEY is missing in contracts/.env')

  const provider = new quais.JsonRpcProvider(url, undefined, { usePathing: true })
  const wallet = new quais.Wallet(accounts[0], provider)
  const address = await wallet.getAddress()
  if (quais.getZoneForAddress(address) !== quais.Zone.Cyprus1 || !quais.isQuaiAddress(address)) {
    throw new Error(`Deployer ${address} is not a Cyprus-1 Quai address. Use a Pelagus account in Cyprus-1.`)
  }
  const balance = await provider.getBalance(address)
  console.log(`Deployer ${address}, balance ${quais.formatQuai(balance)} QUAI`)
  if (balance === 0n) throw new Error('Deployer has 0 QUAI. Get Orchard QUAI at https://orchard.faucet.quai.network')

  console.log('1/4 Uploading contract metadata to IPFS (for Quaiscan verification)...')
  const ipfsHash = await metadataCid(artifact)
  console.log('    IPFS CID', ipfsHash)
  await uploadMetadata(ipfsHash)

  console.log('2/4 Deploying FairPass...')
  const factory = new quais.ContractFactory(artifact.abi, artifact.bytecode, wallet, ipfsHash)
  const contract = await factory.deploy(NAME, SYMBOL)
  const deployTx = contract.deploymentTransaction().hash
  console.log('    tx', deployTx)
  await contract.waitForDeployment()
  const contractAddress = await contract.getAddress()
  console.log('    deployed at', contractAddress)

  console.log(`3/4 Creating demo event "${EVENT_NAME}"...`)
  await (await contract.createEvent(EVENT_NAME, EVENT_DATE, quais.parseQuai(FACE_QUAI), MAX_SUPPLY, CAP_PCT)).wait()

  console.log('4/4 Adding deployer as gate staff...')
  await (await contract.addGateStaff(address)).wait()

  return { contractAddress, deployTx, deployer: address, chainId: 15000, network: 'orchard-cyprus1' }
}

async function deployLocal(artifact) {
  const { ethers } = hre
  const [deployer] = await ethers.getSigners()
  console.log('Local fallback: deploying with', deployer.address)
  const contract = await (await ethers.getContractFactory('FairPass')).deploy(NAME, SYMBOL)
  await contract.waitForDeployment()
  const contractAddress = await contract.getAddress()
  await (await contract.createEvent(EVENT_NAME, EVENT_DATE, ethers.parseEther(FACE_QUAI), MAX_SUPPLY, CAP_PCT)).wait()
  await (await contract.addGateStaff(deployer.address)).wait()
  console.log('    deployed at', contractAddress)
  return {
    contractAddress,
    deployTx: contract.deploymentTransaction().hash,
    deployer: deployer.address,
    chainId: 31337,
    network: 'hardhat-local',
  }
}

async function main() {
  await hre.run('compile')
  const artifact = await hre.artifacts.readArtifact('FairPass')
  const isQuai = hre.network.name === 'cyprus1'
  const result = isQuai ? await deployQuai(artifact) : await deployLocal(artifact)

  const explorer = isQuai ? 'https://orchard.quaiscan.io' : null
  writeOutputs({
    address: result.contractAddress,
    chainId: result.chainId,
    network: result.network,
    rpcUrl: isQuai ? hre.network.config.url : 'http://127.0.0.1:8545',
    explorer,
    deployer: result.deployer,
    deployTx: result.deployTx,
    demoEventId: 1,
    deployedAt: new Date().toISOString(),
    abi: artifact.abi,
  })

  console.log('\nDone.')
  if (explorer) {
    console.log(`Contract on Quaiscan: ${explorer}/address/${result.contractAddress}`)
    console.log(`Deploy transaction:   ${explorer}/tx/${result.deployTx}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
