import { migrateDataDirectory } from "./data-directory-migration.js";

const [source, destination, ...extra] = process.argv.slice(2);
if (source === undefined || destination === undefined || extra.length > 0) {
  process.stderr.write("Usage: npm run migrate-data -- <legacy-directory> <new-directory>\n");
  process.exitCode = 2;
} else {
  try {
    const migrated = await migrateDataDirectory(source, destination);
    process.stdout.write(`Migrated 1667 data to ${migrated}\n`);
  } catch (error) {
    process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
