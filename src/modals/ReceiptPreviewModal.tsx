import React from "react"
import { Modal, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native"
import { AppIcon } from "../components/AppIcon"
import { COLORS } from "../constants/colors"
import { FONT_SANS, RADIUS, SAFE_AREA, SPACING, TYPOGRAPHY } from "../constants/layout"
import type { ReceiptOrder } from "../types"
import { ReceiptContent } from "../utils/receiptContent"

const PAPER_SHADOW = (Platform.OS === "web"
  ? {
      boxShadow: "0px 8px 12px rgba(0, 0, 0, 0.3)",
    }
  : {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.3,
      shadowRadius: 12,
      elevation: 8,
    }) as Record<string, unknown>

type ReceiptPreviewModalProps = {
  visible: boolean
  order: ReceiptOrder | null
  restaurantName: string
  onClose: () => void
  onPrint: () => void
}

export function ReceiptPreviewModal({
  visible,
  order,
  restaurantName,
  onClose,
  onPrint,
}: ReceiptPreviewModalProps) {
  if (!visible || !order) {
    return null
  }

  return (
    <Modal visible animationType="slide" transparent={false} onRequestClose={onClose} statusBarTranslucent={false}>
      <SafeAreaView style={styles.screen}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.PAPER_SURROUND} translucent={false} />
        <View style={styles.header}>
          <Pressable style={styles.closeButton} onPress={onClose}>
            <AppIcon name="x" size={22} color="rgba(255,255,255,0.84)" />
          </Pressable>
          <View style={styles.headerTitleWrap}>
            <Text style={styles.headerEyebrow}>Print Center</Text>
            <Text style={styles.title}>Receipt Preview</Text>
          </View>
          <Pressable style={styles.printButton} onPress={onPrint}>
            <View style={styles.buttonLabelRow}>
              <AppIcon name="printer" size={16} color={COLORS.HEADER_TEXT} />
              <Text style={styles.printButtonText}>Print</Text>
            </View>
          </Pressable>
        </View>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.paperWrap}>
            <View style={styles.paper}>
              <ReceiptContent order={order} restaurantName={restaurantName} />
            </View>
            <View style={styles.tearRow}>
              {Array.from({ length: 20 }).map((_, index) => (
                <View key={`receipt-tooth-${index}`} style={styles.tearTooth} />
              ))}
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.PAPER_SURROUND,
    paddingTop: Platform.OS === "android" ? SAFE_AREA.top : 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: SPACING.LG,
    paddingVertical: SPACING.SM,
    backgroundColor: COLORS.PAPER_SURROUND,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.08)",
    gap: SPACING.SM,
  },
  headerTitleWrap: {
    flex: 1,
    alignItems: "center",
    gap: SPACING.XXS,
  },
  headerEyebrow: {
    color: "rgba(255,255,255,0.58)",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  title: {
    color: COLORS.HEADER_TEXT,
    fontSize: TYPOGRAPHY.TITLE,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  printButton: {
    backgroundColor: COLORS.ACCENT,
    borderRadius: RADIUS.MD,
    paddingVertical: SPACING.SM,
    paddingHorizontal: SPACING.MD,
    minWidth: 96,
    alignItems: "center",
  },
  printButtonText: {
    color: COLORS.HEADER_TEXT,
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.2,
    fontFamily: FONT_SANS,
  },
  buttonLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: SPACING.XS,
  },
  closeButton: {
    width: 44,
    alignItems: "flex-start",
    justifyContent: "center",
    paddingVertical: 4,
  },
  scroll: {
    flex: 1,
    backgroundColor: COLORS.PAPER_SURROUND,
  },
  scrollContent: {
    paddingVertical: SPACING.LG,
    paddingHorizontal: SPACING.LG,
    alignItems: "center",
    paddingBottom: SAFE_AREA.bottom + SPACING.XL,
  },
  paperWrap: {
    alignItems: "center",
  },
  paper: {
    backgroundColor: COLORS.PAPER,
    width: 296,
    paddingHorizontal: SPACING.LG,
    paddingTop: SPACING.XL,
    paddingBottom: 0,
    borderRadius: RADIUS.XL,
    overflow: "hidden",
    ...PAPER_SHADOW,
  },
  tearRow: {
    flexDirection: "row",
    alignSelf: "center",
    marginTop: -1,
    overflow: "hidden",
  },
  tearTooth: {
    width: 0,
    height: 0,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderBottomWidth: 10,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: COLORS.PAPER_SURROUND,
  },
})
