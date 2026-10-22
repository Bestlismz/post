import { Bot, Building2, ChevronDown, Inbox, Search, Settings, SlidersHorizontal, UsersRound, Wifi, WifiOff, Zap } from "lucide-react";

const icons = {
  automations: Zap,
  bot: Bot,
  chevronDown: ChevronDown,
  inbox: Inbox,
  properties: Building2,
  search: Search,
  settings: Settings,
  sliders: SlidersHorizontal,
  sources: UsersRound,
  connected: Wifi,
  disconnected: WifiOff,
};

export function AppIcon({ name, label, size = 20, strokeWidth = 1.8, ...props }) {
  const Glyph = icons[name];
  if (!Glyph) return null;
  return <Glyph aria-hidden={label ? undefined : "true"} aria-label={label} focusable="false" size={size} strokeWidth={strokeWidth} {...props} />;
}
