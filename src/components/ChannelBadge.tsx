import React from "react"
import { StyleSheet, Text, View } from "react-native"
import { AppIcon } from "./AppIcon"
import { COLORS } from "../constants/colors"
import { FONT_SANS } from "../constants/layout"

type ChannelBadgeProps = {
  label?: string
}

export function ChannelBadge({ label = "Voice AI" }: ChannelBadgeProps) {
  return (
    <View style={styles.badge}>
      <View style={styles.dot}>
        <AppIcon name="mic" size={10} color={COLORS.HEADER_TEXT} />
      </View>
      <Text style={styles.kicker}>Voice</Text>
      <Text style={styles.text}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: COLORS.VOICE_BG,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: COLORS.VOICE_BORDER,
  },
  dot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: COLORS.VOICE_COLOR,
    alignItems: "center",
    justifyContent: "center",
  },
  kicker: {
    color: COLORS.VOICE_COLOR,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.9,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  text: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.2,
    fontFamily: FONT_SANS,
  },
})
