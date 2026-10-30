import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { joinedMachines, useMachineFilter } from "@/lib/machines";
import type { MachineView } from "@/lib/types";

/**
 * Which machine this device's lists show (ADR 0135): every one at once, the default, or one alone. Shown
 * only while more than one machine joins the lists; a machine that left reads as All.
 */
export function MachinePicker({ data, className }: { data: { machines?: MachineView[] }; className?: string }) {
  const [filter, setFilter] = useMachineFilter();
  const machines = joinedMachines(data);
  if (machines.length < 2) return null;
  const value = machines.some((machine) => machine.label === filter) ? filter : "";
  return <Segmented label="Machine" value={value} onChange={setFilter} className={cn("machine-picker h-8 coarse:h-9", className)}
    options={[{ value: "", label: "All" }, ...machines.map((machine) => ({ value: machine.label, label: machine.label }))]} />;
}
