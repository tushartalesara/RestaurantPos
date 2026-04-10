import React from "react"
import { StyleSheet, Text, View } from "react-native"
import { COLORS } from "../constants/colors"
import { FONT_SANS } from "../constants/layout"

type ChannelBadgeProps = {
  label?: string
}

export function ChannelBadge({ label = "Voice AI" }: ChannelBadgeProps) {
  return (
    <View style={styles.badge}>
      <Text style={styles.text}>{`\u{1F399}\uFE0F ${label}`}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    backgroundColor: COLORS.VOICE_BG,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 5,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: COLORS.VOICE_COLOR,
  },
  text: {
    color: COLORS.VOICE_COLOR,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.3,
    fontFamily: FONT_SANS,
  },
})
