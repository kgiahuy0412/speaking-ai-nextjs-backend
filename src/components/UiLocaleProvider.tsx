"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type UiLocale = "vi" | "zh";

type UiLocaleContextValue = {
  locale: UiLocale;
  setLocale: (locale: UiLocale) => void;
  pick: <T>(vietnamese: T, chinese: T) => T;
};

const storageKey = "ai-speaking-ui-locale";

const UiLocaleContext = createContext<UiLocaleContextValue | null>(null);

function isUiLocale(value: string | null): value is UiLocale {
  return value === "vi" || value === "zh";
}

export function UiLocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<UiLocale>("vi");

  const setLocale = useCallback((nextLocale: UiLocale) => {
    setLocaleState(nextLocale);
    window.localStorage.setItem(storageKey, nextLocale);
    document.documentElement.lang = nextLocale === "zh" ? "zh-CN" : "vi";
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const savedLocale = window.localStorage.getItem(storageKey);
      if (isUiLocale(savedLocale)) {
        setLocaleState(savedLocale);
        document.documentElement.lang =
          savedLocale === "zh" ? "zh-CN" : "vi";
      }
    }, 0);

    function syncLocale(event: StorageEvent) {
      if (event.key === storageKey && isUiLocale(event.newValue)) {
        setLocaleState(event.newValue);
        document.documentElement.lang =
          event.newValue === "zh" ? "zh-CN" : "vi";
      }
    }

    window.addEventListener("storage", syncLocale);
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("storage", syncLocale);
    };
  }, []);

  const pick = useCallback(
    <T,>(vietnamese: T, chinese: T) =>
      locale === "zh" ? chinese : vietnamese,
    [locale],
  );
  const value = useMemo(
    () => ({ locale, setLocale, pick }),
    [locale, pick, setLocale],
  );

  return (
    <UiLocaleContext.Provider value={value}>
      {children}
    </UiLocaleContext.Provider>
  );
}

export function useUiLocale() {
  const value = useContext(UiLocaleContext);

  if (!value) {
    throw new Error("useUiLocale must be used inside UiLocaleProvider.");
  }

  return value;
}
