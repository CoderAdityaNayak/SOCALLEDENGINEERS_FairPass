// Live event data. The API gives the full event; Firestore (fairpass/live/events/{id}, written by the backend's
// mirror) pushes changes as they happen via onSnapshot, so a new resale cap shows up for fans within a
// second or two. Without a Firebase config we fall back to polling the API.
import { useEffect, useState } from 'react'
import { api } from './api.js'

const env = import.meta.env
const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
}
export const firebaseEnabled = !!firebaseConfig.projectId

let firestorePromise
function firestore() {
  // Loaded on demand so pages that don't need it stay small.
  firestorePromise ||= Promise.all([import('firebase/app'), import('firebase/firestore')]).then(([app, fs]) => ({
    db: fs.getFirestore(app.initializeApp(firebaseConfig, 'fairpass-web')),
    fs,
  }))
  return firestorePromise
}

/** The fields the organiser can change live, as the mirror writes them. */
function liveFields(d) {
  return {
    resaleCapPct: d.resaleCapPct,
    maxResalePrice: d.maxResalePrice,
    maxResalePriceInr: d.maxResalePriceInr,
    facePriceInr: d.facePriceInr,
    resaleCapTx: d.resaleCapTxUrl ?? null,
    resaleCapUpdatedAt: d.resaleCapUpdatedAt ?? null,
  }
}

/**
 * Subscribes to one event. Returns { event, myEntry, live, error }.
 * `live` is 'firestore' while the onSnapshot listener is attached, otherwise 'polling'.
 */
export function useLiveEvent(eventId, { withEntry = false } = {}) {
  const [state, setState] = useState({ event: null, myEntry: null, live: null, error: null })

  useEffect(() => {
    if (!eventId) return
    let alive = true
    let unsubscribe = () => {}
    let timer

    const loadApi = () =>
      api(`/events/${eventId}`)
        .then((r) => alive && setState((s) => ({ ...s, event: { ...s.event, ...r.event }, myEntry: withEntry ? r.myEntry : null, error: null })))
        .catch((error) => alive && setState((s) => ({ ...s, error })))
    loadApi()

    if (firebaseEnabled) {
      firestore()
        .then(({ db, fs }) => {
          if (!alive) return
          unsubscribe = fs.onSnapshot(
            fs.doc(db, 'fairpass', 'live', 'events', String(eventId)),
            (snap) => {
              if (!alive || !snap.exists()) return
              setState((s) => ({ ...s, live: 'firestore', event: s.event ? { ...s.event, ...liveFields(snap.data()) } : s.event }))
            },
            () => {
              // Listener refused (rules, network): poll instead.
              setState((s) => ({ ...s, live: 'polling' }))
              timer ||= setInterval(loadApi, 10000)
            },
          )
        })
        .catch(() => {
          setState((s) => ({ ...s, live: 'polling' }))
          timer ||= setInterval(loadApi, 10000)
        })
    } else {
      setState((s) => ({ ...s, live: 'polling' }))
      timer = setInterval(loadApi, 10000)
    }
    return () => {
      alive = false
      unsubscribe()
      clearInterval(timer)
    }
  }, [eventId, withEntry])

  return state
}

/**
 * A counter that goes up whenever this event's listings change in Firestore (fairpass/live/listings), so a page
 * can re-fetch the marketplace live. Without Firebase it ticks every 10 s instead.
 */
export function useListingsTick(eventId) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!eventId) return
    let unsubscribe = () => {}
    let timer
    let alive = true
    const poll = () => (timer ||= setInterval(() => setTick((t) => t + 1), 10000))
    if (firebaseEnabled) {
      firestore()
        .then(({ db, fs }) => {
          if (!alive) return
          const q = fs.query(fs.collection(db, 'fairpass', 'live', 'listings'), fs.where('eventId', '==', Number(eventId)))
          unsubscribe = fs.onSnapshot(q, () => alive && setTick((t) => t + 1), poll)
        })
        .catch(poll)
    } else poll()
    return () => {
      alive = false
      unsubscribe()
      clearInterval(timer)
    }
  }, [eventId])
  return tick
}

/** Max resale for a face price and markup, rounded down to the paisa (the backend has the exact value). */
export const previewMaxInr = (faceInr, pct) => Math.floor(Number(faceInr) * (100 + Number(pct))) / 100
