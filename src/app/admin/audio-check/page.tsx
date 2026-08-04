import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AdminAudioCheck } from "@/components/AdminAudioCheck";
import { hasValidAdminSession } from "@/lib/adminAuth";

export const metadata: Metadata = {
  title: "Kiểm tra audio | AI Speaking",
  description:
    "Kiểm tra audio bằng chế độ tiêu chuẩn hoặc Cloudflare Batch Chunks.",
};

export default async function AdminAudioCheckPage() {
  if (!(await hasValidAdminSession())) {
    redirect("/admin/login");
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <AdminAudioCheck />
    </main>
  );
}
