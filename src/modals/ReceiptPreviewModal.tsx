import React from "react"
import { Modal, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native"
import { COLORS } from "../constants/colors"
import { FONT_SANS, SAFE_AREA } from "../constants/layout"
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
        <StatusBar barStyle="light-content" backgroundColor="#1A1A2E" translucent={false} />
        <View style={styles.header}>
          <Pressable style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeButtonText}>{"\u00D7"}</Text>
          </Pressable>
          <Text style={styles.title}>Receipt Preview</Text>
          <Pressable style={styles.printButton} onPress={onPrint}>
            <Text style={styles.printButtonText}>{"\u{1F5A8}\uFE0F Print"}</Text>
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
    backgroundColor: "#1A1A2E",
    paddingTop: Platform.OS === "android" ? SAFE_AREA.top : 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#1A1A2E",
  },
  title: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  printButton: {
    backgroundColor: COLORS.ACCENT,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    minWidth: 96,
    alignItems: "center",
  },
  printButtonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  closeButton: {
    width: 44,
    alignItems: "flex-start",
    justifyContent: "center",
    paddingVertical: 4,
  },
  closeButtonText: {
    color: "#FFFFFF",
    fontSize: 22,
    lineHeight: 24,
    fontFamily: FONT_SANS,
  },
  scroll: {
    flex: 1,
    backgroundColor: "#1A1A2E",
  },
  scrollContent: {
    paddingVertical: 20,
    paddingHorizontal: 20,
    alignItems: "center",
    paddingBottom: SAFE_AREA.bottom + 24,
  },
  paperWrap: {
    alignItems: "center",
  },
  paper: {
    backgroundColor: "#F5F0E8",
    width: 280,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 0,
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
    borderBottomColor: "#1A1A2E",
  },
})
