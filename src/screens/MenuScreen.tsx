import React, { memo, useCallback, useMemo } from "react"
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { COLORS } from "../constants/colors"
import { FONT_SANS, INPUT_PLACEHOLDER_COLOR, SAFE_AREA } from "../constants/layout"
import type { MenuItemDraft, UiDraftItem } from "../types"
import { formatCurrencyDisplay } from "../utils/formatters"

const EDITABLE_CARD_SHADOW = (Platform.OS === "web"
  ? {
      boxShadow: "0px 3px 8px rgba(0, 0, 0, 0.04)",
    }
  : {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.04,
      shadowRadius: 8,
      elevation: 1,
    }) as Record<string, unknown>

const WEB_TEXT_INPUT_RESET = (Platform.OS === "web"
  ? {
      outlineStyle: "none",
      outlineWidth: 0,
      outlineColor: "transparent",
      boxShadow: "none",
    }
  : {}) as Record<string, unknown>

type MenuScreenProps = {
  savedItems: MenuItemDraft[]
  editableMenuItems: UiDraftItem[]
  busy: boolean
  loading: boolean
  onUpdateEditableMenuItem: (index: number, patch: Partial<UiDraftItem>) => void
  onAddEditableMenuItem: () => void
  onRemoveEditableMenuItem: (index: number) => void
  onSaveEditedMenu: () => void
}

type MenuRow =
  | { key: string; kind: "savedHeader" }
  | { key: string; kind: "savedEmpty" }
  | { key: string; kind: "savedItem"; item: MenuItemDraft }
  | { key: string; kind: "editHeader" }
  | { key: string; kind: "editEmpty" }
  | { key: string; kind: "editableItem"; item: UiDraftItem; index: number }
  | { key: string; kind: "actions" }

type SavedMenuItemCardProps = {
  item: MenuItemDraft
}

type LabeledInputProps = {
  label: string
  value: string
  onChangeText: (value: string) => void
  placeholder?: string
  keyboardType?: "default" | "decimal-pad" | "number-pad"
  multiline?: boolean
}

function LabeledInput({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = "default",
  multiline = false,
}: LabeledInputProps) {
  return (
    <View style={[styles.fieldShell, multiline ? styles.fieldShellMultiline : null]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.fieldInput, multiline ? styles.fieldInputMultiline : null]}
        placeholder={placeholder}
        placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        multiline={multiline}
      />
    </View>
  )
}

const SavedMenuItemCard = memo(function SavedMenuItemCard({ item }: SavedMenuItemCardProps) {
  const optionsText = (item.customizations || [])
    .map((customization) =>
      customization.priceDelta ? `${customization.label}+${customization.priceDelta}` : customization.label,
    )
    .join(", ")

  return (
    <View style={styles.savedCard}>
      <Text style={styles.savedName}>
        {item.name} - {formatCurrencyDisplay(item.basePrice)}
      </Text>
      {item.description ? (
        <Text style={styles.savedMeta}>
          <Text style={styles.savedMetaLabel}>Includes: </Text>
          {item.description}
        </Text>
      ) : null}
      <Text style={styles.savedMeta}>
        <Text style={styles.savedMetaLabel}>Stock: </Text>
        {item.stockQuantity}
      </Text>
      {(item.customizations || []).length > 0 ? (
        <Text style={styles.savedMeta}>
          <Text style={styles.savedMetaLabel}>Options: </Text>
          {optionsText}
        </Text>
      ) : !item.description ? (
        <Text style={styles.savedMeta}>
          <Text style={styles.savedMetaLabel}>Options: </Text>
          No extra details
        </Text>
      ) : null}
    </View>
  )
})

type EditableMenuItemCardProps = {
  item: UiDraftItem
  index: number
  onUpdateEditableMenuItem: (index: number, patch: Partial<UiDraftItem>) => void
  onRemoveEditableMenuItem: (index: number) => void
}

