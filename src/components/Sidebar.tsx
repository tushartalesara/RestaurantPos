import React from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { AppIcon } from "./AppIcon"
import { COLORS } from "../constants/colors"
import { FONT_SANS, RADIUS, SPACING } from "../constants/layout"
import type { MainTab } from "../types"

type SidebarProps = {
  activeTab: MainTab
  onSelectTab: (tab: MainTab) => void
  onOpenSettings: () => void
}

export function Sidebar({ activeTab, onSelectTab, onOpenSettings }: SidebarProps) {
  const tabs: Array<{ key: MainTab; icon: "clipboard"; label: string }> = [{ key: "orders", icon: "clipboard", label: "Orders" }]

  return (
    <View style={styles.sidebar}>
      <View style={styles.top}>
        <View style={styles.brandBlock}>
          <View style={styles.brandMark}>
            <Text style={styles.brandMarkText}>CR</Text>
          </View>
          <Text style={styles.brandLabel}>Console</Text>
          <Text style={styles.brandSubLabel}>Ops</Text>
        </View>
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key
          return (
            <Pressable
              key={tab.key}
              style={[styles.item, isActive ? styles.itemActive : null]}
              onPress={() => onSelectTab(tab.key)}
              accessibilityLabel={tab.label}
            >
              <View style={[styles.iconWrap, isActive ? styles.iconWrapActive : null]}>
                <AppIcon name={tab.icon} size={18} color={isActive ? COLORS.HEADER_TEXT : "rgba(255,255,255,0.68)"} />
              </View>
              <Text style={[styles.label, isActive ? styles.labelActive : null]}>{tab.label}</Text>
            </Pressable>
          )
        })}
      </View>

      <Pressable style={styles.item} onPress={onOpenSettings} accessibilityLabel="Settings">
        <View style={styles.iconWrap}>
          <AppIcon name="settings" size={18} color="rgba(255,255,255,0.68)" />
        </View>
        <Text style={styles.label}>Settings</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  sidebar: {
    width: 94,
    backgroundColor: COLORS.SURFACE_DARK,
    borderRightWidth: 1,
    borderRightColor: COLORS.SIDEBAR_BORDER,
    justifyContent: "space-between",
    paddingHorizontal: SPACING.XS,
    paddingVertical: SPACING.LG,
  },
  top: { gap: SPACING.SM },
  brandBlock: {
    alignItems: "center",
    gap: SPACING.XXS + 1,
    paddingBottom: SPACING.XS,
  },
  brandMark: {
    width: 42,
    height: 42,
    borderRadius: RADIUS.MD,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  brandMarkText: {
    color: COLORS.HEADER_TEXT,
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 0.8,
    fontFamily: FONT_SANS,
  },
  brandLabel: {
    color: COLORS.HEADER_TEXT,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.9,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  brandSubLabel: {
    color: "rgba(255,255,255,0.56)",
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.7,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  item: {
    minHeight: 74,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: RADIUS.LG,
    borderWidth: 1,
    borderColor: "transparent",
    gap: SPACING.XS,
    paddingVertical: SPACING.SM,
  },
  itemActive: {
    backgroundColor: COLORS.SIDEBAR_TINT,
    borderColor: "rgba(13, 138, 115, 0.38)",
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.MD,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  iconWrapActive: {
    backgroundColor: COLORS.ACCENT,
    borderColor: COLORS.ACCENT,
  },
  label: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.7,
    fontFamily: FONT_SANS,
  },
  labelActive: { color: COLORS.HEADER_TEXT },
})
