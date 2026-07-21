"use client";

import { useUiLocale } from "@/components/UiLocaleProvider";
import type { PracticeContext } from "@/types/conversation";

type ContextSelectorProps = {
  value: PracticeContext;
  onChange: (value: PracticeContext) => void;
};

export function ContextSelector({ value, onChange }: ContextSelectorProps) {
  const { pick } = useUiLocale();
  const contexts: Array<{ value: PracticeContext; label: string }> = [
    { value: "home", label: pick("Ở nhà", "在家") },
    { value: "school", label: pick("Trước / sau giờ học", "上学前后") },
    { value: "outside", label: pick("Ra ngoài", "外出") },
  ];

  return (
    <div className="grid grid-cols-3 gap-2">
      {contexts.map((context) => (
        <button
          key={context.value}
          type="button"
          onClick={() => onChange(context.value)}
          className={`rounded-md border px-3 py-2 text-sm font-medium transition ${
            value === context.value
              ? "border-blue-600 bg-blue-600 text-white"
              : "border-slate-200 bg-white text-slate-700 hover:border-blue-300"
          }`}
        >
          {context.label}
        </button>
      ))}
    </div>
  );
}
