import { create } from "zustand";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errorMessage, type YouTubeCookieStatus } from "../lib/api";

interface CookieState {
  status: YouTubeCookieStatus | null;
  loading: boolean;
  busy: boolean;
  verifying: boolean;
  message: string;
  openRequest: number;
  refresh: () => Promise<void>;
  requestOpen: () => void;
  pickAndImport: () => Promise<void>;
  importPath: (path: string) => Promise<void>;
  importText: (text: string) => Promise<boolean>;
  verify: () => Promise<void>;
  remove: () => Promise<void>;
  clearMessage: () => void;
}

let requestToken = 0;
let initialized = false;

function resultMessage(status: YouTubeCookieStatus) {
  if (status.state === "verified") return "Cookies verified with YouTube.";
  if (status.state === "rejected") {
    return "YouTube rejected these cookies. Sign in, export fresh cookies, and update them.";
  }
  return "Cookies were stored, but YouTube verification could not be completed. Retry verification.";
}

export const useCookieStore = create<CookieState>((set) => ({
  status: null,
  loading: false,
  busy: false,
  verifying: false,
  message: "",
  openRequest: 0,

  refresh: async () => {
    const token = ++requestToken;
    set({ loading: true });
    try {
      const status = await api.youtubeCookieStatus();
      if (token !== requestToken) return;
      set({ status, message: "" });
      if (!initialized && status.state === "unverified") {
        initialized = true;
        void useCookieStore.getState().verify();
      } else {
        initialized = true;
      }
    } catch (error) {
      if (token === requestToken) set({ message: errorMessage(error) });
    } finally {
      if (token === requestToken) set({ loading: false });
    }
  },

  requestOpen: () => set((state) => ({ openRequest: state.openRequest + 1 })),

  pickAndImport: async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "YouTube cookies", extensions: ["json", "txt", "cookies"] }],
    });
    if (typeof selected === "string") {
      await useCookieStore.getState().importPath(selected);
    }
  },

  importPath: async (path) => {
    const previous = useCookieStore.getState().status;
    const token = ++requestToken;
    set({ busy: true, verifying: false, message: "" });
    try {
      const status = await api.importYoutubeCookies(path);
      if (token !== requestToken) return;
      set({ status, busy: false, message: "Cookies stored; verification starting." });
      await useCookieStore.getState().verify();
    } catch (error) {
      if (token === requestToken) {
        set({ status: previous, message: errorMessage(error), busy: false });
      }
    } finally {
      if (token === requestToken) set({ busy: false });
    }
  },

  importText: async (text) => {
    const previous = useCookieStore.getState().status;
    const token = ++requestToken;
    set({ busy: true, verifying: false, message: "" });
    try {
      const status = await api.importYoutubeCookiesText(text);
      if (token !== requestToken) return false;
      set({ status, busy: false, message: "Cookies stored; verification starting." });
      void useCookieStore.getState().verify();
      return true;
    } catch (error) {
      if (token === requestToken) {
        set({ status: previous, message: errorMessage(error), busy: false });
      }
      return false;
    } finally {
      if (token === requestToken) set({ busy: false });
    }
  },

  verify: async () => {
    const token = ++requestToken;
    set({ verifying: true, busy: false, message: "" });
    try {
      const status = await api.verifyYoutubeCookies();
      if (token === requestToken) set({ status, message: resultMessage(status) });
    } catch (error) {
      if (token === requestToken) {
        set({
          status: useCookieStore.getState().status,
          message: `${errorMessage(error)} Retry verification.`,
        });
      }
    } finally {
      if (token === requestToken) set({ verifying: false });
    }
  },

  remove: async () => {
    const token = ++requestToken;
    set({ busy: true, verifying: false, message: "" });
    try {
      const status = await api.removeYoutubeCookies();
      if (token === requestToken) {
        set({ status, message: "YouTube cookies removed. Anonymous access is active." });
      }
    } catch (error) {
      if (token === requestToken) set({ message: errorMessage(error) });
    } finally {
      if (token === requestToken) set({ busy: false });
    }
  },

  clearMessage: () => set({ message: "" }),
}));
