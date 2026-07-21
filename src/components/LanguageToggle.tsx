"use client";

import { useUiLocale } from "@/components/UiLocaleProvider";

export function LanguageToggle({
  tone = "light",
}: {
  tone?: "light" | "dark";
}) {
  const { locale, setLocale, pick } = useUiLocale();
  const dark = tone === "dark";

  return (
    <div
      className={`inline-flex rounded-xl border p-1 ${
        dark
          ? "border-white/15 bg-white/10"
          : "border-slate-200 bg-slate-100"
      }`}
      aria-label={pick("Chọn ngôn ngữ giao diện", "选择界面语言")}
    >
      {(
        [
          ["vi", "VI", "Tiếng Việt"],
          ["zh", "中文", "中文"],
        ] as const
      ).map(([value, label, title]) => (
        <button
          key={value}
          type="button"
          title={title}
          aria-pressed={locale === value}
          onClick={() => setLocale(value)}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
            locale === value
              ? dark
                ? "bg-cyan-300 text-slate-950 shadow-sm"
                : "bg-white text-blue-700 shadow-sm"
              : dark
                ? "text-slate-300 hover:text-white"
                : "text-slate-500 hover:text-slate-900"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
