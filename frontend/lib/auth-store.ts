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
 *  login page then renders a code input and calls ``finishMfaLogin``. */
export type LoginOutcome =
  | { kind: "ok"; user: CurrentUser }
  | { kind: "mfa"; mfaToken: string };

type AuthState = {
  user: CurrentUser | null;
  loading: boolean;
  fetchMe: () => Promise<void>;
  login: (email: string, password: string) => Promise<LoginOutcome>;
  finishMfaLogin: (mfaToken: string, code: string) => Promise<CurrentUser>;
  signup: (payload: {
    email: string;
    username: string;
    password: string;
    full_name?: string;
    invite_code?: string;
  }) => Promise<CurrentUser>;
  acceptOidcTokens: (access: string, refresh: string) => Promise<CurrentUser>;
  logout: () => void;
};

export const useAuth = create<AuthState>((set) => ({
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
      return { kind: "mfa", mfaToken: res.mfa_token };
    }
    setTokens(res.access_token, res.refresh_token);
    pushTokenToSW();
    const me = await api.me();
    set({ user: me, loading: false });
    return { kind: "ok", user: me };
  },

  async finishMfaLogin(mfaToken, code) {
    const tokens = await api.loginMfa({ mfa_token: mfaToken, code });
    setTokens(tokens.access_token, tokens.refresh_token);
    pushTokenToSW();
    const me = await api.me();
    set({ user: me, loading: false });
    return me;
  },

  async signup(payload) {
    const tokens = await api.signup(payload);
    setTokens(tokens.access_token, tokens.refresh_token);
    pushTokenToSW();
    const me = await api.me();
    set({ user: me, loading: false });
    return me;
  },

  async acceptOidcTokens(access, refresh) {
    setTokens(access, refresh);
    pushTokenToSW();
    const me = await api.me();
    set({ user: me, loading: false });
    return me;
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
