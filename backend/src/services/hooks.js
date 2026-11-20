// Cross-feature hooks, so routes don't import each other. Features register handlers at startup.
const verifiedHandlers = []

/** Called after a user passes KYC (e.g. corporate invites waiting for this phone). */
export const onUserVerified = (user) => {
  for (const handler of verifiedHandlers) {
    Promise.resolve()
      .then(() => handler(user))
      .catch((err) => console.error('[hook] onUserVerified failed:', err.message))
  }
}
export const registerOnUserVerified = (handler) => verifiedHandlers.push(handler)
