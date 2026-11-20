// Optional Pelagus wallet connection (Quai's browser wallet), via quais BrowserProvider.
export const hasPelagus = () => typeof window !== 'undefined' && !!window.pelagus

export async function connectPelagus() {
  if (!hasPelagus()) throw new Error('Pelagus is not installed. Get it at pelaguswallet.io')
  const { quais } = await import('quais') // loaded only when needed
  const provider = new quais.BrowserProvider(window.pelagus)
  const accounts = await provider.send('quai_requestAccounts', [])
  const address = accounts?.[0]
  if (!address) throw new Error('No account selected in Pelagus')
  const zone = quais.getZoneForAddress(address)
  return { address, zone, cyprus1: zone === quais.Zone.Cyprus1 }
}
