import { ArrowUpDown, Check } from "@/components/ui/icon";
import { QuietMenu, quietMenuItem } from "@/components/ui/quiet-menu";
import { cn } from "@/lib/utils";
import { ORDER_LABEL, type WorkspaceOrder, type WorkspaceOrderMode } from "@/lib/workspace-order";

const MODES = Object.keys(ORDER_LABEL) as WorkspaceOrderMode[];

/**
 * How Home's workspaces are sorted: a quiet button that names the order on screen and opens a short
 * menu of the orders to choose from, closing on a choice. Custom is listed once the operator has
 * dragged one; dragging is Reorder's, beside it, never a row of this menu.
 */
export function WorkspaceOrderMenu({ order, onChoose, className }: {
  order: WorkspaceOrder;
  onChoose: (mode: WorkspaceOrderMode) => void;
  className?: string;
}) {
  const modes = MODES.filter((mode) => mode !== "custom" || order.mode === "custom" || order.custom.length > 0);
  const label = ORDER_LABEL[order.mode];
  return (
    <QuietMenu icon={ArrowUpDown} label={label} ariaLabel={`Order: ${label}`} menuLabel="Order" className={className}>
      {(close) => modes.map((mode) => (
        <button key={mode} type="button" role="menuitemradio" aria-checked={mode === order.mode}
          onClick={() => { onChoose(mode); close(); }} className={quietMenuItem}>
          <Check aria-hidden className={cn("size-4 shrink-0 text-foreground", mode !== order.mode && "invisible")} />
          <span className="min-w-0 flex-1 truncate">{ORDER_LABEL[mode]}</span>
        </button>
      ))}
    </QuietMenu>
  );
}
