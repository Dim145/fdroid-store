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
  /** i18n key under `permissions.groups.*`. */
  labelKey: string;
  icon: LucideIcon;
  /** Lower number = appears earlier. Roughly mirrors Play Store's ordering
   *  (sensitive → infrastructure → grab-bag). */
  order: number;
};

export const PERMISSION_GROUPS: Record<PermissionGroupKey, PermissionGroup> = {
  CONTACTS:      { labelKey: "permissions.groups.CONTACTS",      icon: Contact,       order: 10 },
  LOCATION:      { labelKey: "permissions.groups.LOCATION",      icon: MapPin,        order: 20 },
  CAMERA:        { labelKey: "permissions.groups.CAMERA",        icon: Camera,        order: 30 },
  MICROPHONE:    { labelKey: "permissions.groups.MICROPHONE",    icon: Mic,           order: 40 },
  PHONE:         { labelKey: "permissions.groups.PHONE",         icon: Phone,         order: 50 },
  SMS:           { labelKey: "permissions.groups.SMS",           icon: MessageSquare, order: 60 },
  CALENDAR:      { labelKey: "permissions.groups.CALENDAR",      icon: Calendar,      order: 70 },
  STORAGE:       { labelKey: "permissions.groups.STORAGE",       icon: Folder,        order: 80 },
  MEDIA:         { labelKey: "permissions.groups.MEDIA",         icon: ImageIcon,     order: 90 },
  SENSORS:       { labelKey: "permissions.groups.SENSORS",       icon: Activity,      order: 100 },
  ACTIVITY:      { labelKey: "permissions.groups.ACTIVITY",      icon: Activity,      order: 110 },
  NOTIFICATIONS: { labelKey: "permissions.groups.NOTIFICATIONS", icon: Bell,          order: 120 },
  BLUETOOTH:     { labelKey: "permissions.groups.BLUETOOTH",     icon: Bluetooth,     order: 130 },
  NETWORK:       { labelKey: "permissions.groups.NETWORK",       icon: Wifi,          order: 140 },
  SYSTEM:        { labelKey: "permissions.groups.SYSTEM",        icon: Settings,      order: 150 },
  OTHER:         { labelKey: "permissions.groups.OTHER",         icon: FileQuestion,  order: 999 },
};

/** Curated mapping from Android permission constants to a group + a short
 *  identifier matching the i18n key under `permissions.items.*`. Anything not
 *  in this table falls through to OTHER with a humanised version of the
 *  constant name (no translation key). */
