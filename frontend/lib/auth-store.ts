"use client";

import { create } from "zustand";

import {
  api,
  clearTokens,
  type CurrentUser,
  getAccessToken,
  setTokens,
} from "@/lib/api";

type AuthState = {
  user: CurrentUser | null;
  loading: boolean;
  fetchMe: () => Promise<void>;
  login: (email: string, password: string) => Promise<CurrentUser>;
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
    const tokens = await api.login(email, password);
    setTokens(tokens.access_token, tokens.refresh_token);
    const me = await api.me();
    set({ user: me, loading: false });
    return me;
  },

  async signup(payload) {
    const tokens = await api.signup(payload);
    setTokens(tokens.access_token, tokens.refresh_token);
    const me = await api.me();
    set({ user: me, loading: false });
    return me;
  },

  async acceptOidcTokens(access, refresh) {
    setTokens(access, refresh);
    const me = await api.me();
    set({ user: me, loading: false });
    return me;
  },

  logout() {
    clearTokens();
    set({ user: null, loading: false });
  },
}));

// One-shot bootstrap on first client load: if tokens sit in localStorage,
// resolve them to a user before any page reads from the store. Without this,
// reloading any route other than `/` or `/login` left the store unauthenticated
// even with valid tokens, because no component triggered fetchMe() globally.
if (typeof window !== "undefined" && getAccessToken()) {
  void useAuth.getState().fetchMe();
}
