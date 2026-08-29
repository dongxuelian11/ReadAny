// Tauri-backed BookSkillFs adapter. Tauri's fs plugin normalizes forward
// slashes to the platform separator on Windows, so "/" joins are safe here.

import type { BookSkillFs } from "@readany/core/book-skill";

export function createTauriBookSkillFs(): BookSkillFs {
  return {
    join(...parts: string[]) {
      return parts
        .filter((part) => part.length > 0)
        .join("/")
        .replace(/\/+/g, "/");
    },
    async mkdir(path: string) {
      const { mkdir } = await import("@tauri-apps/plugin-fs");
      await mkdir(path, { recursive: true });
    },
    async exists(path: string) {
      const { exists } = await import("@tauri-apps/plugin-fs");
      return exists(path);
    },
    async readFile(path: string) {
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      return readTextFile(path);
    },
    async writeFile(path: string, content: string) {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, content);
    },
    async remove(path: string) {
      const { remove } = await import("@tauri-apps/plugin-fs");
      await remove(path, { recursive: true });
    },
  };
}