const KNOWN: Record<string, { group: PermissionGroupKey; key: string }> = {
  // — Contacts & accounts ----------------------------------------------------
  "android.permission.READ_CONTACTS":        { group: "CONTACTS",  key: "READ_CONTACTS" },
  "android.permission.WRITE_CONTACTS":       { group: "CONTACTS",  key: "WRITE_CONTACTS" },
  "android.permission.GET_ACCOUNTS":         { group: "CONTACTS",  key: "GET_ACCOUNTS" },

  // — Location ---------------------------------------------------------------
  "android.permission.ACCESS_FINE_LOCATION":       { group: "LOCATION", key: "ACCESS_FINE_LOCATION" },
  "android.permission.ACCESS_COARSE_LOCATION":     { group: "LOCATION", key: "ACCESS_COARSE_LOCATION" },
  "android.permission.ACCESS_BACKGROUND_LOCATION": { group: "LOCATION", key: "ACCESS_BACKGROUND_LOCATION" },

  // — Camera & mic -----------------------------------------------------------
  "android.permission.CAMERA":              { group: "CAMERA",     key: "CAMERA" },
  "android.permission.RECORD_AUDIO":        { group: "MICROPHONE", key: "RECORD_AUDIO" },

  // — Phone ------------------------------------------------------------------
  "android.permission.READ_PHONE_STATE":    { group: "PHONE", key: "READ_PHONE_STATE" },
  "android.permission.READ_PHONE_NUMBERS":  { group: "PHONE", key: "READ_PHONE_NUMBERS" },
  "android.permission.CALL_PHONE":          { group: "PHONE", key: "CALL_PHONE" },
  "android.permission.ANSWER_PHONE_CALLS":  { group: "PHONE", key: "ANSWER_PHONE_CALLS" },
  "android.permission.READ_CALL_LOG":       { group: "PHONE", key: "READ_CALL_LOG" },
  "android.permission.WRITE_CALL_LOG":      { group: "PHONE", key: "WRITE_CALL_LOG" },

  // — SMS --------------------------------------------------------------------
  "android.permission.READ_SMS":            { group: "SMS", key: "READ_SMS" },
  "android.permission.SEND_SMS":            { group: "SMS", key: "SEND_SMS" },
  "android.permission.RECEIVE_SMS":         { group: "SMS", key: "RECEIVE_SMS" },
  "android.permission.RECEIVE_MMS":         { group: "SMS", key: "RECEIVE_MMS" },

  // — Calendar ---------------------------------------------------------------
  "android.permission.READ_CALENDAR":       { group: "CALENDAR", key: "READ_CALENDAR" },
  "android.permission.WRITE_CALENDAR":      { group: "CALENDAR", key: "WRITE_CALENDAR" },

  // — Storage ----------------------------------------------------------------
  "android.permission.READ_EXTERNAL_STORAGE":   { group: "STORAGE", key: "READ_EXTERNAL_STORAGE" },
  "android.permission.WRITE_EXTERNAL_STORAGE":  { group: "STORAGE", key: "WRITE_EXTERNAL_STORAGE" },
  "android.permission.MANAGE_EXTERNAL_STORAGE": { group: "STORAGE", key: "MANAGE_EXTERNAL_STORAGE" },

  // — Media (Android 13+) ----------------------------------------------------
  "android.permission.READ_MEDIA_IMAGES":     { group: "MEDIA", key: "READ_MEDIA_IMAGES" },
  "android.permission.READ_MEDIA_VIDEO":      { group: "MEDIA", key: "READ_MEDIA_VIDEO" },
  "android.permission.READ_MEDIA_AUDIO":      { group: "MEDIA", key: "READ_MEDIA_AUDIO" },
  "android.permission.ACCESS_MEDIA_LOCATION": { group: "MEDIA", key: "ACCESS_MEDIA_LOCATION" },

  // — Sensors / fitness ------------------------------------------------------
  "android.permission.BODY_SENSORS":            { group: "SENSORS",  key: "BODY_SENSORS" },
  "android.permission.BODY_SENSORS_BACKGROUND": { group: "SENSORS",  key: "BODY_SENSORS_BACKGROUND" },
  "android.permission.ACTIVITY_RECOGNITION":    { group: "ACTIVITY", key: "ACTIVITY_RECOGNITION" },

  // — Notifications ----------------------------------------------------------
  "android.permission.POST_NOTIFICATIONS":  { group: "NOTIFICATIONS", key: "POST_NOTIFICATIONS" },

  // — Bluetooth --------------------------------------------------------------
  "android.permission.BLUETOOTH":            { group: "BLUETOOTH", key: "BLUETOOTH" },
  "android.permission.BLUETOOTH_ADMIN":      { group: "BLUETOOTH", key: "BLUETOOTH_ADMIN" },
  "android.permission.BLUETOOTH_CONNECT":    { group: "BLUETOOTH", key: "BLUETOOTH_CONNECT" },
  "android.permission.BLUETOOTH_SCAN":       { group: "BLUETOOTH", key: "BLUETOOTH_SCAN" },
  "android.permission.BLUETOOTH_ADVERTISE":  { group: "BLUETOOTH", key: "BLUETOOTH_ADVERTISE" },

  // — Network ----------------------------------------------------------------
  "android.permission.INTERNET":             { group: "NETWORK", key: "INTERNET" },
  "android.permission.ACCESS_NETWORK_STATE": { group: "NETWORK", key: "ACCESS_NETWORK_STATE" },
  "android.permission.ACCESS_WIFI_STATE":    { group: "NETWORK", key: "ACCESS_WIFI_STATE" },
  "android.permission.CHANGE_WIFI_STATE":    { group: "NETWORK", key: "CHANGE_WIFI_STATE" },
  "android.permission.CHANGE_NETWORK_STATE": { group: "NETWORK", key: "CHANGE_NETWORK_STATE" },
  "android.permission.NEARBY_WIFI_DEVICES":  { group: "NETWORK", key: "NEARBY_WIFI_DEVICES" },

  // — System & device --------------------------------------------------------
  "android.permission.WAKE_LOCK":                          { group: "SYSTEM", key: "WAKE_LOCK" },
  "android.permission.RECEIVE_BOOT_COMPLETED":             { group: "SYSTEM", key: "RECEIVE_BOOT_COMPLETED" },
  "android.permission.FOREGROUND_SERVICE":                 { group: "SYSTEM", key: "FOREGROUND_SERVICE" },
  "android.permission.FOREGROUND_SERVICE_DATA_SYNC":       { group: "SYSTEM", key: "FOREGROUND_SERVICE_DATA_SYNC" },
  "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK":  { group: "SYSTEM", key: "FOREGROUND_SERVICE_MEDIA_PLAYBACK" },
  "android.permission.FOREGROUND_SERVICE_SPECIAL_USE":     { group: "SYSTEM", key: "FOREGROUND_SERVICE_SPECIAL_USE" },
  "android.permission.FOREGROUND_SERVICE_LOCATION":        { group: "SYSTEM", key: "FOREGROUND_SERVICE_LOCATION" },
  "android.permission.FOREGROUND_SERVICE_CAMERA":          { group: "SYSTEM", key: "FOREGROUND_SERVICE_CAMERA" },
  "android.permission.FOREGROUND_SERVICE_MICROPHONE":      { group: "SYSTEM", key: "FOREGROUND_SERVICE_MICROPHONE" },
  "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE":{ group: "SYSTEM", key: "FOREGROUND_SERVICE_CONNECTED_DEVICE" },
  "android.permission.FOREGROUND_SERVICE_PHONE_CALL":      { group: "SYSTEM", key: "FOREGROUND_SERVICE_PHONE_CALL" },
  "android.permission.FOREGROUND_SERVICE_HEALTH":          { group: "SYSTEM", key: "FOREGROUND_SERVICE_HEALTH" },
  "android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING":{ group: "SYSTEM", key: "FOREGROUND_SERVICE_REMOTE_MESSAGING" },
  "android.permission.FOREGROUND_SERVICE_SYSTEM_EXEMPTED": { group: "SYSTEM", key: "FOREGROUND_SERVICE_SYSTEM_EXEMPTED" },
  "android.permission.VIBRATE":                            { group: "SYSTEM", key: "VIBRATE" },
  "android.permission.FLASHLIGHT":                         { group: "SYSTEM", key: "FLASHLIGHT" },
  "android.permission.MODIFY_AUDIO_SETTINGS":              { group: "SYSTEM", key: "MODIFY_AUDIO_SETTINGS" },
  "android.permission.DISABLE_KEYGUARD":                   { group: "SYSTEM", key: "DISABLE_KEYGUARD" },
  "android.permission.TURN_SCREEN_ON":                     { group: "SYSTEM", key: "TURN_SCREEN_ON" },
  "android.permission.USE_FULL_SCREEN_INTENT":             { group: "SYSTEM", key: "USE_FULL_SCREEN_INTENT" },
  "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS": { group: "SYSTEM", key: "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" },
  "android.permission.SYSTEM_ALERT_WINDOW":                { group: "SYSTEM", key: "SYSTEM_ALERT_WINDOW" },
  "android.permission.READ_LOGS":                          { group: "SYSTEM", key: "READ_LOGS" },
  "android.permission.REQUEST_INSTALL_PACKAGES":           { group: "SYSTEM", key: "REQUEST_INSTALL_PACKAGES" },
  "android.permission.REQUEST_DELETE_PACKAGES":            { group: "SYSTEM", key: "REQUEST_DELETE_PACKAGES" },
  "android.permission.QUERY_ALL_PACKAGES":                 { group: "SYSTEM", key: "QUERY_ALL_PACKAGES" },
  "android.permission.SCHEDULE_EXACT_ALARM":               { group: "SYSTEM", key: "SCHEDULE_EXACT_ALARM" },
  "android.permission.USE_EXACT_ALARM":                    { group: "SYSTEM", key: "USE_EXACT_ALARM" },
  "android.permission.SET_WALLPAPER":                      { group: "SYSTEM", key: "SET_WALLPAPER" },
  "android.permission.SET_WALLPAPER_HINTS":                { group: "SYSTEM", key: "SET_WALLPAPER_HINTS" },
  "android.permission.EXPAND_STATUS_BAR":                  { group: "SYSTEM", key: "EXPAND_STATUS_BAR" },
  "android.permission.REORDER_TASKS":                      { group: "SYSTEM", key: "REORDER_TASKS" },
  "android.permission.KILL_BACKGROUND_PROCESSES":          { group: "SYSTEM", key: "KILL_BACKGROUND_PROCESSES" },
  "android.permission.USE_FINGERPRINT":                    { group: "SYSTEM", key: "USE_FINGERPRINT" },
  "android.permission.USE_BIOMETRIC":                      { group: "SYSTEM", key: "USE_BIOMETRIC" },
  "android.permission.WRITE_SETTINGS":                     { group: "SYSTEM", key: "WRITE_SETTINGS" },
  "android.permission.READ_SYNC_SETTINGS":                 { group: "SYSTEM", key: "READ_SYNC_SETTINGS" },
  "android.permission.WRITE_SYNC_SETTINGS":                { group: "SYSTEM", key: "WRITE_SYNC_SETTINGS" },
  "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE": { group: "SYSTEM", key: "BIND_NOTIFICATION_LISTENER_SERVICE" },
  "android.permission.BIND_ACCESSIBILITY_SERVICE":         { group: "SYSTEM", key: "BIND_ACCESSIBILITY_SERVICE" },
  "android.permission.BIND_DEVICE_ADMIN":                  { group: "SYSTEM", key: "BIND_DEVICE_ADMIN" },
  "android.permission.BIND_INPUT_METHOD":                  { group: "SYSTEM", key: "BIND_INPUT_METHOD" },
};

