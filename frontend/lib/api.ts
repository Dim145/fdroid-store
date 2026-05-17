/**
 * Thin fetch client around the FastAPI backend.
 *
 * All public functions are async, throw `ApiError` on non-2xx, and
 * transparently refresh the access token once on 401.
 */

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "http://localhost:8000";

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

async function refreshAccessToken(): Promise<boolean> {
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
  if (!anonymous) {
    const token = getAccessToken();
    if (token) finalHeaders.set("authorization", `Bearer ${token}`);
  }

  const url = path.startsWith("http") ? path : `${API_URL}${path}`;
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

export type AuthMethodsInfo = {
  local: boolean;
  oidc: boolean;
  allow_signup: boolean;
  oidc_login_url: string | null;
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
};

export const api = {
  authMethods: () => apiFetch<AuthMethodsInfo>("/api/v1/auth/methods", { anonymous: true }),
  login: (email: string, password: string) =>
    apiFetch<TokenPair>("/api/v1/auth/login", {
      method: "POST",
      anonymous: true,
      body: JSON.stringify({ email, password }),
    }),
  signup: (payload: { email: string; username: string; password: string; full_name?: string }) =>
    apiFetch<TokenPair>("/api/v1/auth/signup", {
      method: "POST",
      anonymous: true,
      body: JSON.stringify(payload),
    }),
  me: () => apiFetch<CurrentUser>("/api/v1/me"),
  updateMe: (payload: { full_name?: string }) =>
    apiFetch<CurrentUser>("/api/v1/me", { method: "PATCH", body: JSON.stringify(payload) }),
  changePassword: (payload: { current_password: string; new_password: string }) =>
    apiFetch<void>("/api/v1/me/change-password", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  downloadHistory: () =>
    apiFetch<{ items: Array<{ id: string; apk_id: string; app_id: string; created_at: string; bytes_served: number | null }> }>(
      "/api/v1/me/downloads"
    ),

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
    get: (ref: string) =>
      apiFetch<AppDetail>(`/api/v1/apps/${encodeURIComponent(ref)}`, {
        anonymous: !getAccessToken(),
      }),
    create: (payload: AppCreate) =>
      apiFetch<AppSummary>("/api/v1/apps", { method: "POST", body: JSON.stringify(payload) }),
    update: (id: string, payload: Partial<AppCreate>) =>
      apiFetch<AppSummary>(`/api/v1/apps/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
    remove: (id: string) => apiFetch<void>(`/api/v1/apps/${id}`, { method: "DELETE" }),
    uploadApk: (appId: string, file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return apiFetch<Apk>(`/api/v1/apks/upload/${appId}`, { method: "POST", body: fd });
    },
    myApps: () => apiFetch<Array<AppSummary>>("/api/v1/me/apps"),
  },

  categories: {
    list: () => apiFetch<Array<Category>>("/api/v1/categories", { anonymous: !getAccessToken() }),
  },

  setup: {
    status: () => apiFetch<{ setup_complete: boolean; keystore_present: boolean; has_users: boolean }>("/api/v1/setup/status", { anonymous: true }),
    wizard: (payload: SetupWizardPayload) =>
      apiFetch<RepoConfigInfo>("/api/v1/setup/wizard", { method: "POST", body: JSON.stringify(payload) }),
    keystoreInfo: () => apiFetch<KeystoreInfo>("/api/v1/setup/keystore"),
  },

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
    stats: () =>
      apiFetch<AdminStats>("/api/v1/admin/stats"),
  },
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

export type Category = { id: string; name: string; description: string | null };

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
  icon_path: string | null;
  visibility: "public" | "private";
  status: "draft" | "pending_review" | "published" | "rejected" | "archived";
  suggested_version_code: number | null;
  suggested_version_name: string | null;
  last_published_at: string | null;
  created_at: string;
  updated_at: string;
  categories: Category[];
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
  status: "uploaded" | "parsed" | "pending_review" | "published" | "rejected" | "deleted";
  rejection_reason: string | null;
  published_at: string | null;
  created_at: string;
};

export type AppDetail = AppSummary & { apks: Apk[]; owner_username: string | null };
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
  visibility?: "public" | "private";
  category_ids?: string[];
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
    user_id: string | null;
    created_at: string;
  }>;
};
