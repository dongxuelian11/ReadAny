import i18n from "@readany/core/i18n";
import { relaunch } from "@tauri-apps/plugin-process";
import { type Update, check } from "@tauri-apps/plugin-updater";

export interface UpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

/**
 * Update channel mode.
 *
 * "manual": in-app automatic update check AND install are disabled. This is
 * REQUIRED until our own signing chain has been verified end-to-end (a real
 * N → N+1 upgrade installed and signature-verified with the fork's keypair).
 * Pointing the endpoint at our own repository is NOT a verified signing
 * chain — the bundled public key still belongs to the upstream signer, so
 * nothing we could publish would pass verification anyway.
 *
 * Flip to "signed" only after (a) tauri.conf.json carries the fork's public
 * key, (b) a release signed with the matching PRIVATE key has been installed
 * over a previous build and verified to preserve user data. Never disable
 * signature verification and never fall back to the upstream endpoint.
 */
export const UPDATE_MODE: "manual" | "signed" = "manual";

export function isAutoUpdateEnabled(): boolean {
  return UPDATE_MODE === "signed";
}

let updateStatus: UpdateStatus = "idle";
let availableUpdate: UpdateInfo | null = null;
let downloadProgress = 0;
let errorMessage = "";
/**
 * The exact Update object the user confirmed. Installing MUST reuse this
 * object — re-checking at install time can return a different version and
 * silently install something the user never confirmed (version drift).
 */
let confirmedUpdate: Update | null = null;
let installInFlight: Promise<boolean> | null = null;
let statusListeners: Array<
  (status: UpdateStatus, info: UpdateInfo | null, progress: number, error: string) => void
> = [];

export function getUpdateStatus(): UpdateStatus {
  return updateStatus;
}

export function getAvailableUpdate(): UpdateInfo | null {
  return availableUpdate;
}

export function getDownloadProgress(): number {
  return downloadProgress;
}

export function getErrorMessage(): string {
  return errorMessage;
}

export function subscribeToUpdates(
  listener: (
    status: UpdateStatus,
    info: UpdateInfo | null,
    progress: number,
    error: string,
  ) => void,
): () => void {
  statusListeners.push(listener);
  return () => {
    statusListeners = statusListeners.filter((l) => l !== listener);
  };
}

function notifyListeners() {
  for (const listener of statusListeners) {
    listener(updateStatus, availableUpdate, downloadProgress, errorMessage);
  }
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isAutoUpdateEnabled()) {
    // Manual mode: never talk to an update endpoint from the UI.
    return null;
  }

  updateStatus = "checking";
  errorMessage = "";
  notifyListeners();

  try {
    const update = await check();

    if (update) {
      confirmedUpdate = update;
      availableUpdate = {
        version: update.version,
        notes: update.body || undefined,
        date: update.date || undefined,
      };
      updateStatus = "available";
      notifyListeners();
      return availableUpdate;
    }
    confirmedUpdate = null;
    availableUpdate = null;
    updateStatus = "idle";
    notifyListeners();
    return null;
  } catch (error) {
    console.error("[Updater] Check failed:", error);
    updateStatus = "error";

    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes("Could not fetch") || errorMsg.includes("network")) {
      errorMessage = i18n.t("settings.updaterNetworkError");
    } else if (errorMsg.includes("release") || errorMsg.includes("JSON")) {
      errorMessage = i18n.t("settings.updaterNoUpdate");
    } else {
      errorMessage = i18n.t("settings.updaterCheckFailed");
    }

    notifyListeners();
    return null;
  }
}

export async function downloadAndInstall(): Promise<boolean> {
  if (!isAutoUpdateEnabled()) {
    console.warn("[Updater] install requested while automatic updates are disabled — refusing");
    updateStatus = "error";
    errorMessage = i18n.t("settings.updaterManualModeRefusal");
    notifyListeners();
    return false;
  }

  // Single-flight: repeated clicks must not stack parallel downloads or
  // trigger repeated re-checks.
  if (installInFlight) return installInFlight;
  if (updateStatus === "downloading" || updateStatus === "ready") return false;

  installInFlight = doDownloadAndInstall().finally(() => {
    installInFlight = null;
  });
  return installInFlight;
}

async function doDownloadAndInstall(): Promise<boolean> {
  updateStatus = "downloading";
  downloadProgress = 0;
  errorMessage = "";
  notifyListeners();

  try {
    // Reuse the EXACT Update object the user confirmed. Only when we don't
    // have one (e.g. the app re-entered this flow after a restart) do we
    // re-check — inside the same error handling, and if the version changed
    // we surface the new version and STOP so the user re-confirms instead of
    // silently installing something they never saw.
    let update = confirmedUpdate;
    if (!update || (availableUpdate && update.version !== availableUpdate.version)) {
      const fresh = await check();
      if (!fresh) {
        updateStatus = "error";
        errorMessage = i18n.t("settings.updaterNoAvailable");
        notifyListeners();
        return false;
      }
      if (availableUpdate && fresh.version !== availableUpdate.version) {
        confirmedUpdate = fresh;
        availableUpdate = {
          version: fresh.version,
          notes: fresh.body || undefined,
          date: fresh.date || undefined,
        };
        updateStatus = "available";
        errorMessage = i18n.t("settings.updaterVersionChanged", { version: fresh.version });
        notifyListeners();
        return false;
      }
      update = fresh;
      confirmedUpdate = update;
    }

    let downloaded = 0;
    let contentLength = 0;

    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          contentLength = event.data.contentLength || 0;
          console.log(`[Updater] Started downloading, content length: ${contentLength}`);
          break;

        case "Progress":
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            downloadProgress = Math.round((downloaded / contentLength) * 100);
            notifyListeners();
          }
          console.log(`[Updater] Progress: ${downloaded}/${contentLength} (${downloadProgress}%)`);
          break;

        case "Finished":
          console.log("[Updater] Download finished");
          break;
      }
    });

    updateStatus = "ready";
    downloadProgress = 100;
    notifyListeners();

    return true;
  } catch (error) {
    console.error("[Updater] Download/install failed:", error);
    updateStatus = "error";
    errorMessage = i18n.t("settings.updaterDownloadFailed");
    notifyListeners();
    return false;
  }
}

export async function installUpdate(): Promise<void> {
  await downloadAndInstall();
}

export async function relaunchApp(): Promise<void> {
  try {
    await relaunch();
  } catch (error) {
    console.error("[Updater] Relaunch failed:", error);
    throw error instanceof Error ? error : new Error(i18n.t("settings.updaterRelaunchFailed"));
  }
}

export function resetStatus(): void {
  updateStatus = "idle";
  errorMessage = "";
  notifyListeners();
}
