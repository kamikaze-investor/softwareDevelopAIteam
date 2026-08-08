import { useCallback, useRef } from 'react'
import { useFocusEffect } from 'expo-router'
import { AppState } from 'react-native'
import type { AppStateStatus } from 'react-native'

export const POLLING_INTERVAL_MS = 5000

export function usePolling(
  callback: () => Promise<void>,
  options: { intervalMs: number; enabled: boolean },
): void {
  const callbackRef = useRef(callback)
  const enabledRef = useRef(options.enabled)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isFocusedRef = useRef(false)
  const isRunningRef = useRef(false)
  const appStateRef = useRef<AppStateStatus>(AppState.currentState)

  callbackRef.current = callback
  enabledRef.current = options.enabled

  const clearPollingInterval = useCallback((): void => {
    if (intervalRef.current === null) return

    clearInterval(intervalRef.current)
    intervalRef.current = null
  }, [])

  const executeCallback = useCallback((): void => {
    if (isRunningRef.current) return

    isRunningRef.current = true
    let callbackPromise: Promise<void>

    try {
      callbackPromise = callbackRef.current()
    } catch {
      isRunningRef.current = false
      return
    }

    void callbackPromise
      .catch(() => {})
      .finally(() => {
        isRunningRef.current = false
      })
  }, [])

  const startPolling = useCallback(
    (executeImmediately: boolean): void => {
      clearPollingInterval()

      if (
        !isFocusedRef.current ||
        !enabledRef.current ||
        appStateRef.current !== 'active'
      ) {
        return
      }

      if (executeImmediately) executeCallback()
      intervalRef.current = setInterval(executeCallback, options.intervalMs)
    },
    [clearPollingInterval, executeCallback, options.intervalMs],
  )

  useFocusEffect(
    useCallback(() => {
      isFocusedRef.current = true
      appStateRef.current = AppState.currentState

      if (!options.enabled) {
        return () => {
          isFocusedRef.current = false
          clearPollingInterval()
        }
      }

      startPolling(true)

      const subscription = AppState.addEventListener(
        'change',
        (nextState: AppStateStatus): void => {
          const previousState = appStateRef.current
          appStateRef.current = nextState
          clearPollingInterval()

          if (nextState === 'active') {
            startPolling(previousState !== 'active')
          }
        },
      )

      return () => {
        isFocusedRef.current = false
        clearPollingInterval()
        subscription.remove()
      }
    }, [
      clearPollingInterval,
      options.enabled,
      startPolling,
    ]),
  )
}
