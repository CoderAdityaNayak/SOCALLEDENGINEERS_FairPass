// Transfers (gifts, listings, purchases) lock 24 h before the event. The contract enforces the same rule.
export const LOCK_HOURS = 24
export const lockAt = (event) => new Date(Date.parse(event.date) - LOCK_HOURS * 3600_000).toISOString()
export const isLocked = (event) => Date.now() >= Date.parse(lockAt(event))
