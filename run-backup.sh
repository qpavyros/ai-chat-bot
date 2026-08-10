#!/bin/bash
# نسخة احتياطية يومية لبيانات العملاء الحية (مواعيد/طلبات/ملفات زبائن + config/knowledge) —
# عالفرع data-backup بنفس مستودع GitHub الخاص، منفصل تمامًا عن فرع الكود (master).
set -e
cd /opt/backup-repo

rm -rf data clients
cp -r /opt/ai-chat-bot/data ./data 2>/dev/null || mkdir -p data
cp -r /opt/ai-chat-bot/src/clients ./clients

git add -A
if git diff --cached --quiet; then
  echo "$(date -Iseconds) — لا تغييرات، تم التخطي"
  exit 0
fi

git commit -q -m "backup: $(date -Iseconds)"
git push -q origin data-backup
echo "$(date -Iseconds) — نسخة احتياطية انرفعت بنجاح"
