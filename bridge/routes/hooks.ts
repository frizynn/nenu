import type { Route } from "./context.ts";

// The loopback-only, token-gated receiver for observer Claude Code hooks. Empty until the hooks
// installer exists; routes/index.ts already mounts it.
export const hookRoutes: Route[] = [];
