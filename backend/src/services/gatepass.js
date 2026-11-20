// The message a fan's key signs for the gate QR. It names the contract and chain so a pass can't be
// replayed against another deployment, and the timestamp makes it expire.
import { config } from '../config.js'

export const gatePassMessage = (tokenId, timestamp) =>
  `FairPass gate pass\ncontract: ${config.contract.address}\nchain: ${config.contract.chainId}\ntoken: ${tokenId}\ntime: ${timestamp}`
