// غلاف لمعالجات الـroutes غير المتزامنة — Express 4 ما بيلتقط الاستثناءات يلي بترميها
// الدوال async (بيرميها unhandled rejection والطلب بيضل معلّق بدون رد أبداً). الغلاف
// بيمرر الخطأ لـnext() فيوصل لمعالج الأخطاء المركزي بserver.js.
//
// الاستخدام: router.post("/x", requireAuth, asyncHandler(async (req, res) => {...}))
module.exports = function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};
