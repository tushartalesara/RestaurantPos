import { useEffect, useRef, useState } from "react"
import { supabase } from "../supabase"

export type RestaurantRealtimeStatus = "idle" | "connecting" | "subscribed" | "fallback"

export function useRestaurantRealtime(params: {
  restaurantId: string | null
  enabled: boolean
  onRestaurantChange: () => void
}): RestaurantRealtimeStatus {
  const { restaurantId, enabled, onRestaurantChange } = params
  const onRestaurantChangeRef = useRef(onRestaurantChange)
  const notifyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fallbackTriggeredRef = useRef(false)
  const [status, setStatus] = useState<RestaurantRealtimeStatus>("idle")

  useEffect(() => {
    onRestaurantChangeRef.current = onRestaurantChange
  }, [onRestaurantChange])

  useEffect(() => {
    if (!restaurantId || !enabled) {
      setStatus("idle")
      if (notifyTimeoutRef.current) {
        clearTimeout(notifyTimeoutRef.current)
        notifyTimeoutRef.current = null
      }
      return
    }

    fallbackTriggeredRef.current = false
    setStatus("connecting")

    const scheduleRefresh = (immediate = false) => {
      if (notifyTimeoutRef.current) {
        if (!immediate) {
          return
        }
        clearTimeout(notifyTimeoutRef.current)
        notifyTimeoutRef.current = null
      }

      if (immediate) {
        onRestaurantChangeRef.current()
        return
      }

      notifyTimeoutRef.current = setTimeout(() => {
        notifyTimeoutRef.current = null
        onRestaurantChangeRef.current()
      }, 250)
    }

    const channel = supabase
      .channel(`restaurant-live:${restaurantId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "restaurant_orders",
          filter: `restaurant_id=eq.${restaurantId}`,
        },
        () => scheduleRefresh(),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "menu_items",
          filter: `restaurant_id=eq.${restaurantId}`,
        },
        () => scheduleRefresh(),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "post_call_webhooks",
          filter: `restaurant_id=eq.${restaurantId}`,
        },
        () => scheduleRefresh(),
      )

    channel.subscribe((nextStatus) => {
      if (nextStatus === "SUBSCRIBED") {
        fallbackTriggeredRef.current = false
        setStatus("subscribed")
        scheduleRefresh(true)
        return
      }

      if (nextStatus === "CHANNEL_ERROR" || nextStatus === "TIMED_OUT" || nextStatus === "CLOSED") {
        setStatus("fallback")
        if (!fallbackTriggeredRef.current) {
          fallbackTriggeredRef.current = true
          scheduleRefresh(true)
        }
        return
      }

      if (nextStatus === "JOINING") {
        setStatus("connecting")
      }
    })

    return () => {
      fallbackTriggeredRef.current = false
      if (notifyTimeoutRef.current) {
        clearTimeout(notifyTimeoutRef.current)
        notifyTimeoutRef.current = null
      }
      void supabase.removeChannel(channel)
    }
  }, [enabled, restaurantId])

  return status
}
