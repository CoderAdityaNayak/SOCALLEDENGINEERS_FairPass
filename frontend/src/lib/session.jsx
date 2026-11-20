// Logged-in user state, shared across pages.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, getToken, setToken } from './api.js'

const SessionContext = createContext(null)

export function SessionProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(!!getToken())

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null)
      setLoading(false)
      return null
    }
    try {
      const { user } = await api('/auth/me')
      setUser(user)
      return user
    } catch {
      setToken(null)
      setUser(null)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const value = useMemo(
    () => ({
      user,
      loading,
      refresh,
      signIn(token, user) {
        setToken(token)
        setUser(user)
      },
      setUser,
      signOut() {
        setToken(null)
        setUser(null)
      },
    }),
    [user, loading, refresh],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export const useSession = () => useContext(SessionContext)
