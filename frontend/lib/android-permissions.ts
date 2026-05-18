import {
  Activity,
  Battery,
  Bell,
  Bluetooth,
  Calendar,
  Camera,
  CircleHelp,
  Contact,
  FileQuestion,
  Folder,
  Image as ImageIcon,
  Mic,
  MapPin,
  Phone,
  type LucideIcon,
  MessageSquare,
  Settings,
  ShieldAlert,
  Wifi,
} from "lucide-react";

export type PermissionGroupKey =
  | "CONTACTS"
  | "LOCATION"
  | "CAMERA"
  | "MICROPHONE"
  | "PHONE"
  | "SMS"
  | "CALENDAR"
  | "STORAGE"
  | "MEDIA"
  | "SENSORS"
  | "ACTIVITY"
  | "NOTIFICATIONS"
  | "BLUETOOTH"
  | "NETWORK"
  | "SYSTEM"
  | "OTHER";

export type PermissionGroup = {
  label: string;
  icon: LucideIcon;
  /** Lower number = appears earlier. Roughly mirrors Play Store's ordering
   *  (sensitive → infrastructure → grab-bag). */
  order: number;
};

export const PERMISSION_GROUPS: Record<PermissionGroupKey, PermissionGroup> = {
  CONTACTS:      { label: "Contacts",           icon: Contact,        order: 10 },
  LOCATION:      { label: "Location",           icon: MapPin,         order: 20 },
  CAMERA:        { label: "Camera",             icon: Camera,         order: 30 },
  MICROPHONE:    { label: "Microphone",         icon: Mic,            order: 40 },
  PHONE:         { label: "Phone",              icon: Phone,          order: 50 },
  SMS:           { label: "SMS & Messages",     icon: MessageSquare,  order: 60 },
  CALENDAR:      { label: "Calendar",           icon: Calendar,       order: 70 },
  STORAGE:       { label: "Storage",            icon: Folder,         order: 80 },
  MEDIA:         { label: "Photos / Media",     icon: ImageIcon,      order: 90 },
  SENSORS:       { label: "Body sensors",       icon: Activity,       order: 100 },
  ACTIVITY:      { label: "Physical activity",  icon: Activity,       order: 110 },
  NOTIFICATIONS: { label: "Notifications",      icon: Bell,           order: 120 },
  BLUETOOTH:     { label: "Bluetooth",          icon: Bluetooth,      order: 130 },
  NETWORK:       { label: "Network & Wi-Fi",    icon: Wifi,           order: 140 },
  SYSTEM:        { label: "Device & System",    icon: Settings,       order: 150 },
  OTHER:         { label: "Other",              icon: FileQuestion,   order: 999 },
};

/** Curated mapping from Android permission constants to a group + a short
 *  human sentence. Sources: Android developer docs + a quick pass over the
 *  Play Store wording. Anything not in this table falls through to OTHER
 *  with a humanised version of the constant name. */
