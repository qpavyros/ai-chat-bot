// تعقيم معرّف قبل استخدامه بمسار ملف — يمنع path traversal (مثلاً clientId="../../etc").
// مشترك بين customers.js، appointments.js، وprovisioning.js حتى ما يتكرر نفس المنطق
// بأكتر من مكان وينسى حدا تحديثه بواحد منهم.
function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

module.exports = { safeId };
