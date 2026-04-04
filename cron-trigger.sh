#!/bin/bash
# 信用卡小蝦 Cron Trigger
# 每月1號 09:00 觸發
cd /Users/wuxiaoyin/.openclaw/workspace/bank-activities
node scrape-and-update.js 2>&1
