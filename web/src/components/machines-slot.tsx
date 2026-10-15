import { lazy, Suspense } from "react";

import type { HomeData } from "@/lib/loaders";
import { otherMachines } from "@/lib/machines";

// Only a herd with more than one machine loads the lists of the others.
const OtherMachines = lazy(() => import("@/components/other-machines"));

/** Every other machine Herdr has saved, with its chats; nothing at all with one machine. */
export function MachinesSlot({ data, place }: { data: HomeData; place: "nav" | "home" }) {
  if (otherMachines(data).length === 0) return null;
  return <Suspense fallback={null}><OtherMachines data={data} place={place} /></Suspense>;
}
