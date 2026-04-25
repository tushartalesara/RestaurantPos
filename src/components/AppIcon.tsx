import { Feather } from "@expo/vector-icons"
import type { ComponentProps } from "react"

export type AppIconName = ComponentProps<typeof Feather>["name"]

type AppIconProps = {
  name: AppIconName
  size?: number
  color: string
}

export function AppIcon({ name, size = 18, color }: AppIconProps) {
  return <Feather name={name} size={size} color={color} />
}