const KNOWN: Record<string, { group: PermissionGroupKey; text: string }> = {
  // — Contacts & accounts ----------------------------------------------------
  "android.permission.READ_CONTACTS":        { group: "CONTACTS",  text: "read your contacts" },
  "android.permission.WRITE_CONTACTS":       { group: "CONTACTS",  text: "modify your contacts" },
  "android.permission.GET_ACCOUNTS":         { group: "CONTACTS",  text: "find accounts on the device" },

  // — Location ---------------------------------------------------------------
  "android.permission.ACCESS_FINE_LOCATION":      { group: "LOCATION", text: "access precise location (GPS-level)" },
  "android.permission.ACCESS_COARSE_LOCATION":    { group: "LOCATION", text: "access approximate location" },
  "android.permission.ACCESS_BACKGROUND_LOCATION":{ group: "LOCATION", text: "access location while in the background" },

  // — Camera & mic -----------------------------------------------------------
  "android.permission.CAMERA":              { group: "CAMERA",     text: "take pictures and record video" },
  "android.permission.RECORD_AUDIO":        { group: "MICROPHONE", text: "record audio" },

  // — Phone ------------------------------------------------------------------
  "android.permission.READ_PHONE_STATE":    { group: "PHONE", text: "read phone state and identity" },
  "android.permission.READ_PHONE_NUMBERS":  { group: "PHONE", text: "read the device's phone numbers" },
  "android.permission.CALL_PHONE":          { group: "PHONE", text: "place phone calls" },
  "android.permission.ANSWER_PHONE_CALLS":  { group: "PHONE", text: "answer phone calls" },
  "android.permission.READ_CALL_LOG":       { group: "PHONE", text: "read the call log" },
  "android.permission.WRITE_CALL_LOG":      { group: "PHONE", text: "modify the call log" },

  // — SMS --------------------------------------------------------------------
  "android.permission.READ_SMS":            { group: "SMS", text: "read your text messages" },
  "android.permission.SEND_SMS":            { group: "SMS", text: "send SMS messages" },
  "android.permission.RECEIVE_SMS":         { group: "SMS", text: "receive SMS messages" },
  "android.permission.RECEIVE_MMS":         { group: "SMS", text: "receive MMS messages" },

  // — Calendar ---------------------------------------------------------------
  "android.permission.READ_CALENDAR":       { group: "CALENDAR", text: "read your calendar" },
  "android.permission.WRITE_CALENDAR":      { group: "CALENDAR", text: "modify your calendar" },

  // — Storage ----------------------------------------------------------------
  "android.permission.READ_EXTERNAL_STORAGE":   { group: "STORAGE", text: "read shared storage" },
  "android.permission.WRITE_EXTERNAL_STORAGE":  { group: "STORAGE", text: "modify or delete shared storage" },
  "android.permission.MANAGE_EXTERNAL_STORAGE": { group: "STORAGE", text: "manage all files on the device" },

  // — Media (Android 13+) ----------------------------------------------------
  "android.permission.READ_MEDIA_IMAGES":   { group: "MEDIA", text: "read photos" },
  "android.permission.READ_MEDIA_VIDEO":    { group: "MEDIA", text: "read videos" },
  "android.permission.READ_MEDIA_AUDIO":    { group: "MEDIA", text: "read music & audio" },
  "android.permission.ACCESS_MEDIA_LOCATION": { group: "MEDIA", text: "read location metadata from photos" },

  // — Sensors / fitness ------------------------------------------------------
  "android.permission.BODY_SENSORS":            { group: "SENSORS",  text: "read body sensors (heart rate, etc.)" },
  "android.permission.BODY_SENSORS_BACKGROUND": { group: "SENSORS",  text: "read body sensors in the background" },
  "android.permission.ACTIVITY_RECOGNITION":    { group: "ACTIVITY", text: "recognise physical activity" },

  // — Notifications ----------------------------------------------------------
  "android.permission.POST_NOTIFICATIONS":  { group: "NOTIFICATIONS", text: "show notifications" },

  // — Bluetooth --------------------------------------------------------------
  "android.permission.BLUETOOTH":            { group: "BLUETOOTH", text: "pair with Bluetooth devices" },
  "android.permission.BLUETOOTH_ADMIN":      { group: "BLUETOOTH", text: "access Bluetooth settings" },
  "android.permission.BLUETOOTH_CONNECT":    { group: "BLUETOOTH", text: "connect to paired Bluetooth devices" },
  "android.permission.BLUETOOTH_SCAN":       { group: "BLUETOOTH", text: "discover and pair Bluetooth devices" },
  "android.permission.BLUETOOTH_ADVERTISE":  { group: "BLUETOOTH", text: "broadcast Bluetooth signals" },

  // — Network ----------------------------------------------------------------
  "android.permission.INTERNET":             { group: "NETWORK", text: "have full network access" },
  "android.permission.ACCESS_NETWORK_STATE": { group: "NETWORK", text: "view network connections" },
  "android.permission.ACCESS_WIFI_STATE":    { group: "NETWORK", text: "view Wi-Fi connections" },
  "android.permission.CHANGE_WIFI_STATE":    { group: "NETWORK", text: "connect and disconnect from Wi-Fi" },
  "android.permission.CHANGE_NETWORK_STATE": { group: "NETWORK", text: "change network connectivity" },
  "android.permission.NEARBY_WIFI_DEVICES":  { group: "NETWORK", text: "find nearby Wi-Fi devices" },

  // — System & device --------------------------------------------------------
  "android.permission.WAKE_LOCK":              { group: "SYSTEM", text: "prevent the device from sleeping" },
  "android.permission.RECEIVE_BOOT_COMPLETED": { group: "SYSTEM", text: "run at startup" },
  "android.permission.FOREGROUND_SERVICE":     { group: "SYSTEM", text: "run a foreground service" },
  "android.permission.FOREGROUND_SERVICE_DATA_SYNC": { group: "SYSTEM", text: "run a background sync service" },
  "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK": { group: "SYSTEM", text: "run a media-playback service" },
  "android.permission.VIBRATE":                { group: "SYSTEM", text: "control vibration" },
  "android.permission.MODIFY_AUDIO_SETTINGS":  { group: "SYSTEM", text: "modify audio settings" },
  "android.permission.DISABLE_KEYGUARD":       { group: "SYSTEM", text: "disable the screen lock" },
  "android.permission.SYSTEM_ALERT_WINDOW":    { group: "SYSTEM", text: "display on top of other apps" },
  "android.permission.READ_LOGS":              { group: "SYSTEM", text: "read system logs" },
  "android.permission.REQUEST_INSTALL_PACKAGES": { group: "SYSTEM", text: "install other apps" },
  "android.permission.QUERY_ALL_PACKAGES":     { group: "SYSTEM", text: "list every app installed on the device" },
  "android.permission.SCHEDULE_EXACT_ALARM":   { group: "SYSTEM", text: "schedule exact alarms" },
  "android.permission.USE_EXACT_ALARM":        { group: "SYSTEM", text: "use exact alarms" },
  "android.permission.SET_WALLPAPER":          { group: "SYSTEM", text: "set the wallpaper" },
  "android.permission.EXPAND_STATUS_BAR":      { group: "SYSTEM", text: "expand or collapse the status bar" },
  "android.permission.REORDER_TASKS":          { group: "SYSTEM", text: "reorder running apps" },
  "android.permission.KILL_BACKGROUND_PROCESSES": { group: "SYSTEM", text: "close other apps in the background" },
  "android.permission.USE_FINGERPRINT":        { group: "SYSTEM", text: "use the fingerprint sensor" },
  "android.permission.USE_BIOMETRIC":          { group: "SYSTEM", text: "use biometric authentication" },
  "android.permission.WRITE_SETTINGS":         { group: "SYSTEM", text: "modify system settings" },
  "android.permission.READ_SYNC_SETTINGS":     { group: "SYSTEM", text: "read sync settings" },
  "android.permission.WRITE_SYNC_SETTINGS":    { group: "SYSTEM", text: "modify sync settings" },
  "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE": { group: "SYSTEM", text: "read your notifications" },
};

