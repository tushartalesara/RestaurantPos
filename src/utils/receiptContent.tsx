import React from "react"
import { Platform, StyleSheet, Text, View } from "react-native"
import type { ReceiptOrder } from "../types"
import { formatCurrencyDisplay, formatReceiptDate, getOrderStatusLabel, getReceiptNumericString } from "./formatters"

type ReceiptContentProps = {
  order: ReceiptOrder | null
  restaurantName: string
}

export function ReceiptContent({ order, restaurantName }: ReceiptContentProps) {
  if (!order) {
    return <Text style={styles.emptyText}>No order data</Text>
  }

  const items = order?.items || order?.order_items || []
  const total = formatCurrencyDisplay(Number(getReceiptNumericString(order?.total_amount || order?.total || 0)))
  const customerName = String(order?.customer_name || order?.contact_name || "Guest")
  const customerPhone = String(order?.customer_phone || order?.contact_phone || "").trim()
  const notes = String(order?.notes || order?.special_instructions || "").trim()
  const orderCode = String(order?.short_code || order?.id || "\u2014")
  const status = getOrderStatusLabel(order?.status)
  const receiptDate = formatReceiptDate(order?.created_at)
  const displayRestaurantName = restaurantName.trim() || "Restaurant"

  return (
    <View>
      <Text style={styles.restaurantName}>{displayRestaurantName}</Text>
      <View style={styles.solidDivider} />

      <Text style={styles.orderCode}>ORDER #{orderCode}</Text>
      <Text style={styles.status}>[ {status} ]</Text>
      <View style={styles.solidDivider} />

      <View style={styles.metaBlock}>
        <Text style={styles.metaText}>Date: {receiptDate}</Text>
        <Text style={styles.metaText}>Customer: {customerName}</Text>
        {customerPhone ? <Text style={styles.metaText}>Phone: {customerPhone}</Text> : null}
        {notes ? <Text style={styles.metaText}>Notes: {notes}</Text> : null}
      </View>

      <View style={styles.dashedDivider} />

      <View style={styles.headerRow}>
        <Text style={styles.headerName}>ITEM</Text>
        <Text style={styles.headerQty}>QTY</Text>
        <Text style={styles.headerPrice}>PRICE</Text>
      </View>
      <View style={styles.thinDivider} />

      {items.length > 0 ? (
        items.map((item, index) => (
          <View key={`receipt-item-${index}-${item.name || item.item_name || "item"}`} style={styles.itemRow}>
            <Text style={styles.itemName}>{String(item.name || item.item_name || "").toUpperCase()}</Text>
            <Text style={styles.itemQty}>{String(item.quantity || item.qty || 1)}</Text>
            <Text style={styles.itemPrice}>
              {formatCurrencyDisplay(Number(getReceiptNumericString(item.price || item.unit_price || 0)))}
            </Text>
          </View>
        ))
      ) : (
        <Text style={styles.emptyText}>No items</Text>
      )}

      <View style={styles.solidDivider} />

      <Text style={styles.totalText}>TOTAL {total}</Text>

      <View style={styles.solidDivider} />

      <Text style={styles.footerTitle}>Thank You!</Text>
      <Text style={styles.footerText}>Please retain this receipt</Text>
    </View>
  )
}

const RECEIPT_FONT = Platform.OS === "ios" ? "Georgia" : "serif"

const styles = StyleSheet.create({
  restaurantName: {
    color: "#1A1A1A",
    fontSize: 18,
    fontWeight: "800",
    textAlign: "center",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 4,
    fontFamily: RECEIPT_FONT,
  },
  solidDivider: {
    height: 1.5,
    backgroundColor: "#1A1A1A",
    marginVertical: 12,
  },
  orderCode: {
    color: "#1A1A1A",
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
    textTransform: "uppercase",
    letterSpacing: 1,
    fontFamily: RECEIPT_FONT,
  },
  status: {
    color: "#1A1A1A",
    fontSize: 12,
    textAlign: "center",
    marginTop: 4,
    fontFamily: RECEIPT_FONT,
  },
  metaBlock: {
    gap: 2,
  },
  metaText: {
    color: "#1A1A1A",
    fontSize: 13,
    lineHeight: 22,
    fontFamily: RECEIPT_FONT,
  },
  dashedDivider: {
    borderBottomWidth: 1,
    borderBottomColor: "#888888",
    borderStyle: "dashed",
    marginVertical: 10,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  headerName: {
    flex: 1,
    color: "#1A1A1A",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.5,
    fontFamily: RECEIPT_FONT,
  },
  headerQty: {
    width: 40,
    color: "#1A1A1A",
    fontSize: 12,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: 0.5,
    fontFamily: RECEIPT_FONT,
  },
  headerPrice: {
    width: 60,
    color: "#1A1A1A",
    fontSize: 12,
    fontWeight: "800",
    textAlign: "right",
    letterSpacing: 0.5,
    fontFamily: RECEIPT_FONT,
  },
  thinDivider: {
    height: 1,
    backgroundColor: "#1A1A1A",
    marginBottom: 8,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 10,
  },
  itemName: {
    flex: 1,
    color: "#1A1A1A",
    fontSize: 13,
    fontFamily: RECEIPT_FONT,
    paddingRight: 6,
  },
  itemQty: {
    width: 40,
    color: "#1A1A1A",
    fontSize: 13,
    textAlign: "center",
    fontFamily: RECEIPT_FONT,
  },
  itemPrice: {
    width: 60,
    color: "#1A1A1A",
    fontSize: 13,
    textAlign: "right",
    fontFamily: RECEIPT_FONT,
  },
  totalText: {
    color: "#1A1A1A",
    fontSize: 16,
    fontWeight: "800",
    textAlign: "right",
    fontFamily: RECEIPT_FONT,
  },
  footerTitle: {
    color: "#1A1A1A",
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
    marginTop: 6,
    fontFamily: RECEIPT_FONT,
  },
  footerText: {
    color: "#444444",
    fontSize: 12,
    textAlign: "center",
    marginTop: 2,
    marginBottom: 16,
    fontFamily: RECEIPT_FONT,
  },
  emptyText: {
    color: "#1A1A1A",
    fontSize: 13,
    textAlign: "center",
    fontFamily: RECEIPT_FONT,
  },
})
