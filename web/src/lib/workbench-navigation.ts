import { createContext } from "react";

export interface WorkbenchNavigation {
  open: boolean;
  onOpen: () => void;
  /** Starts a new chat; absent while creating is not allowed (read-only device, no connection). */
  onNewChat?: () => void;
}

// The shell owns the drawer and the new-chat sheet; routes reach both through this context.
export const WorkbenchNavigationContext = createContext<WorkbenchNavigation | undefined>(undefined);
