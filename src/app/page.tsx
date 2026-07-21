import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <p className="text-sm font-semibold uppercase text-blue-700">
          AI Speaking Device MVP
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">
          Next.js backend truoc, mobile dung chung API sau.
        </h1>
        <p className="max-w-2xl text-lg text-slate-600">
          Buoc dau tien la tao API contract sach cho luong noi tieng Viet,
          sinh cau tieng Anh va do latency tung buoc.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/practice"
            className="w-fit rounded-md bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-700"
          >
            Mở demo luyện nói
          </Link>
          <Link
            href="/admin"
            className="w-fit rounded-md border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 transition hover:bg-slate-100"
          >
            Mở trung tâm quản trị
          </Link>
        </div>
      </div>
    </main>
  );
}
