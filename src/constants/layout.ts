import { Dimensions, Platform, StatusBar } from "react-native"
import { COLORS } from "./colors"

export const FONT_SANS = Platform.select({
  web: "'Plus Jakarta Sans', Geist, 'Avenir Next', 'Segoe UI', sans-serif",
  ios: "Avenir Next",
  android: "sans-serif",
  default: "System",
})

export const FONT_MONO = Platform.select({
  web: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
})

const screenMetrics = Dimensions.get("screen")
const windowMetrics = Dimensions.get("window")
const androidTopInset = StatusBar.currentHeight || 24
const androidBottomInset =
  Platform.OS === "android"
    ? Math.max(screenMetrics.height - windowMetrics.height - androidTopInset, 0)
    : 0

export const SAFE_AREA = {
  top: Platform.OS === "android" ? androidTopInset : 44,
  bottom: Platform.OS === "ios" ? 34 : androidBottomInset,
} as const

export const INPUT_PLACEHOLDER_COLOR = COLORS.TEXT_MUTED

export const TYPOGRAPHY = {
  DISPLAY: 28,
  TITLE: 20,
  BODY: 15,
  LABEL: 12,
  CAPTION: 11,
  MICRO: 10,
} as const

export const SPACING = {
  XXS: 4,
  XS: 8,
  SM: 12,
  MD: 16,
  LG: 20,
  XL: 24,
  XXL: 32,
} as const

export const RADIUS = {
  SM: 12,
  MD: 16,
  LG: 20,
  XL: 24,
  PILL: 999,
} as const
