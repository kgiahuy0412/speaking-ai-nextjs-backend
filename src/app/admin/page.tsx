import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AdminDashboard } from "@/components/AdminDashboard";
import { hasValidAdminSession } from "@/lib/adminAuth";

export const metadata: Metadata = {
  title: "Quản trị | AI Speaking",
  description: "Quản lý lượt nói, đánh giá và dữ liệu học theo từng thiết bị.",
};

export default async function AdminPage() {
  if (!(await hasValidAdminSession())) {
    redirect("/admin/login");
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <AdminDashboard />
    </main>
  );
}
