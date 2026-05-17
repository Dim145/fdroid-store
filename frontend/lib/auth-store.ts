"use client";

import { create } from "zustand";

import {
  api,
  clearTokens,
  type CurrentUser,
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
  }) => Promise<CurrentUser>;
  acceptOidcTokens: (access: string, refresh: string) => Promise<CurrentUser>;
  logout: () => void;
};

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,

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
