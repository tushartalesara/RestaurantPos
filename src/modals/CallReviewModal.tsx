import React from "react"
import { Modal, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native"
import { AppIcon } from "../components/AppIcon"
import { COLORS } from "../constants/colors"
import { FONT_SANS, RADIUS, SAFE_AREA, SPACING, TYPOGRAPHY } from "../constants/layout"

const AUDIO_CARD_SHADOW = (Platform.OS === "web"
  ? {
      boxShadow: "0px 14px 30px rgba(8, 16, 29, 0.08)",
    }
  : {
      shadowColor: COLORS.SHADOW,
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.08,
      shadowRadius: 16,
      elevation: 2,
    }) as Record<string, unknown>

export type TranscriptEntry = {
  speaker: string
  message: string
  tone: "agent" | "user" | "neutral"
}

type CallReviewModalProps = {
  visible: boolean
  customerName: string
  statusLabel: string
  normalizedStatus: string
  transcriptText: string
  transcriptEntries: TranscriptEntry[]
  hasRecording: boolean
  isPlaying: boolean
  recordingDuration: number
  recordingProgress: number
  onToggleRecording: () => void
  onClose: () => void
  formatAudioTime: (value: number | null | undefined) => string
}

export function CallReviewModal({
  visible,
  customerName,
  statusLabel,
  normalizedStatus,
  transcriptText,
  transcriptEntries,
  hasRecording,
  isPlaying,
  recordingDuration,
  recordingProgress,
  onToggleRecording,
  onClose,
  formatAudioTime,
}: CallReviewModalProps) {
  if (!visible) {
    return null
  }

  const isCompletedStatus = normalizedStatus === "done" || normalizedStatus === "completed" || normalizedStatus === "complete"
  const isProcessingStatus = normalizedStatus === "processing"
  const statusToneStyle = isCompletedStatus
    ? styles.statusBadgeCompleted
    : isProcessingStatus
      ? styles.statusBadgeProcessing
      : styles.statusBadgeDefault
  const progressWidth = (hasRecording ? `${Math.max(0, Math.min(1, recordingProgress)) * 100}%` : "0%") as `${number}%`
  const elapsedTime = hasRecording && recordingDuration > 0 ? formatAudioTime(recordingDuration * recordingProgress) : "0:00"
  const totalTime = hasRecording && recordingDuration > 0 ? formatAudioTime(recordingDuration) : "0:00"

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
      statusBarTranslucent={false}
    >
      <SafeAreaView style={styles.screen}>
        <StatusBar barStyle="dark-content" backgroundColor={COLORS.BACKGROUND} translucent={false} />
        <View style={styles.header}>
          <View style={styles.headerTextWrap}>
            <Text style={styles.title}>Call Review</Text>
            <View style={styles.customerMetaRow}>
              <Text style={styles.customerName}>{customerName}</Text>
              <View style={[styles.statusBadge, statusToneStyle]}>
                <Text style={styles.statusBadgeText}>{statusLabel}</Text>
              </View>
            </View>
          </View>
          <Pressable style={styles.closeButton} onPress={onClose}>
            <View style={styles.actionLabelRow}>
              <AppIcon name="check" size={16} color={COLORS.TEXT_PRIMARY} />
              <Text style={styles.closeButtonText}>Done</Text>
            </View>
          </Pressable>
        </View>

        <View style={styles.audioCard}>
          <Pressable
            style={[styles.audioButton, !hasRecording ? styles.audioButtonDisabled : null]}
            onPress={hasRecording ? onToggleRecording : undefined}
            disabled={!hasRecording}
          >
            <View
              style={[
                styles.audioIconWrap,
                isPlaying ? styles.audioIconStop : styles.audioIconPlay,
                !hasRecording ? styles.audioIconDisabled : null,
              ]}
            >
              {isPlaying ? <AppIcon name="square" size={18} color={COLORS.HEADER_TEXT} /> : <AppIcon name="play" size={20} color={COLORS.HEADER_TEXT} />}
            </View>
          </Pressable>
          <View style={styles.audioContent}>
            <View style={styles.audioHeaderRow}>
              <View style={styles.audioHeaderTextWrap}>
                <Text style={styles.audioEyebrow}>Call Audio</Text>
                <Text style={styles.audioTitle}>
                  {hasRecording ? (isPlaying ? "Playing the recording" : "Playback ready") : "Recording unavailable"}
                </Text>
              </View>
              <View style={[styles.audioPill, !hasRecording ? styles.audioPillDisabled : null]}>
                <Text style={[styles.audioPillText, !hasRecording ? styles.audioPillTextDisabled : null]}>
                  {hasRecording ? totalTime : "No file"}
                </Text>
              </View>
            </View>
            <View style={styles.audioProgressTrack}>
              <View style={[styles.audioProgressFill, { width: progressWidth }]} />
            </View>
            <View style={styles.audioTimeRow}>
              <Text style={styles.audioTimeText}>{elapsedTime}</Text>
              <Text style={styles.audioTimeText}>{hasRecording ? "Tap to play or pause" : "Audio will appear after processing"}</Text>
            </View>
          </View>
        </View>

        <View style={styles.transcriptSectionHeader}>
          <Text style={styles.sectionLabel}>TRANSCRIPT</Text>
          <View style={styles.sectionDivider} />
        </View>

        <ScrollView
          style={styles.transcriptScroll}
          contentContainerStyle={styles.transcriptScrollContent}
          showsVerticalScrollIndicator={false}
        >
          {transcriptEntries.length > 0 ? (
            transcriptEntries.map((entry, index) => {
              if (entry.tone === "agent") {
                return (
                  <View key={`transcript-entry-${index}`} style={styles.transcriptGroup}>
                    <View style={styles.agentHeaderRow}>
                      <View style={styles.agentIconCircle}>
                        <AppIcon name="mic" size={16} color={COLORS.VOICE_COLOR} />
                      </View>
                      <Text style={styles.agentSpeaker}>AGENT</Text>
                    </View>
                    <View style={styles.agentBubble}>
                      <Text style={styles.transcriptMessage}>{entry.message}</Text>
                    </View>
                  </View>
                )
              }

              if (entry.tone === "user") {
                return (
                  <View key={`transcript-entry-${index}`} style={styles.transcriptGroup}>
                    <Text style={styles.customerSpeaker}>CUSTOMER</Text>
                    <View style={styles.customerBubbleRow}>
                      <View style={styles.customerBubble}>
                        <Text style={styles.transcriptMessage}>{entry.message}</Text>
                      </View>
                      <View style={styles.customerAvatarCircle}>
                        <AppIcon name="user" size={16} color={COLORS.TEXT_SECONDARY} />
                      </View>
                    </View>
                  </View>
                )
              }

              return (
                <View key={`transcript-entry-${index}`} style={styles.transcriptGroup}>
                  <Text style={styles.neutralSpeaker}>{entry.speaker}</Text>
                  <View style={styles.neutralBubble}>
                    <Text style={styles.transcriptMessage}>{entry.message}</Text>
                  </View>
                </View>
              )
            })
          ) : transcriptText ? (
            <View style={styles.transcriptFallback}>
              <Text style={styles.transcriptFallbackText}>{transcriptText}</Text>
            </View>
          ) : (
            <View style={styles.transcriptEmptyWrap}>
              <Text style={styles.transcriptEmpty}>No transcript available</Text>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.BACKGROUND,
    paddingTop: Platform.OS === "android" ? SAFE_AREA.top : 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: SPACING.LG,
    paddingTop: SPACING.LG,
    paddingBottom: SPACING.SM,
    backgroundColor: COLORS.BACKGROUND,
    gap: SPACING.MD,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.BORDER,
  },
  headerTextWrap: {
    flex: 1,
    minWidth: 0,
    gap: SPACING.XS,
  },
  title: {
    fontSize: TYPOGRAPHY.DISPLAY + 2,
    fontWeight: "800",
    color: COLORS.TEXT_PRIMARY,
    fontFamily: FONT_SANS,
  },
  customerMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: SPACING.XS + 2,
  },
  customerName: {
    fontSize: 16,
    fontWeight: "700",
    color: COLORS.TEXT_SECONDARY,
    fontFamily: FONT_SANS,
  },
  statusBadge: {
    paddingHorizontal: SPACING.SM,
    paddingVertical: SPACING.XS - 2,
    borderRadius: RADIUS.PILL,
    borderWidth: 1,
  },
  statusBadgeCompleted: { backgroundColor: COLORS.SUCCESS_BG, borderColor: COLORS.SUCCESS },
  statusBadgeProcessing: { backgroundColor: COLORS.ACCENT_LIGHT, borderColor: COLORS.ACCENT },
  statusBadgeDefault: { backgroundColor: COLORS.SURFACE_RAISED, borderColor: COLORS.BORDER },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: "800",
    color: COLORS.TEXT_PRIMARY,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    fontFamily: FONT_SANS,
  },
  closeButton: {
    backgroundColor: COLORS.SURFACE,
    borderRadius: RADIUS.MD,
    paddingVertical: SPACING.SM - 2,
    paddingHorizontal: SPACING.MD,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    minWidth: 84,
    alignItems: "center",
  },
  closeButtonText: {
    fontSize: 15,
    color: COLORS.TEXT_PRIMARY,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  actionLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: SPACING.XS,
  },
  audioCard: {
    marginHorizontal: SPACING.LG - 2,
    marginTop: SPACING.LG - 2,
    marginBottom: 0,
    padding: SPACING.LG - 2,
    borderRadius: RADIUS.XL,
    backgroundColor: COLORS.SURFACE,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    ...AUDIO_CARD_SHADOW,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACING.LG - 2,
  },
  audioButton: {
    width: 60,
    height: 60,
    borderRadius: RADIUS.LG + 2,
    backgroundColor: COLORS.VOICE_COLOR,
    alignItems: "center",
    justifyContent: "center",
  },
  audioButtonDisabled: {
    backgroundColor: COLORS.BORDER,
  },
  audioContent: { flex: 1, gap: SPACING.SM, paddingTop: 2 },
  audioHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: SPACING.SM - 2,
  },
  audioHeaderTextWrap: {
    flex: 1,
    gap: SPACING.XXS,
  },
  audioEyebrow: {
    color: COLORS.VOICE_COLOR,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  audioTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: TYPOGRAPHY.TITLE - 1,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  audioPill: {
    paddingHorizontal: SPACING.XS + 2,
    paddingVertical: SPACING.XS - 2,
    borderRadius: RADIUS.PILL,
    backgroundColor: COLORS.SURFACE_RAISED,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
  },
  audioPillDisabled: {
    backgroundColor: COLORS.BORDER,
  },
  audioPillText: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 12,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  audioPillTextDisabled: {
    color: COLORS.TEXT_SECONDARY,
  },
  audioIconWrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  audioIconPlay: {
    paddingLeft: 3,
  },
  audioIconStop: {
  },
  audioIconDisabled: {
    opacity: 0.5,
  },
  audioProgressTrack: {
    flex: 1,
    height: 7,
    borderRadius: 999,
    backgroundColor: COLORS.SURFACE_RAISED,
    overflow: "hidden",
  },
  audioProgressFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: COLORS.VOICE_COLOR,
  },
  audioTimeRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: SPACING.SM,
  },
  audioTimeText: {
    flex: 1,
    color: COLORS.TEXT_SECONDARY,
    fontSize: 12,
    fontFamily: FONT_SANS,
  },
  transcriptSectionHeader: {
    paddingHorizontal: SPACING.LG,
    paddingTop: SPACING.LG,
    paddingBottom: SPACING.SM,
    backgroundColor: COLORS.BACKGROUND,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: COLORS.TEXT_MUTED,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  sectionDivider: {
    marginTop: SPACING.XS,
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.BORDER,
  },
  transcriptScroll: {
    flex: 1,
    backgroundColor: COLORS.BACKGROUND,
  },
  transcriptScrollContent: {
    paddingHorizontal: SPACING.LG - 2,
    paddingVertical: SPACING.SM,
    paddingBottom: SAFE_AREA.bottom + SPACING.XL,
  },
  transcriptGroup: {
    marginBottom: SPACING.LG - 2,
  },
  agentHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: SPACING.XS,
  },
  agentIconCircle: {
    width: 32,
    height: 32,
    borderRadius: RADIUS.MD,
    backgroundColor: COLORS.VOICE_BG,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: COLORS.VOICE_BORDER,
  },
  agentSpeaker: {
    fontSize: 11,
    fontWeight: "700",
    color: COLORS.TEXT_MUTED,
    marginLeft: SPACING.XS,
    letterSpacing: 0.7,
    fontFamily: FONT_SANS,
  },
  agentBubble: {
    maxWidth: "86%",
    marginLeft: 40,
    padding: SPACING.SM + 2,
    borderRadius: RADIUS.LG - 2,
    borderTopLeftRadius: 6,
    backgroundColor: COLORS.VOICE_BG,
    borderWidth: 1,
    borderColor: COLORS.VOICE_BORDER,
    alignSelf: "flex-start",
  },
  customerSpeaker: {
    fontSize: 11,
    color: COLORS.TEXT_MUTED,
    textAlign: "right",
    marginBottom: 4,
    letterSpacing: 0.7,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  customerBubbleRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "flex-end",
  },
  customerBubble: {
    maxWidth: "78%",
    marginRight: SPACING.XS,
    padding: SPACING.SM + 2,
    borderRadius: RADIUS.LG - 2,
    borderTopRightRadius: 6,
    backgroundColor: COLORS.SURFACE,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    alignSelf: "flex-end",
  },
  customerAvatarCircle: {
    width: 32,
    height: 32,
    borderRadius: RADIUS.MD,
    backgroundColor: COLORS.SURFACE_RAISED,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: COLORS.BORDER,
  },
  neutralSpeaker: {
    fontSize: 11,
    fontWeight: "700",
    color: COLORS.TEXT_MUTED,
    marginBottom: 4,
    letterSpacing: 0.7,
    fontFamily: FONT_SANS,
  },
  neutralBubble: {
    maxWidth: "84%",
    padding: SPACING.SM + 2,
    borderRadius: RADIUS.LG - 2,
    backgroundColor: COLORS.SURFACE,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    alignSelf: "center",
  },
  transcriptMessage: {
    fontSize: 15,
    lineHeight: 22,
    color: COLORS.TEXT_PRIMARY,
    fontFamily: FONT_SANS,
  },
  transcriptFallback: {
    backgroundColor: COLORS.SURFACE,
    borderRadius: RADIUS.LG,
    padding: SPACING.LG - 2,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
  },
  transcriptFallbackText: {
    fontSize: 15,
    lineHeight: 22,
    color: COLORS.TEXT_PRIMARY,
    fontFamily: FONT_SANS,
  },
  transcriptEmptyWrap: {
    alignItems: "center",
    paddingVertical: SPACING.XXL + SPACING.XS,
  },
  transcriptEmpty: {
    fontSize: 14,
    color: COLORS.TEXT_SECONDARY,
    fontFamily: FONT_SANS,
  },
})