export type ResolvedPermission = {
  group: PermissionGroupKey;
  text: string;
  /** The original constant, used as a `<li>` key and a tooltip fallback. */
  raw: string;
};

/** Look a permission up; if not in the curated table, fall back to a
 *  best-effort humanisation of its short name (snake_case → " "). */
export function resolvePermission(raw: string): ResolvedPermission {
  const known = KNOWN[raw];
  if (known) return { ...known, raw };

  const short = raw.startsWith("android.permission.")
    ? raw.slice("android.permission.".length)
    : raw;
  const humanised = short
    .toLowerCase()
    .replace(/_/g, " ")
    // Re-capitalise the very first word to feel like a sentence
    .replace(/^./, (c) => c.toUpperCase());
  return { group: "OTHER", text: humanised, raw };
}

/** Group + sort an arbitrary list of permission constants in one pass.
 *  The result preserves the canonical group order; inside each group the
 *  permissions are alphabetised so reloads don't reorder the page. */
export function groupPermissions(
  permissions: readonly string[],
): Array<{ key: PermissionGroupKey; group: PermissionGroup; items: ResolvedPermission[] }> {
  const buckets = new Map<PermissionGroupKey, ResolvedPermission[]>();
  for (const raw of permissions) {
    const resolved = resolvePermission(raw);
    const bucket = buckets.get(resolved.group);
    if (bucket) bucket.push(resolved);
    else buckets.set(resolved.group, [resolved]);
  }
  return Array.from(buckets.entries())
    .map(([key, items]) => ({
      key,
      group: PERMISSION_GROUPS[key],
      items: items.sort((a, b) => a.text.localeCompare(b.text)),
    }))
    .sort((a, b) => a.group.order - b.group.order);
}

// Re-exported only so callers can type-narrow if needed.
export { type LucideIcon };
// Keep ShieldAlert / Battery / CircleHelp imports referenced even if a
// future trim deletes their usage in the map above — Tailwind's tree-shake
// is fine but TS would warn on unused imports.
export const _icons = { ShieldAlert, Battery, CircleHelp };
