/**
 * App — Tab-driven layout. No react-router page switching.
 * All opened tabs stay mounted; visibility controlled by CSS display.
 */
import { AppLayout } from "@/components/layout/AppLayout";
import { UpdateNotification } from "@/components/layout/UpdateNotification";
import { useAutoSync } from "@/hooks/use-sync";
import { replayPendingLearnerEvidence } from "@/lib/learner/trigger";
import { DesktopSyncAdapter } from "@/lib/sync/sync-adapter-desktop";
import { setSyncAdapter } from "@readany/core/sync";
import { useEffect } from "react";
import { Toaster } from "sonner";

// Register the desktop sync adapter once at module load
setSyncAdapter(new DesktopSyncAdapter());

export default function App() {
  useAutoSync();

  useEffect(() => {
    // PR-012: replay evidence rows enqueued but never applied (crash or
    // failed write). Fire-and-forget: failed rows stay pending for the next
    // drain and must never block startup.
    void replayPendingLearnerEvidence().catch((error) =>
      console.error("Failed to replay pending learner evidence:", error),
    );
  }, []);

  return (
    <>
      <AppLayout />
      <Toaster position="top-center" richColors duration={2000} />
      <UpdateNotification />
    </>
  );
}
