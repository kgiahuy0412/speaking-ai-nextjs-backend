import { getStorageHealth } from "../src/lib/storage/health";

getStorageHealth()
  .then((health) => {
    console.info(JSON.stringify(health, null, 2));
    process.exitCode = health.ok ? 0 : 1;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
