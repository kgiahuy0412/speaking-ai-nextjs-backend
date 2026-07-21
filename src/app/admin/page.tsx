import type { Metadata } from "next";
import { AdminDashboard } from "@/components/AdminDashboard";

export const metadata: Metadata = {
  title: "Quản trị | AI Speaking",
  description: "Quản lý lượt nói, đánh giá và dữ liệu học theo từng thiết bị.",
};

export default function AdminPage() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <AdminDashboard />
    </main>
  );
}
