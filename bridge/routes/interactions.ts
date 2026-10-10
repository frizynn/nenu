import type { PaneAction, Route } from "./context.ts";

// GET the pane's detected dialog and POST /api/interactions/:paneId/answer (ADR 0057). Empty until
// the bridge detects interactions; routes/index.ts already mounts both tables.
export const interactionRoutes: Route[] = [];
export const interactionPaneActions: Record<string, PaneAction> = {};
