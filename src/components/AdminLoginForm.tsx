"use client";

import { useState, type FormEvent } from "react";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useUiLocale } from "@/components/UiLocaleProvider";

function responseError(data: unknown, fallback: string) {
  if (
    data &&
    typeof data === "object" &&
    "error" in data &&
    data.error &&
    typeof data.error === "object" &&
    "message" in data.error &&
    typeof data.error.message === "string"
  ) {
    return data.error.message;
  }

  return fallback;
}

export function AdminLoginForm({ configured }: { configured: boolean }) {
  const { pick } = useUiLocale();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          responseError(
            data,
            pick("Không thể đăng nhập. Vui lòng thử lại.", "无法登录，请重试。"),
          ),
        );
      }

      window.location.replace("/admin");
    } catch (loginError) {
      setError(
        loginError instanceof Error
          ? loginError.message
          : pick("Không thể đăng nhập. Vui lòng thử lại.", "无法登录，请重试。"),
      );
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
      <section className="w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-slate-900 shadow-2xl shadow-black/30">
        <div className="border-b border-white/10 bg-gradient-to-br from-slate-900 to-blue-950 px-6 py-7 sm:px-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-300">
                AI Speaking
              </p>
              <h1 className="mt-3 text-2xl font-semibold text-white">
                {pick("Đăng nhập quản trị", "管理员登录")}
              </h1>
            </div>
            <LanguageToggle tone="dark" />
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            {pick(
              "Nhập tài khoản và mật khẩu quản trị đã cấu hình trên máy chủ.",
              "请输入已在服务器上配置的管理员账号和密码。",
            )}
          </p>
        </div>

        <form className="space-y-5 px-6 py-7 sm:px-8" onSubmit={submit}>
          {!configured ? (
            <div
              className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm leading-6 text-amber-100"
              role="alert"
            >
              {pick(
                "Chưa cấu hình ADMIN_USERNAME và ADMIN_PASSWORD. Hãy thêm hai biến môi trường này rồi khởi động lại server.",
                "尚未配置 ADMIN_USERNAME 和 ADMIN_PASSWORD。请添加这两个环境变量并重启服务器。",
              )}
            </div>
          ) : null}

          <label className="block text-sm font-medium text-slate-200">
            {pick("Tài khoản", "账号")}
            <input
              type="text"
              name="username"
              autoComplete="username"
              autoFocus
              required
              maxLength={256}
              disabled={!configured || isSubmitting}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-3 text-white outline-none ring-cyan-400 placeholder:text-slate-600 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
              placeholder={pick("Nhập tài khoản", "输入账号")}
            />
          </label>

          <label className="block text-sm font-medium text-slate-200">
            {pick("Mật khẩu", "密码")}
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              maxLength={1024}
              disabled={!configured || isSubmitting}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-3 text-white outline-none ring-cyan-400 placeholder:text-slate-600 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
              placeholder={pick("Nhập mật khẩu", "输入密码")}
            />
          </label>

          {error ? (
            <div
              className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-100"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={!configured || isSubmitting}
            className="w-full rounded-xl bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting
              ? pick("Đang đăng nhập…", "正在登录…")
              : pick("Đăng nhập", "登录")}
          </button>
        </form>
      </section>
    </main>
  );
}
