// In-memory sliding-window rate limit per key (IP). Good enough for one server.
const hits = new Map()

setInterval(() => {
  const cutoff = Date.now() - 60_000
  for (const [key, times] of hits) {
    while (times.length && times[0] < cutoff) times.shift()
    if (!times.length) hits.delete(key)
  }
}, 60_000).unref()

/** Records a hit; returns true if `key` made more than `limit` hits in the last `windowMs`. */
export function overLimit(key, limit, windowMs = 60_000) {
  const now = Date.now()
  const times = hits.get(key) || []
  while (times.length && times[0] < now - windowMs) times.shift()
  times.push(now)
  hits.set(key, times)
  return times.length > limit
}

export const resetRateLimits = () => hits.clear()
