const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
require("dotenv").config();

async function main() {
  const sourcePath = path.resolve(
    process.env.DAKINI_DATABASE_FILE || path.join(__dirname, ".dakini-state.sqlite")
  );
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`SQLite database not found: ${sourcePath}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destinationPath = path.resolve(
    process.argv[2] || `${sourcePath}.backup-${timestamp}.sqlite`
  );
  if (sourcePath === destinationPath) {
    throw new Error("Backup destination must be different from the active database.");
  }
  if (fs.existsSync(destinationPath)) {
    throw new Error(`Backup destination already exists: ${destinationPath}`);
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await database.backup(destinationPath);
  } finally {
    database.close();
  }
  console.log(`SQLite backup created at ${destinationPath}`);
}

main().catch(error => {
  console.error(`SQLite backup failed: ${error.message}`);
  process.exitCode = 1;
});
