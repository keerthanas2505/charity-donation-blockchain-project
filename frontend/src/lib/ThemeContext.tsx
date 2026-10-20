import React, { createContext, useContext, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type EffectiveTheme = "light" | "dark";

interface ThemeContextType {
  theme: ThemePreference;
  effectiveTheme: EffectiveTheme;
  setTheme: (theme: ThemePreference) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = "trustfund-theme";

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function getSystemTheme(): EffectiveTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark" || stored === "system") {
        return stored;
      }
    } catch {
      /* ignore */
    }
    return "system";
  });

  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(() => {
    if (theme === "system") return getSystemTheme();
    return theme;
  });

  useEffect(() => {
    const root = document.documentElement;
    const computed = theme === "system" ? getSystemTheme() : theme;
    setEffectiveTheme(computed);
    root.setAttribute("data-theme", computed);

    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  // Listen to system preference changes when in 'system' mode
  useEffect(() => {
    if (theme !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      const updated = mediaQuery.matches ? "dark" : "light";
      setEffectiveTheme(updated);
      document.documentElement.setAttribute("data-theme", updated);
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  const setTheme = (newTheme: ThemePreference) => {
    setThemeState(newTheme);
  };

  const toggleTheme = () => {
    setThemeState((prev) => {
      if (prev === "dark") return "light";
      if (prev === "light") return "system";
      return "dark";
    });
  };

  return (
    <ThemeContext.Provider value={{ theme, effectiveTheme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
