import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "팀약 (TEAMYAK) — Phase 3 실제 다중 사용자 서비스",
  description: "약속은 쉽게, 일정은 자동으로, 만남은 기록으로. 약속은 연결하지만, 관계는 소유하지 않는다.",
  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body className="min-h-screen bg-slate-950 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
