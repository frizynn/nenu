import { lazy, Suspense, useMemo } from "react";
import { useNavigate, useParams, useRouteLoaderData, useSearchParams } from "react-router";

import { paneRootsOf } from "@/lib/file-links";
import { FilePreviewContext } from "@/lib/file-preview-context";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { filePagePath, panePath } from "@/lib/nav";
import { useGoUp } from "@/lib/motion";
import { useSession } from "@/lib/session";
import { NotFound } from "./not-found";

const FilePreview = lazy(() => import("@/components/file-preview"));

/**
 * A file's own page (lib/nav.ts `filePagePath`), where a file's link opens in a new tab: the viewer on
 * the whole screen, reading the file through the same routes as in a chat. A link inside a document
 * opens on this page; Done goes to the pane's chat.
 */
export function FileRoute() {
  const { paneId = "" } = useParams();
  const [search] = useSearchParams();
  const path = search.get("path") ?? "";
  const session = useSession();
  const navigate = useNavigate();
  const goUp = useGoUp();
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const panes = useMemo(() => paneRootsOf(data), [data.agents, data.shellPanes]);
  if (!paneId || !path) return <NotFound />;
  return (
    <FilePreviewContext.Provider value={(next) => navigate(filePagePath(paneId, next, session))}>
      <Suspense fallback={<div role="status" className="p-10 text-center text-footnote text-muted-foreground">Opening document…</div>}>
        <FilePreview key={path} page paneId={paneId} session={session} path={path} panes={panes} onClose={() => goUp(panePath(paneId, session))} />
      </Suspense>
    </FilePreviewContext.Provider>
  );
}
