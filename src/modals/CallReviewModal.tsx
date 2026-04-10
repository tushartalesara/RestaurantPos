import React from "react"
import { Modal, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native"
import { COLORS } from "../constants/colors"
import { FONT_SANS, SAFE_AREA } from "../constants/layout"

const AUDIO_CARD_SHADOW = (Platform.OS === "web"
  ? {
      boxShadow: "0px 3px 8px rgba(0, 0, 0, 0.06)",
    }
  : {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.06,
      shadowRadius: 8,
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
        <StatusBar barStyle="dark-content" backgroundColor="#F5F5F5" translucent={false} />
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
            <Text style={styles.closeButtonText}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.audioCard}>
          <Pressable
            style={[styles.audioButton, !hasRecording ? styles.audioButtonDisabled : null]}
            onPress={hasRecording ? onToggleRecording : undefined}
            disabled={!hasRecording}
          >
            <Text
              style={[
                styles.audioIcon,
                isPlaying ? styles.audioIconStop : styles.audioIconPlay,
                !hasRecording ? styles.audioIconDisabled : null,
              ]}
            >
              {isPlaying ? "\u25A0" : "\u25B6"}
            </Text>
          </Pressable>
          <View style={styles.audioContent}>
            <View style={styles.audioProgressTrack}>
              <View style={[styles.audioProgressFill, { width: progressWidth }]} />
            </View>
            <View style={styles.audioTimeRow}>
              <Text style={styles.audioTimeText}>{elapsedTime}</Text>
              <Text style={styles.audioTimeText}>{totalTime}</Text>
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
                        <Text style={styles.agentIcon}>{"\u{1F916}"}</Text>
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
                        <Text style={styles.customerAvatarIcon}>{"\u{1F464}"}</Text>
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
    backgroundColor: "#F5F5F5",
    paddingTop: Platform.OS === "android" ? SAFE_AREA.top : 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    backgroundColor: "#F5F5F5",
    gap: 16,
  },
  headerTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: "#1A1A1A",
    fontFamily: FONT_SANS,
  },
  customerMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 6,
  },
  customerName: {
    fontSize: 17,
    fontWeight: "600",
    color: "#1A1A1A",
    fontFamily: FONT_SANS,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 20,
  },
  statusBadgeCompleted: { backgroundColor: "#7B1FA2" },
  statusBadgeProcessing: { backgroundColor: "#1565C0" },
  statusBadgeDefault: { backgroundColor: "#9E9E9E" },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#FFFFFF",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontFamily: FONT_SANS,
  },
  closeButton: {
    backgroundColor: "transparent",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: "#C0C0C0",
    minWidth: 84,
    alignItems: "center",
  },
  closeButtonText: {
    fontSize: 15,
    color: "#1A1A1A",
    fontFamily: FONT_SANS,
  },
  audioCard: {
    marginHorizontal: 16,
    marginBottom: 0,
    padding: 16,
    borderRadius: 16,
    backgroundColor: COLORS.SURFACE,
    ...AUDIO_CARD_SHADOW,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  audioButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#7B1FA2",
    alignItems: "center",
    justifyContent: "center",
  },
  audioButtonDisabled: {
    backgroundColor: "#D7D7D7",
  },
  audioContent: { flex: 1, gap: 10 },
  audioIcon: {
    color: "#FFFFFF",
    textAlign: "center",
    fontFamily: FONT_SANS,
  },
  audioIconPlay: {
    fontSize: 20,
    paddingLeft: 3,
  },
  audioIconStop: {
    fontSize: 18,
  },
  audioIconDisabled: {
    color: "#8A8A8A",
  },
  audioProgressTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#E0E0E0",
    overflow: "hidden",
  },
  audioProgressFill: {
    height: "100%",
    borderRadius: 2,
    backgroundColor: "#7B1FA2",
  },
  audioTimeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  audioTimeText: {
    color: "#888888",
    fontSize: 12,
    fontFamily: FONT_SANS,
  },
  transcriptSectionHeader: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
    backgroundColor: "#F5F5F5",
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#999999",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  sectionDivider: {
    marginTop: 8,
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#E0E0E0",
  },
  transcriptScroll: {
    flex: 1,
    backgroundColor: "#F5F5F5",
  },
  transcriptScrollContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    paddingBottom: SAFE_AREA.bottom + 24,
  },
  transcriptGroup: {
    marginBottom: 20,
  },
  agentHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  agentIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#EDE7F6",
    alignItems: "center",
    justifyContent: "center",
  },
  agentIcon: {
    fontSize: 16,
  },
  agentSpeaker: {
    fontSize: 11,
    fontWeight: "600",
    color: "#888888",
    marginLeft: 8,
    letterSpacing: 0.5,
    fontFamily: FONT_SANS,
  },
  agentBubble: {
    maxWidth: "85%",
    marginLeft: 40,
    padding: 12,
    borderRadius: 16,
    borderTopLeftRadius: 4,
    backgroundColor: "#EDE7F6",
    alignSelf: "flex-start",
  },
  customerSpeaker: {
    fontSize: 11,
    color: "#888888",
    textAlign: "right",
    marginBottom: 4,
    letterSpacing: 0.5,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  customerBubbleRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "flex-end",
  },
  customerBubble: {
    maxWidth: "75%",
    marginRight: 8,
    padding: 12,
    borderRadius: 16,
    borderTopRightRadius: 4,
    backgroundColor: "#EEEEEE",
    alignSelf: "flex-end",
  },
  customerAvatarCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#CCCCCC",
    alignItems: "center",
    justifyContent: "center",
  },
  customerAvatarIcon: {
    fontSize: 16,
    color: "#5F5F5F",
  },
  neutralSpeaker: {
    fontSize: 11,
    fontWeight: "600",
    color: "#888888",
    marginBottom: 4,
    letterSpacing: 0.5,
    fontFamily: FONT_SANS,
  },
  neutralBubble: {
    maxWidth: "84%",
    padding: 12,
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
    alignSelf: "center",
  },
  transcriptMessage: {
    fontSize: 15,
    lineHeight: 22,
    color: "#1A1A1A",
    fontFamily: FONT_SANS,
  },
  transcriptFallback: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 16,
  },
  transcriptFallbackText: {
    fontSize: 15,
    lineHeight: 22,
    color: "#1A1A1A",
    fontFamily: FONT_SANS,
  },
  transcriptEmptyWrap: {
    alignItems: "center",
    paddingVertical: 40,
  },
  transcriptEmpty: {
    fontSize: 14,
    color: "#888888",
    fontFamily: FONT_SANS,
  },
})
