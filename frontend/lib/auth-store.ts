"use client";

import { create } from "zustand";

import {
  api,
  clearTokens,
  type CurrentUser,
  getAccessToken,
  setTokens,
} from "@/lib/api";
import { pushTokenToSW, registerMediaSW } from "@/lib/media-sw";

/** Resolved login outcome. ``user`` is set on success; ``mfaToken`` is set
 *  when the password check passed but a second factor is required — the
 *  login page then renders a code input and calls ``finishMfaLogin``. The
 *  ``method`` on the MFA branch tells the page whether to prompt for a
 *  6-digit code (TOTP) or run a passkey assertion. The ``enrollment``
 *  branch fires when the user's role is under a force-passkey policy but
 *  they haven't registered one yet — the page redirects to the forced
 *  enrolment screen with the enrolment token. */
export type LoginOutcome =
  | { kind: "ok"; user: CurrentUser }
  | { kind: "mfa"; mfaToken: string; method: "totp" | "webauthn" }
  | { kind: "enrollment"; enrollmentToken: string };

type AuthState = {
  user: CurrentUser | null;
  loading: boolean;
  fetchMe: () => Promise<void>;
  login: (email: string, password: string) => Promise<LoginOutcome>;
  /** TOTP step. Can still end on the ``enrollment`` branch: the code was
   *  right but the role must also register a passkey first. */
  finishMfaLogin: (
    mfaToken: string,
    code: string,
  ) => Promise<Exclude<LoginOutcome, { kind: "mfa" }>>;
  signup: (payload: {
    email: string;
    username: string;
    password: string;
    full_name?: string;
    invite_code?: string;
  }) => Promise<CurrentUser>;
  /** Adopt a freshly minted token pair (password, passkey, MFA, forced
   *  enrolment, SSO): store it, hand the access token to the media SW and
   *  resolve the user. Storing the tokens alone left the store anonymous,
   *  so guarded pages bounced back to /login until a reload. */
  acceptTokens: (access: string, refresh: string) => Promise<CurrentUser>;
  acceptOidcTokens: (access: string, refresh: string) => Promise<CurrentUser>;
  logout: () => Promise<void>;
};

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  // We're only "loading" if there's a token worth resolving. With no token,
  // we already know we're anonymous — starting at `true` would otherwise
  // pin AuthGuard pages on the spinner until something triggers fetchMe.
  loading: typeof window !== "undefined" && !!getAccessToken(),

  async fetchMe() {
    set({ loading: true });
    try {
      const me = await api.me();
      set({ user: me, loading: false });
    } catch {
      set({ user: null, loading: false });
    }
  },

  async login(email, password) {
    const res = await api.login(email, password);
    if ("mfa_required" in res) {
      // No tokens minted yet — the page collects the second factor and
      // calls ``finishMfaLogin``.
      return {
        kind: "mfa",
        mfaToken: res.mfa_token,
        method: (res.method ?? "totp") as "totp" | "webauthn",
      };
    }
    if ("enrollment_required" in res) {
      // Role-policy demands a passkey but the account has none — the
      // page must route to the forced-enrolment screen with this
      // token. No tokens are minted yet; that happens after enrolment.
      return { kind: "enrollment", enrollmentToken: res.enrollment_token };
    }
    return { kind: "ok", user: await get().acceptTokens(res.access_token, res.refresh_token) };
  },

  async finishMfaLogin(mfaToken, code) {
    const res = await api.loginMfa({ mfa_token: mfaToken, code });
    if ("enrollment_required" in res) {
      // Code accepted, but the force-passkey policy still applies and the
      // account has none: same enrolment screen as after the password step.
      return { kind: "enrollment", enrollmentToken: res.enrollment_token };
    }
    return { kind: "ok", user: await get().acceptTokens(res.access_token, res.refresh_token) };
  },

  async signup(payload) {
    const tokens = await api.signup(payload);
    return get().acceptTokens(tokens.access_token, tokens.refresh_token);
  },

  async acceptTokens(access, refresh) {
    setTokens(access, refresh);
    pushTokenToSW();
    const me = await api.me();
    set({ user: me, loading: false });
    return me;
  },

  acceptOidcTokens(access, refresh) {
    return get().acceptTokens(access, refresh);
  },

  async logout() {
    // Server-side revoke first so the refresh-token chain is dead
    // even if someone exfiltrated the refresh blob from localStorage
    // before this call. We then clear the local copy regardless of
    // the server's response — a backend hiccup must not leave the
    // user "logged in" client-side, and the 204 is best-effort.
    const { getRefreshToken, api } = await import("@/lib/api");
    const refresh = getRefreshToken();
    if (refresh) {
      try {
        await api.logout(refresh);
      } catch {
        /* offline / 5xx — fall through to local wipe */
      }
    }
    clearTokens();
    pushTokenToSW();
    set({ user: null, loading: false });
  },
}));

// ---------------------------------------------------------------------------
// SSO hand-off
// ---------------------------------------------------------------------------
// Per-tab state carried across the identity-provider round-trip. The nonce
// binds the one-time code the callback returns to the tab that started the
// flow, so a crafted /auth/oidc-success link can't sign a victim into
// someone else's account; ``next`` is where to land once signed in.
const OIDC_NONCE_KEY = "fdroid.oidc.nonce";
const OIDC_NEXT_KEY = "fdroid.oidc.next";

/** URL to send the browser to for SSO, after stashing a fresh nonce and the
 *  (already sanitised) ``next`` in sessionStorage. ``null`` when storage is
 *  unavailable — the hand-off could never complete. */
export function beginOidcLogin(
  loginUrl: string,
  opts: { next: string; invite?: string },
): string | null {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const nonce = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try {
    window.sessionStorage.setItem(OIDC_NONCE_KEY, nonce);
    window.sessionStorage.setItem(OIDC_NEXT_KEY, opts.next);
  } catch {
    return null;
  }
  const url = new URL(loginUrl, window.location.origin);
  url.searchParams.set("bind", nonce);
  if (opts.invite) url.searchParams.set("invite", opts.invite);
  return url.toString();
}

/** Read and forget what ``beginOidcLogin`` stashed — single use either way. */
export function takeOidcHandoff(): { nonce: string | null; next: string | null } {
  try {
    const nonce = window.sessionStorage.getItem(OIDC_NONCE_KEY);
    const next = window.sessionStorage.getItem(OIDC_NEXT_KEY);
    window.sessionStorage.removeItem(OIDC_NONCE_KEY);
    window.sessionStorage.removeItem(OIDC_NEXT_KEY);
    return { nonce, next };
  } catch {
    return { nonce: null, next: null };
  }
}

// One-shot bootstrap on first client load: if tokens sit in localStorage,
// resolve them to a user before any page reads from the store. Without this,
// reloading any route other than `/` or `/login` left the store unauthenticated
// even with valid tokens, because no component triggered fetchMe() globally.
//
// Also: register the media Service Worker as early as possible so
// <img src> tags for private-app icons get the Authorization header
// added by the SW on their way through. The worker boots once per
// origin and persists across tabs / restarts.
if (typeof window !== "undefined") {
  registerMediaSW();
  if (getAccessToken()) {
    void useAuth.getState().fetchMe();
  }
}
