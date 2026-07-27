import { clearAdminSessionCookie } from "@/lib/adminAuth";

export async function POST() {
  await clearAdminSessionCookie();

  return Response.json({ success: true });
}
