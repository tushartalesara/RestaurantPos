import React, { memo, useCallback, useMemo } from "react"
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { AppIcon } from "../components/AppIcon"
import { COLORS } from "../constants/colors"
import { FONT_SANS, INPUT_PLACEHOLDER_COLOR, RADIUS, SPACING, TYPOGRAPHY } from "../constants/layout"
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
  currencyCode: string
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
  currencyCode: string
}

type LabeledInputProps = {
  label: string
  value: string
  onChangeText: (value: string) => void
  placeholder?: string
  keyboardType?: "default" | "decimal-pad" | "number-pad"
  multiline?: boolean
}

type SectionHeaderProps = {
  eyebrow: string
  title: string
  description: string
}

function SectionHeader({ eyebrow, title, description }: SectionHeaderProps) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionEyebrow}>{eyebrow}</Text>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionDescription}>{description}</Text>
    </View>
  )
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

const SavedMenuItemCard = memo(function SavedMenuItemCard({ item, currencyCode }: SavedMenuItemCardProps) {
  const optionsText = (item.customizations || [])
    .map((customization) =>
      customization.priceDelta ? `${customization.label}+${customization.priceDelta}` : customization.label,
    )
    .join(", ")

  return (
    <View style={styles.savedCard}>
      <View style={styles.savedCardHeader}>
        <View style={styles.savedCardTitleWrap}>
          {item.category ? (
            <View style={styles.savedCategoryBadge}>
              <Text style={styles.savedCategoryText}>{item.category}</Text>
            </View>
          ) : null}
          <Text style={styles.savedName}>{item.name}</Text>
        </View>
        <View style={styles.savedPriceBadge}>
          <Text style={styles.savedPriceText}>{formatCurrencyDisplay(item.basePrice, currencyCode)}</Text>
        </View>
      </View>
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
      <View style={styles.editableCardHeader}>
        <Text style={styles.itemNumber}>Menu Item {index + 1}</Text>
        <Pressable style={styles.removeChipButton} onPress={() => onRemoveEditableMenuItem(index)}>
          <View style={styles.buttonLabelRow}>
            <AppIcon name="x" size={14} color={COLORS.DANGER_DARK} />
            <Text style={styles.removeChipButtonText}>Remove</Text>
          </View>
        </Pressable>
      </View>
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
  currencyCode,
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
          return (
            <SectionHeader
              eyebrow="Live Menu"
              title="Current menu lineup"
              description="Review what staff and the voice agent can currently sell, including pricing and stock."
            />
          )
        case "savedEmpty":
          return <Text style={styles.emptyText}>No saved items yet.</Text>
        case "savedItem":
          return <SavedMenuItemCard item={item.item} currencyCode={currencyCode} />
        case "editHeader":
          return (
            <SectionHeader
              eyebrow="Editor"
              title="Refine the menu"
              description="Adjust names, pricing, descriptions, and stock so every ordering surface stays in sync."
            />
          )
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
            <View style={styles.actionsPanel}>
              <Text style={styles.actionsTitle}>Ready to update the live menu?</Text>
              <Text style={styles.actionsSubtitle}>Add new dishes or publish your latest pricing changes in one step.</Text>
              <View style={styles.actionRow}>
                <Pressable style={styles.secondaryButton} onPress={onAddEditableMenuItem}>
                  <View style={styles.buttonLabelRow}>
                    <AppIcon name="plus" size={16} color={COLORS.TEXT_PRIMARY} />
                    <Text style={styles.secondaryButtonText}>Add Menu Item</Text>
                  </View>
                </Pressable>
                <Pressable style={styles.primaryWideButton} onPress={onSaveEditedMenu} disabled={busy}>
                  <View style={styles.buttonLabelRow}>
                    <AppIcon name={busy ? "loader" : "save"} size={16} color={COLORS.SURFACE} />
                    <Text style={styles.primaryWideButtonText}>{busy ? "Saving..." : "Save Menu Changes"}</Text>
                  </View>
                </Pressable>
              </View>
            </View>
          )
        default:
          return null
      }
    },
    [busy, currencyCode, onAddEditableMenuItem, onRemoveEditableMenuItem, onSaveEditedMenu, onUpdateEditableMenuItem],
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
    fontSize: 23,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  sectionHeader: {
    marginBottom: SPACING.MD,
    paddingHorizontal: SPACING.XXS,
    gap: SPACING.XXS,
  },
  sectionEyebrow: {
    color: COLORS.ACCENT,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.3,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  sectionDescription: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: TYPOGRAPHY.BODY - 1,
    lineHeight: 22,
    fontFamily: FONT_SANS,
  },
  emptyText: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: FONT_SANS,
    marginBottom: SPACING.MD,
    paddingHorizontal: SPACING.XXS,
  },
  savedCard: {
    backgroundColor: COLORS.SURFACE,
    borderRadius: RADIUS.XL,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    padding: SPACING.LG - 2,
    marginBottom: SPACING.SM,
    gap: SPACING.SM - 2,
    ...EDITABLE_CARD_SHADOW,
  },
  savedCardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: SPACING.SM,
  },
  savedCardTitleWrap: {
    flex: 1,
    gap: SPACING.XS,
  },
  savedCategoryBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: SPACING.XS + 2,
    paddingVertical: SPACING.XXS + 1,
    borderRadius: RADIUS.PILL,
    backgroundColor: COLORS.ACCENT_LIGHT,
    borderWidth: 1,
    borderColor: COLORS.ACCENT,
  },
  savedCategoryText: {
    color: COLORS.ACCENT_DARK,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  savedName: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: TYPOGRAPHY.TITLE - 1,
    fontWeight: "800",
    fontFamily: FONT_SANS,
    lineHeight: 24,
  },
  savedPriceBadge: {
    minHeight: 44,
    borderRadius: RADIUS.MD,
    paddingHorizontal: SPACING.SM + 2,
    paddingVertical: SPACING.SM - 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.SURFACE_RAISED,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
  },
  savedPriceText: {
    color: COLORS.ACCENT_DARK,
    fontSize: 14,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  savedMeta: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: TYPOGRAPHY.BODY - 1,
    lineHeight: 20,
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
    borderRadius: RADIUS.XL,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    padding: SPACING.LG - 2,
    gap: SPACING.SM + 2,
    marginBottom: SPACING.SM,
    ...EDITABLE_CARD_SHADOW,
  },
  editableCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACING.SM,
  },
  itemNumber: {
    color: COLORS.ACCENT,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  removeChipButton: {
    paddingHorizontal: SPACING.SM,
    paddingVertical: SPACING.XS - 1,
    borderRadius: RADIUS.PILL,
    backgroundColor: COLORS.DANGER_BG,
    borderWidth: 1,
    borderColor: COLORS.DANGER,
  },
  removeChipButtonText: {
    color: COLORS.DANGER_DARK,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.4,
    fontFamily: FONT_SANS,
  },
  buttonLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: SPACING.XS,
  },
  fieldShell: {
    position: "relative",
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    backgroundColor: COLORS.SURFACE_RAISED,
    borderRadius: RADIUS.MD,
    paddingHorizontal: SPACING.SM + 2,
    paddingTop: SPACING.LG + 2,
    paddingBottom: SPACING.SM,
  },
  fieldShellMultiline: {
    minHeight: 108,
  },
  fieldLabel: {
    position: "absolute",
    top: SPACING.XS + 1,
    left: SPACING.SM + 2,
    fontSize: 11,
    color: COLORS.TEXT_MUTED,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
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
    minHeight: 64,
    textAlignVertical: "top",
  },
  actionsPanel: {
    marginTop: SPACING.XS,
    marginBottom: SPACING.SM,
    borderRadius: RADIUS.XL,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    backgroundColor: COLORS.SURFACE,
    padding: SPACING.LG - 2,
    gap: SPACING.SM - 2,
    ...EDITABLE_CARD_SHADOW,
  },
  actionsTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: TYPOGRAPHY.TITLE - 1,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  actionsSubtitle: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: TYPOGRAPHY.BODY - 1,
    lineHeight: 20,
    fontFamily: FONT_SANS,
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: SPACING.SM - 2,
    paddingTop: SPACING.XXS,
  },
  secondaryButton: {
    flex: 1,
    minHeight: 54,
    minWidth: 180,
    borderRadius: RADIUS.MD,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    backgroundColor: COLORS.SURFACE_RAISED,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: SPACING.LG - 2,
  },
  secondaryButtonText: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 14,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  primaryWideButton: {
    flex: 1.3,
    minHeight: 54,
    minWidth: 220,
    borderRadius: RADIUS.MD,
    backgroundColor: COLORS.ACCENT,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: SPACING.LG,
  },
  primaryWideButtonText: {
    color: COLORS.SURFACE,
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.2,
    fontFamily: FONT_SANS,
  },
  skeletonCard: {
    backgroundColor: COLORS.SURFACE,
    borderRadius: RADIUS.XL,
    padding: SPACING.LG - 2,
    marginBottom: SPACING.SM,
    height: 88,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
  },
  skeletonTitle: {
    backgroundColor: COLORS.BORDER,
    borderRadius: 999,
    height: 15,
    width: "58%",
    marginBottom: 10,
  },
  skeletonSubtitle: {
    backgroundColor: COLORS.BORDER,
    borderRadius: 999,
    height: 12,
    width: "36%",
  },
})
