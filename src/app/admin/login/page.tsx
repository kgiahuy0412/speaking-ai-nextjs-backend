import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AdminLoginForm } from "@/components/AdminLoginForm";
import {
  getConfiguredAdminCredentials,
  hasValidAdminSession,
} from "@/lib/adminAuth";

export const metadata: Metadata = {
  title: "Đăng nhập quản trị | AI Speaking",
  description: "Đăng nhập vào trang quản trị AI Speaking.",
};

export default async function AdminLoginPage() {
  if (await hasValidAdminSession()) {
    redirect("/admin");
  }

  return (
    <AdminLoginForm configured={Boolean(getConfiguredAdminCredentials())} />
  );
}
