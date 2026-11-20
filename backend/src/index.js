// FairPass backend entry point.
import { config } from './config.js'
import { createApp } from './app.js'
import { ensureOrganiser } from './services/users.js'
import { organiser, explorerAddress } from './services/quai.js'
import { startFirestoreMirror } from './services/firestore.js'
import { startChainListener } from './services/chainEvents.js'
import { instanceId } from './db.js'

const firestoreOn = await startFirestoreMirror()
if (firestoreOn) startChainListener() // mirrors contract events (listings, sales, gifts, returns) to Firestore
const org = ensureOrganiser()
createApp().listen(config.port, () => {
  if (firestoreOn) console.log(`  Firestore mirror on: project ${config.firebase.projectId}, path fairpass/live (database ${instanceId.slice(0, 8)})`)
  console.log(`FairPass backend on http://localhost:${config.port}`)
  console.log(`  contract  ${explorerAddress(config.contract.address)}`)
  console.log(`  organiser ${organiser.address} (login phone ${org.phone})`)
  if (config.demoMode) console.log('  DEMO_MODE on: OTPs are returned in API responses')
})
