/**
 * Drive.gs — slip images under PO Desk/<Entity>/<YYYY>/<MM>/ (CLAUDE.md Flow 2 step 3).
 *
 * File name: <PO number>_<YYYY-MM-DD>_<supplier>_<total>.jpg. At upload the slip date and total are
 * not known yet, so the photo is saved as …_<upload date>_<supplier>_unreviewed.jpg and renamed to
 * the final pattern when the buyer saves the reviewed details.
 */

/** PO Desk/<Entity>/<YYYY>/<MM>, creating the year and month folders on first use. Caller holds the lock. */
function slipFolder_(entityId, when) {
  const ent = findBy('Entities', 'entity_id', entityId)[0];
  if (!ent || !ent.drive_folder_id) throw new AppError('SETUP_ORDER', 'The Drive folder for ' + entityId + ' is not set up. Run setupDrive().');
  const year = Utilities.formatDate(when, APP.TZ, 'yyyy');
  const month = Utilities.formatDate(when, APP.TZ, 'MM');
  const child = (parent, name) => { const it = parent.getFoldersByName(name); return it.hasNext() ? it.next() : parent.createFolder(name); };
  return child(child(DriveApp.getFolderById(ent.drive_folder_id), year), month);
}

/** Saves the JPEG bytes for a PO's slip. Returns the Drive file. */
function saveSlipImage_(po, bytes, when) {
  const folder = slipFolder_(po.entity_id, when);
  const name = slipFileName_(po, Utilities.formatDate(when, APP.TZ, 'yyyy-MM-dd'), null);
  return folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', name));
}

/** <PO number>_<YYYY-MM-DD>_<supplier>_<total>.jpg; total null -> "unreviewed". Safe for any file system. */
function slipFileName_(po, isoDate, total) {
  const supplier = String(po.supplier_name || 'supplier').normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'supplier';
  const amount = total === null || total === undefined ? 'unreviewed' : Number(total).toFixed(2);
  return [String(po.po_number || po.provisional_ref || 'PO'), isoDate, supplier, amount].join('_') + '.jpg';
}

function renameSlip_(fileId, name) {
  DriveApp.getFileById(fileId).setName(name);
}

/** Replaced photos go to the bin (recoverable for 30 days), never deleted outright. */
function trashSlip_(fileId) {
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (err) { console.warn('Could not trash slip ' + fileId + ': ' + err.message); }
}

function slipImageBase64_(fileId) {
  const blob = DriveApp.getFileById(fileId).getBlob();
  return { mimeType: blob.getContentType() || 'image/jpeg', base64: Utilities.base64Encode(blob.getBytes()) };
}