const EditableMenuItemCard = memo(function EditableMenuItemCard({
  item,
  index,
  onUpdateEditableMenuItem,
  onRemoveEditableMenuItem,
}: EditableMenuItemCardProps) {
  return (
    <View style={styles.editableCard}>
      <Text style={styles.itemNumber}>Menu Item {index + 1}</Text>
      <LabeledInput
        label="Item Name"
        value={item.name}
        onChangeText={(value) => onUpdateEditableMenuItem(index, { name: value })}
        placeholder="Enter item name"
      />
      <LabeledInput
        label="Category"
        value={item.category}
        onChangeText={(value) => onUpdateEditableMenuItem(index, { category: value })}
        placeholder="Enter category"
      />
      <LabeledInput
        label="Includes / Description"
        value={item.description}
        onChangeText={(value) => onUpdateEditableMenuItem(index, { description: value })}
        placeholder="Description or combo contents"
        multiline
      />
      <LabeledInput
        label="Base Price"
        value={item.basePrice}
        onChangeText={(value) => onUpdateEditableMenuItem(index, { basePrice: value })}
        placeholder="0.00"
        keyboardType="decimal-pad"
      />
      <LabeledInput
        label="Stock Quantity"
        value={item.stockQuantity}
        onChangeText={(value) => onUpdateEditableMenuItem(index, { stockQuantity: value })}
        placeholder="0"
        keyboardType="number-pad"
      />
      <LabeledInput
        label="Options / Customizations"
        value={item.customizationText}
        onChangeText={(value) => onUpdateEditableMenuItem(index, { customizationText: value })}
        placeholder="Extra Cheese+30, Spice Level"
        multiline
      />
      <Pressable style={styles.secondaryButton} onPress={() => onRemoveEditableMenuItem(index)}>
        <Text style={styles.secondaryButtonText}>Remove Item</Text>
      </Pressable>
    </View>
  )
})

function MenuSkeletonCard() {
  return (
    <View style={styles.skeletonCard}>
      <View style={styles.skeletonTitle} />
      <View style={styles.skeletonSubtitle} />
    </View>
  )
}

