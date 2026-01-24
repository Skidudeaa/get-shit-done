const fs = require("fs");
const path = require("path");

let sqlJsPromise = null;

async function loadSqlJs() {
  if (sqlJsPromise) return sqlJsPromise;
  const initSqlJs = require("sql.js");
  const distDir = path.join(__dirname, "..", "node_modules", "sql.js", "dist");
  sqlJsPromise = initSqlJs({
    locateFile: (file) => path.join(distDir, file),
  });
  return sqlJsPromise;
}

function stateDir(root) {
  return path.join(path.resolve(root), ".planning", "intel");
}

function graphDbPath(root) {
  return path.join(stateDir(root), "graph.db");
}

const dbByRoot = new Map(); // rootAbs -> SQL.Database

function ensureSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      type TEXT,
      size_bytes INTEGER,
      mtime_ms INTEGER,
      updated_at_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS imports (
      from_path TEXT NOT NULL,
      specifier TEXT NOT NULL,
      to_path TEXT,
      kind TEXT,
      is_external INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER,
      PRIMARY KEY (from_path, specifier)
    );
    CREATE INDEX IF NOT EXISTS idx_imports_from ON imports(from_path);
    CREATE INDEX IF NOT EXISTS idx_imports_to ON imports(to_path);

    CREATE TABLE IF NOT EXISTS exports (
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      updated_at_ms INTEGER,
      PRIMARY KEY (path, name, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_exports_path ON exports(path);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

async function loadDb(root) {
  const rootAbs = path.resolve(root);
  if (dbByRoot.has(rootAbs)) return dbByRoot.get(rootAbs);

  const SQL = await loadSqlJs();
  const p = graphDbPath(rootAbs);

  let db;
  if (fs.existsSync(p)) {
    const buf = fs.readFileSync(p);
    db = new SQL.Database(new Uint8Array(buf));
  } else {
    db = new SQL.Database();
  }
  ensureSchema(db);
  dbByRoot.set(rootAbs, db);
  return db;
}

async function persistDb(root) {
  const rootAbs = path.resolve(root);
  const db = await loadDb(rootAbs);
  const p = graphDbPath(rootAbs);
  const bytes = db.export(); // Uint8Array
  await fs.promises.writeFile(p, Buffer.from(bytes));
}

function upsertFile(db, { relPath, type, sizeBytes, mtimeMs }) {
  const now = Date.now();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO files(path, type, size_bytes, mtime_ms, updated_at_ms) VALUES (?,?,?,?,?)"
  );
  stmt.run([relPath, type || null, sizeBytes || 0, mtimeMs || 0, now]);
  stmt.free();
}

function deleteFile(db, relPath) {
  const delF = db.prepare("DELETE FROM files WHERE path = ?");
  delF.run([relPath]);
  delF.free();

  const delIFrom = db.prepare("DELETE FROM imports WHERE from_path = ?");
  delIFrom.run([relPath]);
  delIFrom.free();

  const delITo = db.prepare("DELETE FROM imports WHERE to_path = ?");
  delITo.run([relPath]);
  delITo.free();

  const delE = db.prepare("DELETE FROM exports WHERE path = ?");
  delE.run([relPath]);
  delE.free();
}

function replaceImports(db, fromRelPath, imports) {
  const del = db.prepare("DELETE FROM imports WHERE from_path = ?");
  del.run([fromRelPath]);
  del.free();

  if (!imports || !imports.length) return;
  const now = Date.now();
  const ins = db.prepare(
    "INSERT OR REPLACE INTO imports(from_path, specifier, to_path, kind, is_external, updated_at_ms) VALUES (?,?,?,?,?,?)"
  );

  for (const it of imports) {
    ins.run([
      fromRelPath,
      it.specifier,
      it.toPath || null,
      it.kind || null,
      it.isExternal ? 1 : 0,
      now,
    ]);
  }
  ins.free();
}

function replaceExports(db, relPath, exportsList) {
  const del = db.prepare("DELETE FROM exports WHERE path = ?");
  del.run([relPath]);
  del.free();

  if (!exportsList || !exportsList.length) return;
  const now = Date.now();
  const ins = db.prepare(
    "INSERT OR REPLACE INTO exports(path, name, kind, updated_at_ms) VALUES (?,?,?,?)"
  );
  for (const ex of exportsList) {
    ins.run([relPath, ex.name, ex.kind, now]);
  }
  ins.free();
}

function queryImports(db, relPath) {
  const out = [];
  const stmt = db.prepare(
    "SELECT specifier, to_path AS toPath, kind, is_external AS isExternal FROM imports WHERE from_path = ? ORDER BY specifier"
  );
  stmt.bind([relPath]);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function queryDependents(db, relPath) {
  const out = [];
  const stmt = db.prepare(
    "SELECT from_path AS fromPath, specifier, kind FROM imports WHERE to_path = ? ORDER BY from_path, specifier"
  );
  stmt.bind([relPath]);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function queryExports(db, relPath) {
  const out = [];
  const stmt = db.prepare(
    "SELECT name, kind FROM exports WHERE path = ? ORDER BY kind, name"
  );
  stmt.bind([relPath]);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function countFiles(db) {
  const stmt = db.prepare("SELECT COUNT(*) AS c FROM files");
  stmt.step();
  const c = Number(stmt.getAsObject().c || 0);
  stmt.free();
  return c;
}

function topExternalImports(db, limit = 15) {
  const out = [];
  const stmt = db.prepare(
    "SELECT specifier, COUNT(*) AS c FROM imports WHERE is_external = 1 GROUP BY specifier ORDER BY c DESC, specifier ASC LIMIT ?"
  );
  stmt.bind([limit]);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function hotFilesByImportCount(db, limit = 10) {
  const out = [];
  const stmt = db.prepare(
    "SELECT from_path AS path, COUNT(*) AS c FROM imports GROUP BY from_path ORDER BY c DESC, from_path ASC LIMIT ?"
  );
  stmt.bind([limit]);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function mostDependedOn(db, limit = 10) {
  const out = [];
  const stmt = db.prepare(
    "SELECT to_path AS path, COUNT(*) AS c FROM imports WHERE to_path IS NOT NULL GROUP BY to_path ORDER BY c DESC, to_path ASC LIMIT ?"
  );
  stmt.bind([limit]);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

module.exports = {
  graphDbPath,
  loadDb,
  persistDb,
  upsertFile,
  deleteFile,
  replaceImports,
  replaceExports,
  queryImports,
  queryDependents,
  queryExports,
  countFiles,
  topExternalImports,
  hotFilesByImportCount,
  mostDependedOn,
};

