/**
 * Unfinished imports, kept in this browser (IndexedDB) so a push stopped by
 * Procore's rate limit can be resumed later, photos included, even after the
 * tab is closed. Cory chose browser storage over a server store, 2026-10-14:
 * it needs no Azure resource and keeps owners' documents off Buffalo's servers.
 * The cost is that a resume happens in the same browser on the same computer.
 *
 * One record per project. It holds ONLY items Procore never received: anything
 * created, and anything that "may already be in Procore" (a batch killed
 * mid-flight), is left out, because resuming those would duplicate punch items
 * and email the same subs twice.
 *
 * Every call here fails soft: private windows and blocked storage throw, and
 * a resume is a convenience, never something a push depends on.
 */

const DB = 'punch-list-assistant';
const STORE = 'unfinished-imports';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'projectId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function saveImport(record) {
  try {
    await run('readwrite', (s) => s.put(record));
    return true;
  } catch {
    return false;
  }
}

export async function loadImports() {
  try {
    return (await run('readonly', (s) => s.getAll())) || [];
  } catch {
    return [];
  }
}

export async function deleteImport(projectId) {
  try {
    await run('readwrite', (s) => s.delete(projectId));
  } catch {
    // Nothing to do: a record that cannot be deleted cannot be read either.
  }
}
