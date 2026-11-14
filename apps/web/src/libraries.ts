import { loadLibraryFromBlob } from "@excalidraw/excalidraw";
import type { LibraryPersistenceAdapter } from "@excalidraw/excalidraw/data/library";
import { createStore, get, set } from "idb-keyval";

/** The default libraries in `public/libraries`, from libraries.excalidraw.com. */
const DEFAULT_LIBRARIES = [
  "dwelle_network-topology-icons",
  "samu_x86_network-elements",
  "dday987_common-home-network-basics",
  "jgodoy_racks-and-servers-components",
  "fibreninja_fibre-network",
  "rohanp_system-design",
  "youritjang_software-architecture",
  "pratheeshpm_basic-system-design",
  "anna-pastushko_architecture-diagram-components",
  "mateuszbaransanok_it-icons",
  "niknm_systemdesignicons",
  "drwnio_drwnio",
  "dmitry-burnyshev_c4-architecture",
];

const store = createStore("draw-library", "library");

/**
 * Keeps the library of this browser in IndexedDB. When the browser has no library yet,
 * which is the first time that the editor opens, it loads the default libraries.
 */
export const libraryAdapter: LibraryPersistenceAdapter = {
  async load() {
    const saved = await get("items", store);
    if (saved) return { libraryItems: saved };
    const lists = await Promise.all(
      DEFAULT_LIBRARIES.map(async (name) => {
        const response = await fetch(`/libraries/${name}.excalidrawlib`);
        return loadLibraryFromBlob(await response.blob(), "published");
      }),
    );
    const libraryItems = lists.flat();
    // Excalidraw saves the library only after a change. Store it now, so it loads one time.
    await set("items", libraryItems, store);
    return { libraryItems };
  },
  async save({ libraryItems }) {
    await set("items", libraryItems, store);
  },
};