export type ResolvedPermission = {
  group: PermissionGroupKey;
  /** Translation key under `permissions.items` for curated entries, or null
   *  when the permission isn't in the curated table. */
  i18nKey: string | null;
  /** Best-effort English fallback (humanised constant name). Used when
   *  `i18nKey` is null, and as the `defaultValue` for missing translations. */
  fallbackText: string;
  /** The original constant, used as a `<li>` key and a tooltip fallback. */
  raw: string;
};

/** Look a permission up; if not in the curated table, fall back to a
 *  best-effort humanisation of its short name (snake_case → " "). */
export function resolvePermission(raw: string): ResolvedPermission {
  const known = KNOWN[raw];
  // Strip the platform/vendor namespace so a permission like
  // ``org.codeaurora.permission.power_off_alarm`` renders as "Power off
  // alarm" instead of leaking the full constant path.
  let short = raw;
  if (short.startsWith("android.permission.")) {
    short = short.slice("android.permission.".length);
  } else {
    const idx = short.lastIndexOf(".permission.");
    if (idx !== -1) short = short.slice(idx + ".permission.".length);
    else {
      const dot = short.lastIndexOf(".");
      if (dot !== -1) short = short.slice(dot + 1);
    }
  }
  const humanised = short
    .toLowerCase()
    .replace(/_/g, " ")
    // Re-capitalise the very first word to feel like a sentence
    .replace(/^./, (c) => c.toUpperCase());
  if (known) {
    return {
      group: known.group,
      i18nKey: `permissions.items.${known.key}`,
      fallbackText: humanised,
      raw,
    };
  }
  return { group: "OTHER", i18nKey: null, fallbackText: humanised, raw };
}

/** Group an arbitrary list of permission constants. Items inside each group
 *  are sorted by their raw constant for deterministic order across locales;
 *  the consumer is free to re-sort by translated text if needed. */
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
      items: items.sort((a, b) => a.raw.localeCompare(b.raw)),
    }))
    .sort((a, b) => a.group.order - b.group.order);
}

// Re-exported only so callers can type-narrow if needed.
export { type LucideIcon };
// Keep ShieldAlert / Battery / CircleHelp imports referenced even if a
// future trim deletes their usage in the map above — Tailwind's tree-shake
// is fine but TS would warn on unused imports.
export const _icons = { ShieldAlert, Battery, CircleHelp };
