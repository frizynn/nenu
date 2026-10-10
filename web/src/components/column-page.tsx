import type { ReactNode } from "react";
import { useNavigate } from "react-router";

import { AppHeader, SettingsGear } from "@/components/app-header";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import type { HomeData } from "@/lib/loaders";
import { homePath } from "@/lib/nav";

/** A page of the project family: the shared header with its title, the read-only notice, and one centred column. */
export function ColumnPage({ data, title, children }: { data: HomeData; title: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <div className="workbench-home flex min-h-0 min-w-0 flex-1 flex-col">
      <AppHeader bridge={data.bridge} error={data.error} onHome={() => navigate(homePath(data.session))}
        rightTrail={<SettingsGear session={data.session} />}>
        <span className="truncate text-sm font-medium">{title}</span>
      </AppHeader>
      <ReadOnlyBanner device={data.device} />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 pt-6 pb-[calc(env(safe-area-inset-bottom)+2rem)] sm:px-8 sm:pt-12">
        <div className="mx-auto w-full max-w-2xl">{children}</div>
      </main>
    </div>
  );
}
