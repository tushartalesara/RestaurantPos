import React from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { COLORS } from "../constants/colors"
import { FONT_SANS } from "../constants/layout"
import type { MainTab } from "../types"

type SidebarProps = {
  activeTab: MainTab
  onSelectTab: (tab: MainTab) => void
  onOpenSettings: () => void
}

export function Sidebar({ activeTab, onSelectTab, onOpenSettings }: SidebarProps) {
  const tabs: Array<{ key: MainTab; icon: string; label: string }> = [{ key: "orders", icon: "\u{1F4CB}", label: "Orders" }]

  return (
    <View style={styles.sidebar}>
      <View style={styles.top}>
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key
          return (
            <Pressable
              key={tab.key}
              style={[styles.item, isActive ? styles.itemActive : null]}
              onPress={() => onSelectTab(tab.key)}
              accessibilityLabel={tab.label}
            >
              <Text style={[styles.icon, isActive ? styles.iconActive : null]}>{tab.icon}</Text>
              <Text style={[styles.label, isActive ? styles.labelActive : null]}>{tab.label.toUpperCase()}</Text>
            </Pressable>
          )
        })}
      </View>

      <Pressable style={styles.item} onPress={onOpenSettings} accessibilityLabel="Settings">
        <Text style={styles.icon}>{"\u2699\uFE0F"}</Text>
        <Text style={styles.label}>CONFIG</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  sidebar: {
    width: 76,
    backgroundColor: COLORS.HEADER_BG,
    borderRightWidth: 1,
    borderRightColor: COLORS.SIDEBAR_BORDER,
    justifyContent: "space-between",
    paddingVertical: 14,
  },
  top: { gap: 4 },
  item: {
    height: 70,
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: 3,
    borderLeftColor: "transparent",
    gap: 4,
  },
  itemActive: {
    backgroundColor: COLORS.SIDEBAR_TINT,
    borderLeftColor: COLORS.ACCENT,
  },
  icon: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 22,
    textAlign: "center",
    fontFamily: FONT_SANS,
  },
  iconActive: { color: COLORS.ACCENT },
  label: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 9,
    fontWeight: "600",
    marginTop: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontFamily: FONT_SANS,
  },
  labelActive: { color: COLORS.HEADER_TEXT },
})
