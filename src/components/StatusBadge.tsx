import React from "react"
import { StyleSheet, Text, View } from "react-native"
import { COLORS } from "../constants/colors"
import { FONT_SANS } from "../constants/layout"

type StatusTone = "pending" | "complete" | "cancelled"

type StatusBadgeProps = {
  label: string
  tone: StatusTone
}

export function StatusBadge({ label, tone }: StatusBadgeProps) {
  return (
    <View style={[styles.badge, tone === "complete" ? styles.complete : tone === "cancelled" ? styles.cancelled : styles.pending]}>
      <Text
        style={[
          styles.text,
          tone === "complete" ? styles.completeText : tone === "cancelled" ? styles.cancelledText : styles.pendingText,
        ]}
      >
        {label}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    alignSelf: "flex-start",
    borderWidth: 1,
  },
  pending: { backgroundColor: COLORS.WARNING_BG, borderColor: COLORS.WARNING },
  complete: { backgroundColor: COLORS.SUCCESS_BG, borderColor: COLORS.SUCCESS },
  cancelled: { backgroundColor: COLORS.DANGER_BG, borderColor: COLORS.DANGER },
  text: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.7,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  pendingText: { color: COLORS.WARNING },
  completeText: { color: COLORS.SUCCESS },
  cancelledText: { color: COLORS.DANGER },
})
