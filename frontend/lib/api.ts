/**
 * Thin fetch client around the FastAPI backend.
 *
 * All public functions are async, throw `ApiError` on non-2xx, and
 * transparently refresh the access token once on 401.
 */

// Default to relative URLs so the same static build can be served from any
// origin — the SPA, the API and the F-Droid repo all live behind a single
// nginx that routes ``/api/``, ``/fdroid/`` and ``/r/`` to the backend.
//
// The env vars are kept as overrides for split deployments (CDN front,
// distinct API domain, …) but should be left empty for the default
// single-origin Docker image so the image is reusable across hosts.
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "";

export const REPO_URL =
  process.env.NEXT_PUBLIC_REPO_URL?.replace(/\/$/, "") || "/fdroid/repo";

/** Build a full URL for a storage key served under the F-Droid repo path.
 *  Storage keys mirror the repo URL layout (icons/foo.png →
 *  /fdroid/repo/icons/foo.png). Versioning via a query param helps browsers
 *  pick up icon swaps without a hard refresh. */
export function mediaUrl(storageKey: string | null | undefined, version?: number | string): string | null {
  if (!storageKey) return null;
  const v = version != null ? `?v=${encodeURIComponent(String(version))}` : "";
  return `${REPO_URL}/${storageKey}${v}`;
}

const ACCESS_TOKEN_KEY = "fdroid.access";
const REFRESH_TOKEN_KEY = "fdroid.refresh";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setTokens(access: string, refresh: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ACCESS_TOKEN_KEY, access);
  window.localStorage.setItem(REFRESH_TOKEN_KEY, refresh);
}

export function clearTokens(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_TOKEN_KEY);
}

type FetchOptions = RequestInit & {
  /** When true, do NOT attach the bearer token. */
  anonymous?: boolean;
  /** When true, do NOT attempt the refresh-on-401 dance. */
  noRetry?: boolean;
};

// Single in-flight refresh shared across all concurrent ``apiFetch`` calls.
// Without this dedupe, N parallel 401s each fire their own refresh request;
// the first to land consumes the refresh token, the rest get a 401 back
// and clear tokens — logging the user out mid-session.
let _refreshInflight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (_refreshInflight) return _refreshInflight;
  _refreshInflight = (async () => {
    const refresh = getRefreshToken();
    if (!refresh) return false;
    const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!res.ok) {
      clearTokens();
      return false;
    }
    const data = (await res.json()) as { access_token: string; refresh_token: string };
    setTokens(data.access_token, data.refresh_token);
    return true;
  })();
  try {
    return await _refreshInflight;
  } finally {
    _refreshInflight = null;
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  options: FetchOptions = {}
): Promise<T> {
  const { anonymous, noRetry, headers, ...rest } = options;
  const finalHeaders = new Headers(headers || {});
  if (!finalHeaders.has("content-type") && rest.body && !(rest.body instanceof FormData)) {
    finalHeaders.set("content-type", "application/json");
  }
  // Refuse to attach the bearer to absolute / cross-origin URLs. The current
  // codebase never passes an absolute URL here, but if a future caller wires
  // a user-controlled URL into ``apiFetch`` (a "validate website" feature,
  // say) we don't want the token leaking off-origin.
  const isAbsolute = /^https?:\/\//i.test(path);
  if (!anonymous && !isAbsolute) {
    const token = getAccessToken();
    if (token) finalHeaders.set("authorization", `Bearer ${token}`);
  }

  const url = isAbsolute ? path : `${API_URL}${path}`;
  let res = await fetch(url, { ...rest, headers: finalHeaders });

  if (res.status === 401 && !noRetry && !anonymous) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      const t = getAccessToken();
      if (t) finalHeaders.set("authorization", `Bearer ${t}`);
      res = await fetch(url, { ...rest, headers: finalHeaders });
    }
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown = text;
  if (text && res.headers.get("content-type")?.includes("application/json")) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    if (body && typeof body === "object" && "detail" in body) {
      detail = String((body as { detail: unknown }).detail);
    }
    throw new ApiError(res.status, detail, body);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Typed wrappers
// ---------------------------------------------------------------------------
export type TokenPair = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
};

export type RegistrationPolicy = "public" | "invite" | "closed";

export type AuthMethodsInfo = {
  local: boolean;
  oidc: boolean;
  allow_signup: boolean;
  oidc_login_url: string | null;
  public_mode: boolean;
  registration_policy: RegistrationPolicy;
};

