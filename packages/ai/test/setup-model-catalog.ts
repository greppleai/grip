import { fileURLToPath } from "node:url";
import { loadCachedModelCatalog } from "../src/models.ts";

// Test-only snapshot of the previously generated catalog. Tests must not depend on
// local caches or network access; this file is not included in the published package.
const cachePath = fileURLToPath(new URL("./data/model-catalog-fixture.json", import.meta.url));
if (!loadCachedModelCatalog({ cachePath }).loaded) throw new Error("Invalid test model catalog fixture");
