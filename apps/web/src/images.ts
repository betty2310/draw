import { projectImagePath } from "@draw/shared";
import { loadLocalImage, type ImageFile } from "./sync.ts";

export const blobToDataURL = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/**
 * An image of a scene comes from this browser or from the server. The editor uploads an image
 * just before the save that uses it, so a viewer can ask for it a few times.
 */
export async function loadImageFile(
  projectId: string,
  id: string,
  attempts = 1,
): Promise<ImageFile | undefined> {
  const local = await loadLocalImage(projectId, id);
  if (local) return local;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(projectImagePath(projectId, id)).catch(() => null);
    if (response?.ok) {
      const blob = await response.blob();
      return { id, mimeType: blob.type, dataURL: await blobToDataURL(blob) };
    }
  }
  return undefined;
}