export type CurrentUser = {
  id: string;
  email: string;
  username: string;
  full_name: string | null;
  role: "user" | "admin";
  auth_provider: "local" | "oidc";
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  show_nsfw: boolean;
  preferred_locale: string | null;
  // Per-user quota overrides — ``null`` = fall back to the repo default.
  quota_max_apps?: number | null;
  quota_max_storage_bytes?: number | null;
  quota_max_apks_per_month?: number | null;
};

// Returned by /auth/login when MFA is required. The frontend stores
// ``mfa_token`` in memory, prompts the user for a 6-digit code, then POSTs
// it to /auth/login/mfa to receive the real TokenPair.
export type MfaChallenge = {
  mfa_required: true;
  mfa_token: string;
  expires_in: number;
};

export type LoginResponse = TokenPair | MfaChallenge;

export const api = {
  authMethods: () => apiFetch<AuthMethodsInfo>("/api/v1/auth/methods", { anonymous: true }),
  login: (email: string, password: string) =>
    apiFetch<LoginResponse>("/api/v1/auth/login", {
      method: "POST",
      anonymous: true,
      body: JSON.stringify({ email, password }),
    }),
  signup: (payload: { email: string; username: string; password: string; full_name?: string; invite_code?: string }) =>
    apiFetch<TokenPair>("/api/v1/auth/signup", {
      method: "POST",
      anonymous: true,
      body: JSON.stringify(payload),
    }),
  me: () => apiFetch<CurrentUser>("/api/v1/me"),
  updateMe: (payload: {
    full_name?: string;
    show_nsfw?: boolean;
    preferred_locale?: string | null;
  }) =>
    apiFetch<CurrentUser>("/api/v1/me", { method: "PATCH", body: JSON.stringify(payload) }),
  changePassword: (payload: { current_password: string; new_password: string }) =>
    apiFetch<void>("/api/v1/me/change-password", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  downloadHistory: () =>
    apiFetch<{ items: DownloadHistoryItem[] }>("/api/v1/me/downloads"),

  apiKeys: {
    list: () => apiFetch<Array<ApiKey>>("/api/v1/me/api-keys"),
    create: (payload: ApiKeyCreate) =>
      apiFetch<ApiKeyCreated>("/api/v1/me/api-keys", { method: "POST", body: JSON.stringify(payload) }),
    revoke: (id: string) => apiFetch<void>(`/api/v1/me/api-keys/${id}`, { method: "DELETE" }),
  },

  apps: {
    list: (q?: string) =>
      apiFetch<Array<AppSummary>>(`/api/v1/apps${q ? `?q=${encodeURIComponent(q)}` : ""}`, {
        anonymous: !getAccessToken(),
      }),
    get: (ref: string, opts: { raw?: boolean } = {}) =>
      apiFetch<AppDetail>(
        `/api/v1/apps/${encodeURIComponent(ref)}${opts.raw ? "?raw=true" : ""}`,
        { anonymous: !getAccessToken() },
      ),
    create: (payload: AppCreate) =>
      apiFetch<AppSummary>("/api/v1/apps", { method: "POST", body: JSON.stringify(payload) }),
    createWithApk: (payload: AppCreateWithApk) => {
      const fd = new FormData();
      fd.append("file", payload.file);
      fd.append("name", payload.name);
      if (payload.package_name) fd.append("package_name", payload.package_name);
      if (payload.summary) fd.append("summary", payload.summary);
      if (payload.description) fd.append("description", payload.description);
      if (payload.license) fd.append("license", payload.license);
      if (payload.website) fd.append("website", payload.website);
      if (payload.source_code) fd.append("source_code", payload.source_code);
      if (payload.issue_tracker) fd.append("issue_tracker", payload.issue_tracker);
      if (payload.author_name) fd.append("author_name", payload.author_name);
      if (payload.visibility) fd.append("visibility", payload.visibility);
      return apiFetch<AppDetail>("/api/v1/apps/with-apk", { method: "POST", body: fd });
    },
    update: (id: string, payload: AppUpdatePayload) =>
      apiFetch<AppSummary>(`/api/v1/apps/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
    remove: (id: string) => apiFetch<void>(`/api/v1/apps/${id}`, { method: "DELETE" }),
    uploadApk: (appId: string, file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return apiFetch<Apk>(`/api/v1/apks/upload/${appId}`, { method: "POST", body: fd });
    },
    inspectApk: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return apiFetch<ApkInspect>("/api/v1/apks/inspect", { method: "POST", body: fd });
    },
    deleteApk: (apkId: string) =>
      apiFetch<void>(`/api/v1/apks/${apkId}`, { method: "DELETE" }),
    // Signed, time-limited URL the browser can hit directly via <a href>
    // without triggering the F-Droid Basic-auth pop-up in private mode.
    downloadUrl: (apkId: string) =>
      apiFetch<{ url: string; expires_in: number }>(
        `/api/v1/apks/${apkId}/download-url`,
        { method: "POST" },
      ),
    updateApk: (apkId: string, payload: { whats_new?: Record<string, string> | null; anti_features?: string[] }) =>
      apiFetch<Apk>(`/api/v1/apks/${apkId}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      }),
    myApps: () => apiFetch<Array<AppSummary>>("/api/v1/me/apps"),
    uploadIcon: (appId: string, file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return apiFetch<{ icon_path: string; icon_is_custom: boolean }>(
        `/api/v1/apps/${appId}/icon`,
        { method: "POST", body: fd },
      );
    },
    revertIcon: (appId: string) =>
      apiFetch<void>(`/api/v1/apps/${appId}/icon`, { method: "DELETE" }),
    uploadFeatureGraphic: (appId: string, file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return apiFetch<{ feature_graphic_path: string }>(
        `/api/v1/apps/${appId}/feature-graphic`,
        { method: "POST", body: fd },
      );
    },
    deleteFeatureGraphic: (appId: string) =>
      apiFetch<void>(`/api/v1/apps/${appId}/feature-graphic`, { method: "DELETE" }),
    uploadPromoGraphic: (appId: string, file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return apiFetch<{ promo_graphic_path: string }>(
        `/api/v1/apps/${appId}/promo-graphic`,
        { method: "POST", body: fd },
      );
    },
    deletePromoGraphic: (appId: string) =>
      apiFetch<void>(`/api/v1/apps/${appId}/promo-graphic`, { method: "DELETE" }),
    uploadTvBanner: (appId: string, file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return apiFetch<{ tv_banner_path: string }>(
        `/api/v1/apps/${appId}/tv-banner`,
        { method: "POST", body: fd },
      );
    },
    deleteTvBanner: (appId: string) =>
      apiFetch<void>(`/api/v1/apps/${appId}/tv-banner`, { method: "DELETE" }),
    listScreenshots: (appId: string) =>
      apiFetch<Screenshot[]>(`/api/v1/apps/${appId}/screenshots`, {
        anonymous: !getAccessToken(),
      }),
    uploadScreenshots: (appId: string, files: File[]) => {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      return apiFetch<Screenshot[]>(`/api/v1/apps/${appId}/screenshots`, {
        method: "POST",
        body: fd,
      });
    },
    deleteScreenshot: (appId: string, screenshotId: string) =>
      apiFetch<void>(`/api/v1/apps/${appId}/screenshots/${screenshotId}`, {
        method: "DELETE",
      }),
    reorderScreenshots: (appId: string, orderedIds: string[]) =>
      apiFetch<Array<{ id: string; display_order: number }>>(
        `/api/v1/apps/${appId}/screenshots/reorder`,
        {
          method: "PATCH",
          body: JSON.stringify({ ordered_ids: orderedIds }),
        },
      ),
    upsertLocalization: (
      appId: string,
      locale: string,
      payload: LocalizationUpsert,
    ) =>
      apiFetch<Localization>(
        `/api/v1/apps/${appId}/localizations/${encodeURIComponent(locale)}`,
        { method: "PUT", body: JSON.stringify(payload) },
      ),
    deleteLocalization: (appId: string, locale: string) =>
      apiFetch<void>(
        `/api/v1/apps/${appId}/localizations/${encodeURIComponent(locale)}`,
        { method: "DELETE" },
      ),
  },

  categories: {
    list: () => apiFetch<Array<Category>>("/api/v1/categories", { anonymous: !getAccessToken() }),
    create: (payload: { name: string; description?: string | null }) =>
      apiFetch<Category>("/api/v1/categories", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    update: (id: string, payload: { name?: string; description?: string | null }) =>
      apiFetch<Category>(`/api/v1/categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      }),
    remove: (id: string) =>
      apiFetch<void>(`/api/v1/categories/${id}`, { method: "DELETE" }),
  },

  users: {
    profile: (username: string) =>
      apiFetch<PublicProfile>(`/api/v1/users/${encodeURIComponent(username)}/profile`, {
        anonymous: !getAccessToken(),
      }),
  },

  setup: {
    status: () =>
      apiFetch<SetupStatusResponse>("/api/v1/setup/status", { anonymous: true }),
    wizard: (payload: SetupWizardPayload) =>
      apiFetch<RepoConfigInfo>("/api/v1/setup/wizard", { method: "POST", body: JSON.stringify(payload) }),
    keystoreInfo: () => apiFetch<KeystoreInfo>("/api/v1/setup/keystore"),
  },

  // ---------- Sessions ----------
  sessions: {
    list: () => apiFetch<UserSession[]>("/api/v1/me/sessions"),
    revoke: (id: string) =>
      apiFetch<void>(`/api/v1/me/sessions/${id}`, { method: "DELETE" }),
    revokeAll: () => apiFetch<void>("/api/v1/me/sessions", { method: "DELETE" }),
  },

  // ---------- Quota usage ----------
  quotas: {
    usage: () => apiFetch<QuotaUsage>("/api/v1/me/quotas"),
  },

  // ---------- TOTP ----------
  totp: {
    status: () => apiFetch<TotpStatus>("/api/v1/me/totp/status"),
    setup: () => apiFetch<TotpSetup>("/api/v1/me/totp/setup", { method: "POST" }),
    confirm: (code: string) =>
      apiFetch<{ recovery_codes: string[] }>("/api/v1/me/totp/confirm", {
        method: "POST",
        body: JSON.stringify({ code }),
      }),
    disable: (password: string) =>
      apiFetch<void>("/api/v1/me/totp/disable", {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
  },

  // ---------- 2-step login ----------
  loginMfa: (payload: { mfa_token: string; code: string }) =>
    apiFetch<TokenPair>("/api/v1/auth/login/mfa", {
      method: "POST",
      anonymous: true,
      body: JSON.stringify(payload),
    }),

  // ---------- App-level collaborators ----------
  collaborators: {
    list: (appId: string) =>
      apiFetch<AppCollaborator[]>(`/api/v1/apps/${appId}/collaborators`),
    add: (appId: string, payload: { username?: string; email?: string }) =>
      apiFetch<AppCollaborator>(`/api/v1/apps/${appId}/collaborators`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    remove: (appId: string, collaboratorId: string) =>
      apiFetch<void>(
        `/api/v1/apps/${appId}/collaborators/${collaboratorId}`,
        { method: "DELETE" },
      ),
  },

  // ---------- Upstream metadata.yml import ----------
  importMetadata: (yamlSource: string) =>
    apiFetch<MetadataImportResult>("/api/v1/apps/import-metadata", {
      method: "POST",
      body: JSON.stringify({ yaml: yamlSource }),
    }),

  admin: {
    listUsers: (q?: string) =>
      apiFetch<Array<CurrentUser>>(`/api/v1/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`),
    createUser: (payload: AdminCreateUser) =>
      apiFetch<CurrentUser>("/api/v1/admin/users", { method: "POST", body: JSON.stringify(payload) }),
    updateUser: (id: string, payload: AdminUpdateUser) =>
      apiFetch<CurrentUser>(`/api/v1/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
    deleteUser: (id: string) => apiFetch<void>(`/api/v1/admin/users/${id}`, { method: "DELETE" }),
    listApps: (statusFilter?: string) =>
      apiFetch<Array<AppSummary>>(`/api/v1/admin/apps${statusFilter ? `?status_filter=${statusFilter}` : ""}`),
    updateApp: (id: string, payload: Record<string, unknown>) =>
      apiFetch<AppSummary>(`/api/v1/admin/apps/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
    publishApk: (id: string) =>
      apiFetch<{ status: string }>(`/api/v1/admin/apks/${id}/publish`, { method: "POST" }),
    rejectApk: (id: string, reason: string) =>
      apiFetch<{ status: string }>(
        `/api/v1/admin/apks/${id}/reject?reason=${encodeURIComponent(reason)}`,
        { method: "POST" }
      ),
    deleteApk: (id: string) => apiFetch<void>(`/api/v1/admin/apks/${id}`, { method: "DELETE" }),
    repo: () => apiFetch<RepoConfigInfo>("/api/v1/admin/repo"),
    updateRepo: (payload: Partial<RepoConfigInfo>) =>
      apiFetch<RepoConfigInfo>("/api/v1/admin/repo", { method: "PATCH", body: JSON.stringify(payload) }),
    reindex: () => apiFetch<{ queued: boolean }>("/api/v1/admin/repo/reindex", { method: "POST" }),
    rescanAll: () =>
      apiFetch<RescanResult>("/api/v1/admin/apks/rescan", { method: "POST" }),
    rescanApp: (appId: string) =>
      apiFetch<RescanResult>(`/api/v1/admin/apps/${appId}/rescan`, { method: "POST" }),
    uploadRepoIcon: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return apiFetch<RepoConfigInfo>("/api/v1/admin/repo/icon", { method: "POST", body: fd });
    },
    stats: () =>
      apiFetch<AdminStats>("/api/v1/admin/stats"),
    invites: {
      list: () => apiFetch<InviteCode[]>("/api/v1/admin/invites"),
      create: (payload: { note?: string; expires_in_days?: number }) =>
        apiFetch<InviteCode>("/api/v1/admin/invites", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      revoke: (id: string) =>
        apiFetch<void>(`/api/v1/admin/invites/${id}`, { method: "DELETE" }),
    },
    // Audit log paged view; ``action`` is a prefix filter (e.g. ``user.``).
    auditLog: (params: { action?: string; target_type?: string; actor_id?: string; limit?: number; offset?: number } = {}) => {
      const qs = new URLSearchParams();
      if (params.action) qs.set("action", params.action);
      if (params.target_type) qs.set("target_type", params.target_type);
      if (params.actor_id) qs.set("actor_id", params.actor_id);
      qs.set("limit", String(params.limit ?? 50));
      qs.set("offset", String(params.offset ?? 0));
      return apiFetch<AuditLogPage>(`/api/v1/admin/audit?${qs}`);
    },
    jobs: () => apiFetch<JobsSnapshot>("/api/v1/admin/jobs"),
    clamavPing: () =>
      apiFetch<{ ok: boolean; configured: boolean }>("/api/v1/admin/clamav/ping"),
    clamavScanNow: () =>
      apiFetch<{ queued: boolean }>("/api/v1/admin/clamav/scan-now", { method: "POST" }),
    scans: (params: { limit?: number; only_infected?: boolean } = {}) => {
      const qs = new URLSearchParams();
      qs.set("limit", String(params.limit ?? 50));
      if (params.only_infected) qs.set("only_infected", "true");
      return apiFetch<ApkScanRow[]>(`/api/v1/admin/scans?${qs}`);
    },
  },
};

export type RescanResult = {
  rescanned_apks: number;
  icons_refreshed: number;
  failed: string[];
};

export type SetupStatusResponse = {
  setup_complete: boolean;
  keystore_present: boolean;
  has_users: boolean;
  public_mode: boolean;
  repo_name: string | null;
  repo_description: string | null;
  repo_address: string | null;
  repo_icon_path: string | null;
  repo_fingerprint: string | null;
};

// ---------------------------------------------------------------------------
// Domain types (matching the backend Pydantic models)
// ---------------------------------------------------------------------------
export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  can_download_private: boolean;
  can_manage_apps: boolean;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};
export type ApiKeyCreate = {
  name: string;
  can_download_private?: boolean;
  can_manage_apps?: boolean;
  expires_in_days?: number;
};
export type ApiKeyCreated = ApiKey & { full_key: string };

export type Category = {
  id: string;
  name: string;
  description: string | null;
  /** Number of apps that reference this category. Populated by the admin
   *  list endpoint; defaulted to 0 when the category comes back embedded
   *  in another payload (e.g. ``AppRead.categories``). */
  app_count?: number;
};

export type AppSummary = {
  id: string;
  package_name: string;
  name: string;
  summary: string | null;
  description: string | null;
  license: string | null;
  website: string | null;
  source_code: string | null;
  issue_tracker: string | null;
  author_name: string | null;
  author_email: string | null;
  donate: string | null;
  liberapay: string | null;
  bitcoin: string | null;
  open_collective: string | null;
  translation: string | null;
  icon_path: string | null;
  icon_is_custom: boolean;
  feature_graphic_path: string | null;
  promo_graphic_path: string | null;
  tv_banner_path: string | null;
  visibility: "public" | "private";
  status: "draft" | "pending_review" | "published" | "rejected" | "archived";
  suggested_version_code: number | null;
  suggested_version_name: string | null;
  suggested_version_is_manual: boolean;
  locked_signer_sha256: string | null;
  last_published_at: string | null;
  created_at: string;
  updated_at: string;
  categories: Category[];
  is_nsfw: boolean;
};

export type Screenshot = {
  id: string;
  storage_key: string;
  sha256: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  locale: string;
  display_order: number;
};

export type Apk = {
  id: string;
  app_id: string;
  file_name: string;
  size_bytes: number;
  sha256: string;
  version_code: number;
  version_name: string;
  min_sdk: number | null;
  target_sdk: number | null;
  signer_sha256: string;
  permissions: string[];
  native_code: string[];
  anti_features: string[];
  status: "uploaded" | "parsed" | "pending_review" | "published" | "rejected" | "deleted";
  rejection_reason: string | null;
  whats_new: Record<string, string> | null;
  published_at: string | null;
  created_at: string;
};

export type Localization = {
  locale: string;
  name: string | null;
  summary: string | null;
  description: string | null;
  video: string | null;
};

export type LocalizationUpsert = {
  name?: string | null;
  summary?: string | null;
  description?: string | null;
  video?: string | null;
};

export type AppDetail = AppSummary & {
  apks: Apk[];
  screenshots: Screenshot[];
  localizations: Localization[];
  owner_id: string | null;
  owner_username: string | null;
  download_count: number;
};

export type PublicProfile = {
  username: string;
  full_name: string | null;
  member_since: string;
  apps: AppSummary[];
};
export type AppCreate = {
  package_name: string;
  name: string;
  summary?: string;
  description?: string;
  license?: string;
  website?: string;
  source_code?: string;
  issue_tracker?: string;
  author_name?: string;
  author_email?: string;
  donate?: string;
  liberapay?: string;
  bitcoin?: string;
  open_collective?: string;
  translation?: string;
  visibility?: "public" | "private";
  category_ids?: string[];
};
export type AppCreateWithApk = Omit<AppCreate, "package_name" | "category_ids"> & {
  package_name?: string;
  file: File;
};
export type AppUpdatePayload = Partial<Omit<AppCreate, "package_name">> & {
  /** Pin (number) or clear (null) the suggested version. Omit the field
   *  entirely to leave the current state alone. */
  suggested_version_code?: number | null;
};

export type ApkInspect = {
  package_name: string;
  app_name: string | null;
  version_code: number;
  version_name: string;
  min_sdk: number | null;
  target_sdk: number | null;
  sha256: string;
  size_bytes: number;
  signer_sha256: string;
  permissions: string[];
  native_code: string[];
  has_icon: boolean;
  /** Heuristic anti-feature scan results from the backend. Keys are
   *  anti-feature slugs (``Tracking``, ``NonFreeNet``, …); values are
   *  human labels for the libraries that triggered each flag. */
  detected_anti_features: Record<string, string[]>;
};

export type AdminCreateUser = {
  email: string;
  username: string;
  password: string;
  full_name?: string;
  role?: "user" | "admin";
};
export type AdminUpdateUser = {
  full_name?: string;
  role?: "user" | "admin";
  is_active?: boolean;
  new_password?: string;
  // Quota knobs. ``quota_*`` sets a value; ``quota_reset_*`` reverts to
  // ``null`` (= fall back to the repo default). Pass at most one of the
  // pair per dimension.
  quota_max_apps?: number;
  quota_max_storage_bytes?: number;
  quota_max_apks_per_month?: number;
  quota_reset_apps?: boolean;
  quota_reset_storage_bytes?: boolean;
  quota_reset_apks_per_month?: boolean;
};

export type RepoConfigInfo = {
  id: string;
  name: string;
  description: string | null;
  icon_path: string | null;
  address: string;
  setup_complete: boolean;
  keystore_fingerprint_sha256: string | null;
  last_index_version: number;
  last_indexed_at: string | null;
  public_mode: boolean;
  registration_policy: RegistrationPolicy;
  mirrors: string[];
  upload_max_apk_mb: number;
  // Repo-wide default quotas (NULL = unlimited).
  default_quota_max_apps?: number | null;
  default_quota_max_storage_bytes?: number | null;
  default_quota_max_apks_per_month?: number | null;
  // Reset flags for the PATCH payload (not present on reads).
  quota_reset_apps?: boolean;
  quota_reset_storage_bytes?: boolean;
  quota_reset_apks_per_month?: boolean;
  // ClamAV admin toggles. ``clamav_available`` mirrors the env knob and
  // is read-only.
  clamav_available?: boolean;
  clamav_scan_on_upload?: boolean;
  clamav_scan_periodic?: boolean;
  require_admin_2fa?: boolean;
};

export type InviteCode = {
  id: string;
  code: string;
  note: string | null;
  created_at: string;
  expires_at: string | null;
  used_at: string | null;
  created_by_username: string | null;
  used_by_username: string | null;
};
export type KeystoreInfo = {
  present: boolean;
  fingerprint_sha256: string | null;
  alias: string | null;
  not_before: string | null;
  not_after: string | null;
};
export type SetupWizardPayload = {
  repo_name: string;
  repo_description?: string;
  repo_address: string;
  keystore_mode: "generate" | "import";
  keystore_password?: string;
  key_alias?: string;
  key_password?: string;
  key_dname?: string;
  keystore_b64?: string;
};

export type DownloadHistoryItem = {
  app_id: string;
  package_name: string;
  app_name: string;
  icon_path: string | null;
  download_count: number;
  bytes_total: number;
  last_downloaded_at: string | null;
  last_apk_version_code: number | null;
  last_apk_version_name: string | null;
  latest_apk_version_code: number | null;
  latest_apk_version_name: string | null;
  has_update_available: boolean;
};

export type AdminStats = {
  total_users: number;
  total_apps: number;
  published_apps: number;
  pending_apks: number;
  total_downloads: number;
  total_api_keys: number;
  recent_downloads: Array<{
    id: string;
    apk_id: string;
    app_id: string;
    app_name: string | null;
    user_id: string | null;
    username: string | null;
    created_at: string;
  }>;
};

// ────────────────────────────────────────────────────────────────────────
// Sessions, quotas, 2FA, audit log, jobs, collaborators
// ────────────────────────────────────────────────────────────────────────

export type UserSession = {
  id: string;
  created_at: string;
  last_seen_at: string;
  ip_hash: string | null;
  user_agent: string | null;
  revoked_at: string | null;
};

export type QuotaDimension = {
  used: number;
  /** ``null`` = unlimited (no cap). */
  cap: number | null;
};

export type QuotaUsage = {
  apps: QuotaDimension;
  storage_bytes: QuotaDimension;
  apks_this_month: QuotaDimension;
};

export type TotpStatus = {
  enrolled: boolean;
  pending?: boolean;
  last_used_at?: string | null;
};

export type TotpSetup = {
  secret: string;
  provisioning_uri: string;
  qr_data_uri: string;
};

export type AppCollaborator = {
  id: string;
  user_id: string;
  granted_at: string;
  username: string;
  email: string;
  full_name: string | null;
};

export type AuditLogEntry = {
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_username: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  summary: string | null;
  payload: Record<string, unknown> | null;
  ip_hash: string | null;
  user_agent: string | null;
};

export type AuditLogPage = {
  items: AuditLogEntry[];
  total: number;
};

export type JobsSnapshot = {
  available: boolean;
  queued: number;
  in_progress: number;
  recent: Array<{
    function?: string;
    success?: boolean;
    start_time?: string | null;
    finish_time?: string | null;
    duration_ms?: number | null;
    result_str?: string | null;
    raw_key?: string;
  }>;
  observed_at?: number;
  error?: string;
};

export type ApkScanRow = {
  id: string;
  apk_id: string;
  scanner: string;
  status: "pending" | "clean" | "infected" | "error";
  signatures: string | null;
  error: string | null;
  scanned_at: string | null;
  created_at: string;
  // Joined app + apk metadata — null when the underlying rows were
  // deleted between the scan and the read.
  app_id: string | null;
  app_name: string | null;
  package_name: string | null;
  version_name: string | null;
  version_code: number | null;
};

export type MetadataImportResult = {
  name: string | null;
  summary: string | null;
  description: string | null;
  license: string | null;
  author_name: string | null;
  author_email: string | null;
  website: string | null;
  source_code: string | null;
  issue_tracker: string | null;
  translation: string | null;
  donate: string | null;
  liberapay: string | null;
  open_collective: string | null;
  bitcoin: string | null;
  categories: string[];
  anti_features: string[];
};