export function MenuScreen({
  savedItems,
  editableMenuItems,
  busy,
  loading,
  onUpdateEditableMenuItem,
  onAddEditableMenuItem,
  onRemoveEditableMenuItem,
  onSaveEditedMenu,
}: MenuScreenProps) {
  const menuRows = useMemo<MenuRow[]>(() => {
    const rows: MenuRow[] = [{ key: "saved-header", kind: "savedHeader" }]

    if (savedItems.length === 0) {
      rows.push({ key: "saved-empty", kind: "savedEmpty" })
    } else {
      rows.push(
        ...savedItems.map((item, index) => ({
          key: `saved-item-${item.id || index}`,
          kind: "savedItem" as const,
          item,
        })),
      )
    }

    rows.push({ key: "edit-header", kind: "editHeader" })

    if (editableMenuItems.length === 0) {
      rows.push({ key: "edit-empty", kind: "editEmpty" })
    } else {
      rows.push(
        ...editableMenuItems.map((item, index) => ({
          key: `editable-item-${index}`,
          kind: "editableItem" as const,
          item,
          index,
        })),
      )
    }

    rows.push({ key: "actions", kind: "actions" })
    return rows
  }, [editableMenuItems, savedItems])

  const renderMenuRow = useCallback(
    ({ item }: { item: MenuRow }) => {
      switch (item.kind) {
        case "savedHeader":
          return <Text style={styles.sectionTitle}>View Menu</Text>
        case "savedEmpty":
          return <Text style={styles.emptyText}>No saved items yet.</Text>
        case "savedItem":
          return <SavedMenuItemCard item={item.item} />
        case "editHeader":
          return <Text style={styles.sectionTitle}>Edit Menu (Including Prices)</Text>
        case "editEmpty":
          return <Text style={styles.emptyText}>No menu items to edit yet.</Text>
        case "editableItem":
          return (
            <EditableMenuItemCard
              item={item.item}
              index={item.index}
              onUpdateEditableMenuItem={onUpdateEditableMenuItem}
              onRemoveEditableMenuItem={onRemoveEditableMenuItem}
            />
          )
        case "actions":
          return (
            <View style={styles.actionRow}>
              <Pressable style={styles.secondaryButton} onPress={onAddEditableMenuItem}>
                <Text style={styles.secondaryButtonText}>Add Menu Item</Text>
              </Pressable>
              <Pressable style={styles.primaryWideButton} onPress={onSaveEditedMenu} disabled={busy}>
                <Text style={styles.primaryWideButtonText}>Save Menu Changes</Text>
              </Pressable>
            </View>
          )
        default:
          return null
      }
    },
    [busy, onAddEditableMenuItem, onRemoveEditableMenuItem, onSaveEditedMenu, onUpdateEditableMenuItem],
  )

  if (loading) {
    return (
      <View style={styles.loadingList}>
        {Array.from({ length: 6 }).map((_, index) => (
          <MenuSkeletonCard key={`menu-skeleton-${index}`} />
        ))}
      </View>
    )
  }

  return (
    <View style={styles.listContent}>
      {menuRows.map((item) => (
        <React.Fragment key={item.key}>{renderMenuRow({ item })}</React.Fragment>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  listContent: {
    width: "100%",
  },
  loadingList: {
    width: "100%",
  },
  sectionTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 18,
    fontWeight: "700",
    fontFamily: FONT_SANS,
    marginBottom: 12,
  },
  emptyText: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: FONT_SANS,
    marginBottom: 12,
  },
  savedCard: {
    backgroundColor: COLORS.SURFACE,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    padding: 14,
    marginBottom: 10,
    gap: 6,
  },
  savedName: {
    color: COLORS.ACCENT,
    fontSize: 15,
    fontWeight: "700",
    fontFamily: FONT_SANS,
    marginBottom: 6,
  },
  savedMeta: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: FONT_SANS,
  },
  savedMetaLabel: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 13,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  editableCard: {
    backgroundColor: COLORS.SURFACE,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    padding: 16,
    gap: 12,
    marginBottom: 10,
    ...EDITABLE_CARD_SHADOW,
  },
  itemNumber: {
    color: COLORS.ACCENT,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    fontFamily: FONT_SANS,
  },
  fieldShell: {
    position: "relative",
    borderWidth: 1,
    borderColor: "#CCCCCC",
    backgroundColor: COLORS.SURFACE,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingTop: 20,
    paddingBottom: 10,
  },
  fieldShellMultiline: {
    minHeight: 92,
  },
  fieldLabel: {
    position: "absolute",
    top: 8,
    left: 12,
    fontSize: 11,
    color: "#888888",
    fontWeight: "500",
    fontFamily: FONT_SANS,
  },
  fieldInput: {
    minHeight: 24,
    color: COLORS.TEXT_PRIMARY,
    fontSize: 15,
    paddingTop: 0,
    paddingBottom: 0,
    fontFamily: FONT_SANS,
    ...WEB_TEXT_INPUT_RESET,
  },
  fieldInputMultiline: {
    minHeight: 58,
    textAlignVertical: "top",
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
    paddingTop: 4,
  },
  secondaryButton: {
    flex: 1,
    minHeight: 50,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "#CCCCCC",
    backgroundColor: COLORS.SURFACE,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  secondaryButtonText: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  primaryWideButton: {
    flex: 1.3,
    minHeight: 50,
    borderRadius: 10,
    backgroundColor: COLORS.ACCENT,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  primaryWideButtonText: {
    color: COLORS.SURFACE,
    fontSize: 14,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  skeletonCard: {
    backgroundColor: COLORS.SURFACE,
    borderRadius: 10,
    padding: 16,
    marginBottom: 8,
    height: 72,
  },
  skeletonTitle: {
    backgroundColor: COLORS.BORDER,
    borderRadius: 4,
    height: 14,
    width: "60%",
    marginBottom: 8,
  },
  skeletonSubtitle: {
    backgroundColor: COLORS.BORDER,
    borderRadius: 4,
    height: 11,
    width: "40%",
  },
})
