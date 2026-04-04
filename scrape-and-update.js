/**
 * 信用卡電商活動爬蟲 + HTML 更新腳本 v3
 * 支援國泰/玉山的結構化資料解析
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ========== 工具：讀取舊 HTML 中的月份區塊 ==========
function extractOldMonthGroups(existingHtml, currentMonth) {
  const oldGroups = [];
  if (!existingHtml) return oldGroups;
  
  // 找所有 month-group div
  const monthGroupStarts = [];
  let idx = 0;
  while ((idx = existingHtml.indexOf('class="month-group', idx)) !== -1) {
    // 提取 data-month 值
    const monthMatch = existingHtml.slice(idx).match(/data-month="([^"]+)"/);
    if (monthMatch && monthMatch[1] !== currentMonth) {
      monthGroupStarts.push({ index: idx, month: monthMatch[1] });
    }
    idx++;
  }
  
  // 對每個找到的月份，提取完整的 month-group div
  for (const { index: startIdx, month } of monthGroupStarts) {
    // 從 startIdx 找到下一個 <div class="footer">，那之前就是這個 month-group 的結尾
    const footerIdx = existingHtml.indexOf('<div class="footer">', startIdx);
    if (footerIdx === -1) continue;
    
    // 在 startIdx 和 footerIdx之間，找到倒數第二個 </div>（month-group 的結尾）
    const segment = existingHtml.slice(startIdx, footerIdx);
    const lastDivIdx = segment.lastIndexOf('</div>');
    if (lastDivIdx === -1) continue;
    
    const monthGroupHtml = segment.slice(0, lastDivIdx) + '</div>';
    oldGroups.push(monthGroupHtml);
  }
  
  return oldGroups;
}

// ========== 1. 爬取國泰世華 ==========
async function scrapeCathay() {
  const BASE_URL = 'https://www.cathay-cube.com.tw/cathaybk/personal/event/overview';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log('[國泰] 導航...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
  // 等第一頁活動出現
  await page.waitForSelector('p.l-cardDiscountAllContent__discount--title.h3', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  
  // 點擊「網購、APP」分類 tab
  const clicked = await page.evaluate(() => {
    const labels = document.querySelectorAll('label.cursor-\\[inherit\\]\\.select-none');
    for (const label of labels) {
      if (label.textContent.trim() === '網購、APP') {
        const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
        label.dispatchEvent(evt);
        return true;
      }
    }
    return false;
  });
  if (clicked) {
    console.log('[國泰] 已點擊「網購、APP」tab');
    await page.waitForTimeout(3000);
  }
  
  // 點擊「展開更多」直到沒有為止
  let expandCount = 0;
  while (expandCount < 20) {
    try {
      const expandBtn = page.locator('button:has-text("展開更多")').first();
      const btnExists = await expandBtn.count();
      if (!btnExists) { console.log('[國泰] 無更多展開'); break; }
      await expandBtn.click();
      await page.waitForTimeout(800);
      expandCount++;
      const cnt = (await page.locator('h3[class*="mb-2"]').all()).length;
      console.log('[國泰] 展開 #' + expandCount + '，目前' + cnt + '個');
    } catch (e) { console.log('[國泰] 展開失敗: ' + e.message.substring(0, 40)); break; }
  }

  const h3Selector = 'h3[class*="mb-2"]';
  const keywords = ['蝦皮', '酷澎', 'momo'];
  const activities = await page.locator(h3Selector).all();
  
  const filtered = [];
  for (const act of activities) {
    const text = await act.textContent();
    if (keywords.some(kw => text.includes(kw))) {
      const parentA = await act.locator('xpath=ancestor::a').first();
      const href = await parentA.getAttribute('href');
      filtered.push({
        name: text.trim(),
        url: href ? new globalThis.URL(href, BASE_URL).href : null
      });
    }
  }
  
  const results = [];
  for (const act of filtered) {
    if (!act.url) continue;
    console.log(`[國泰] 爬取: ${act.name}`);
    try {
      await page.goto(act.url, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(1500);
      const content = await page.textContent('body');
      const parsed = parseCathayContent(act.name, content);
      results.push(parsed);
    } catch (e) {
      console.log(`[國泰] 錯誤: ${e.message}`);
    }
  }
  
  await browser.close();
  return results;
}

function parseCathayContent(name, raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  // 找活動期間
  let period = '';
  for (const line of lines) {
    const m = line.match(/(\d{4}\/\d{2}\/\d{2})\s*[~–]\s*(\d{4}\/\d{2}\/\d{2})/);
    if (m) { period = `${m[1]} ~ ${m[2]}`; break; }
  }
  
  // 找登錄時間 (4/21 16:00至04/30 23:59 或 2026/04/21 16:00至04/30)
  let registration = '';
  for (const line of lines) {
    // 標準格式: 04/21 16:00至04/30 23:59
    const m = line.match(/(\d{1,2}\/\d{1,2})\s*\d{1,2}:\d{2}\s*[至到]\s*(\d{1,2}\/\d{1,2})\s*\d{1,2}:\d{2}/);
    if (m) { registration = `${m[1]} - ${m[2]}`; break; }
    // 替代格式: 2026/4/20 16:00至23:59 (只有時間，沒有結束日期)
    const m2 = line.match(/(\d{1,2}\/\d{1,2})\s*\d{1,2}:\d{2}\s*[至到]\s*(\d{1,2}:\d{2})/);
    if (m2) { registration = `${m2[1]} - ${m2[2]}`; break; }
  }
  
  // 找限量
  let limit = '';
  for (const line of lines) {
    const m = line.match(/限量[名額]?\s*登錄\s*([0-9,]+)\s*名/);
    if (m) { limit = `限量 ${m[1]} 名`; break; }
  }
  
  // 找所有 ■, ◎, 1., 2. 開頭的活動條款
  const tiers = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const isBullet = trimmed.startsWith('■') || trimmed.startsWith('◎') || trimmed.match(/^[0-9]+\.\s*[^\d]/);
    if (isBullet && (trimmed.match(/滿NT|\d+[,，]\d+|消費|分期|贈|回饋|刷卡金|蝦幣|小樹點/) || trimmed.match(/[0-9]+元以上/))) {
      let clean = trimmed
        .replace(/^[■◎]\s*/, '')
        .replace(/^[0-9]+\.\s*/, '')
        .trim();
      if (clean.length > 10) tiers.push(clean.substring(0, 150));
    }
  }
  
  // 檢查是否分期
  const needsInstallment = /須分期|分期付款|限3、6|限3、6、24/.test(raw);
  
  return { name, period, registration, limit, needsInstallment, tiers, raw };
}

// ========== 2. 爬取玉山銀行 ==========
async function scrapeEsun() {
  const BASE_URL = 'https://www.esunbank.com/zh-tw/personal/credit-card/discount/shops/all?category=onlineshop';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log('[玉山] 導航...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
  // 等第一頁活動出現
  await page.waitForSelector('p.l-cardDiscountAllContent__discount--title.h3', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  
  const selector = 'p.l-cardDiscountAllContent__discount--title.h3';
  const keywords = ['蝦皮', '酷澎', 'momo', 'Shopee', 'Coupang'];

  // 【關鍵】分頁：收集所有頁面的電商活動
  const filtered = [];
  let pageNum = 1;
  let prevCount = 0;
  let prevPageActivities = [];

  while (true) {
    const currentUrl = page.url();
    const activities = await page.locator(selector).all();
    const count = activities.length;
    console.log('[玉山] 第' + pageNum + '頁，找到' + count + '個');

    for (const act of activities) {
      const text = await act.textContent();
      if (keywords.some(kw => text.toLowerCase().includes(kw.toLowerCase()))) {
        const parentA = await act.locator('xpath=ancestor::a').first();
        const href = await parentA.getAttribute('href');
        if (!filtered.find(a => a.url === 'https://www.esunbank.com' + href)) {
          filtered.push({ name: text.trim(), url: href ? 'https://www.esunbank.com' + href : null });
        }
      }
    }

    // 【停止條件】活動數沒增加就停止
    if (count === 0 || (count === prevCount && pageNum > 1)) {
      console.log('[玉山] 停止分頁 (count=' + count + ', prev=' + prevCount + ')');
      break;
    }
    prevCount = count;

    // 點下一頁
    const hasNext = await page.evaluate(() => {
      const btn = document.querySelector('li.page-item.next a');
      if (!btn) return false;
      btn.click();
      return true;
    });

    if (!hasNext) {
      console.log('[玉山] 沒有下一頁了');
      break;
    }

    pageNum++;
    if (pageNum > 10) { console.log('[玉山] 超過10頁，強制停止'); break; }
    await page.waitForTimeout(2000);
  }

  console.log('[玉山] 共找到' + filtered.length + '個電商活動');
  
  const results = [];
  for (const act of filtered) {
    if (!act.url) continue;
    console.log(`[玉山] 爬取: ${act.name}`);
    try {
      await page.goto(act.url, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(1500);
      const content = await page.textContent('body');
      const parsed = parseEsunContent(act.name, content);
      results.push(parsed);
    } catch (e) {
      console.log(`[玉山] 錯誤: ${e.message}`);
    }
  }
  
  await browser.close();
  return results;
}

function parseEsunContent(name, raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0 && l.length < 500);
  
  // 找活動期間
  let period = '';
  for (const line of lines) {
    const m = line.match(/活動期間[：:]\s*(\d{4}\/\d{1,2}\/\d{1,2})\s*[~-]\s*(\d{4}\/\d{1,2}\/\d{1,2})/);
    if (m) { period = `${m[1]} ~ ${m[2]}`; break; }
  }
  
  // 如果沒找到，試另一種格式
  if (!period) {
    for (const line of lines) {
      const m = line.match(/(\d{4}\/\d{1,2}\/\d{1,2})\s*[~-]\s*(\d{4}\/\d{1,2}\/\d{1,2})/);
      if (m && line.includes('活動期間')) { period = `${m[1]} ~ ${m[2]}`; break; }
    }
  }
  
  // 找登錄時間
  let registration = '';
  for (const line of lines) {
    const m = line.match(/登錄\s*辦法[：:]?\s*(\d{1,2}\/\d{1,2})\s*\d{1,2}:\d{2}\s*[~-]\s*(\d{1,2}\/\d{1,2})\s*\d{1,2}:\d{2}/);
    if (m) { registration = `${m[1]} - ${m[2]}`; break; }
  }
  // 另一種格式
  if (!registration) {
    for (const line of lines) {
      const m = line.match(/(\d{1,2}\/\d{1,2})\s*\d{1,2}:\d{2}\s*[~-]\s*(\d{1,2}\/\d{1,2})\s*\d{1,2}:\d{2}/);
      if (m) { registration = `${m[1]} - ${m[2]}`; break; }
    }
  }
  
  // 找限量
  let limit = '';
  for (const line of lines) {
    const m = line.match(/限量[名額]?\s*([0-9,]+)\s*名/);
    if (m) { limit = `限量 ${m[1]} 名`; break; }
  }
  
  // 找活動條款 (找包含關鍵字的小段落)
  const tiers = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 15 && trimmed.length < 200 &&
        (trimmed.match(/滿[\$]?[0-9]|分期|單筆|贈[0-9]|回饋[0-9]|最高享|刷卡金/))) {
      tiers.push(trimmed.replace(/\s+/g, ' ').substring(0, 120));
    }
  }
  
  const needsInstallment = /分期/.test(raw);
  
  return { name, period, registration, limit, needsInstallment, tiers, raw };
}

// ========== 3. 解析門檻與回饋 ==========
function parseTiers(tiers, bank) {
  // 從 raw tier 行解析出门檻和回饋
  const results = [];
  for (const tier of tiers) {
    if (!tier.includes('滿') && !tier.includes('贈')) {
      results.push({ threshold: '', reward: tier.substring(0, 50) });
      continue;
    }
    
    // 基於 "贈" 分割字串
    const parts = tier.split('贈');
    const before = parts[0] || '';
    const after = parts[1] || '';
    
    // 門檻：從前面提取金額
    let threshold = '';
    const nums = before.match(/[0-9,]+/g);
    if (nums && nums.length > 0) {
      // 取倒數第二個（倒數第一個可能是括號內的數量）
      threshold = nums[nums.length - 1] + '元';
    }
    
    // 回饋：從後面提取
    let reward = '';
    const rewardNumMatch = after.match(/NT?\$?([0-9,]+)|([0-9,]+)(?:點|元|刷卡金|蝦幣|e\s*point)/);
    if (rewardNumMatch) {
      const num = rewardNumMatch[1] || rewardNumMatch[2];
      if (after.includes('點') || after.includes('e point')) reward = num + '點';
      else if (after.includes('刷卡金')) reward = num + '元刷卡金';
      else if (after.includes('蝦幣')) reward = num + '蝦幣';
      else if (after.includes('小樹點') || after.includes('小樹點(信用卡)')) reward = num + '點小樹點';
      else reward = num + '元';
    } else if (after.trim()) {
      reward = after.trim().substring(0, 40);
    }
    
    results.push({ threshold, reward });
  }
  return results;
}

// ========== 4. 渲染函式 ==========
function renderBankSection(data, bank) {
  if (!data || data.length === 0) {
    return `<div class="activity"><div class="activity-title">⚠️ 目前無活動資訊</div><div class="activity-info"><span>請留意銀行官網或app通知</span></div></div>`;
  }
  
  let html = '';
  
  // 蝦皮
  const shopee = data.filter(a => /蝦皮|Shopee|shopee/i.test(a.name));
  html += '<div class="platform" data-platform="shopee"><div class="platform-name">🦐 蝦皮購物</div>';
  if (shopee.length > 0) {
    shopee.forEach(act => {
      const tags = act.needsInstallment ? '<span class="tag">需分期</span>' : '';
      const parsed = parseTiers(act.tiers, bank);
      let tiersHtml = '';
      if (parsed.length > 0 && parsed[0].threshold) {
        parsed.forEach(p => {
          if (p.threshold) tiersHtml += `<span><span class="label">門檻：</span>${p.threshold}</span>`;
          if (p.reward) tiersHtml += `<span><span class="label">回饋：</span>${p.reward}</span>`;
        });
      } else {
        // fallback: 直接輸出 tier
        act.tiers.slice(0, 2).forEach(t => {
          tiersHtml += `<span>${t}</span>`;
        });
      }
      html += `<div class="activity">
        <div class="activity-title">${act.name} ${tags}</div>
        <div class="activity-info">
          ${act.period ? `<span><span class="label">消費區間：</span>${act.period}</span>` : ''}
          ${tiersHtml}
          ${act.registration ? `<span><span class="label">登錄：</span>${act.registration}${act.limit ? `（${act.limit}）` : ''}</span>` : ''}
          ${act.limit && !act.registration ? `<span><span class="label">${act.limit}</span></span>` : ''}
          ${act.needsInstallment ? `<span><span class="label">分期：</span>✅ 可</span>` : ''}
        </div>
      </div>`;
    });
  } else {
    html += `<div class="activity"><div class="activity-title">⚠️ 無活動</div><div class="activity-info"><span>本月無蝦皮相關活動</span></div></div>`;
  }
  html += '</div>';
  
  // momo
  const momo = data.filter(a => /momo|Momo/i.test(a.name));
  html += '<div class="platform" data-platform="momo"><div class="platform-name">🛍️ momo購物</div>';
  if (momo.length > 0) {
    momo.forEach(act => {
      const tags = act.needsInstallment ? '<span class="tag">需分期</span>' : '';
      const parsed = parseTiers(act.tiers, bank);
      let tiersHtml = '';
      if (parsed.length > 0 && parsed[0].threshold) {
        parsed.forEach(p => {
          if (p.threshold) tiersHtml += `<span><span class="label">門檻：</span>${p.threshold}</span>`;
          if (p.reward) tiersHtml += `<span><span class="label">回饋：</span>${p.reward}</span>`;
        });
      } else {
        act.tiers.slice(0, 2).forEach(t => {
          tiersHtml += `<span>${t}</span>`;
        });
      }
      html += `<div class="activity">
        <div class="activity-title">${act.name} ${tags}</div>
        <div class="activity-info">
          ${act.period ? `<span><span class="label">消費區間：</span>${act.period}</span>` : ''}
          ${tiersHtml}
          ${act.registration ? `<span><span class="label">登錄：</span>${act.registration}${act.limit ? `（${act.limit}）` : ''}</span>` : ''}
          ${act.needsInstallment ? `<span><span class="label">分期：</span>✅ 可</span>` : ''}
        </div>
      </div>`;
    });
  } else {
    html += `<div class="activity"><div class="activity-title">⚠️ 無活動</div><div class="activity-info"><span>本月無momo相關活動</span></div></div>`;
  }
  html += '</div>';
  
  // 酷澎
  const coupang = data.filter(a => /酷澎|Coupang/i.test(a.name));
  html += '<div class="platform" data-platform="coupang"><div class="platform-name">🚀 酷澎 Coupang</div>';
  if (coupang.length > 0) {
    coupang.forEach(act => {
      const tags = act.needsInstallment ? '<span class="tag">需分期</span>' : '';
      const parsed = parseTiers(act.tiers, bank);
      let tiersHtml = '';
      if (parsed.length > 0 && parsed[0].threshold) {
        parsed.forEach(p => {
          if (p.threshold) tiersHtml += `<span><span class="label">門檻：</span>${p.threshold}</span>`;
          if (p.reward) tiersHtml += `<span><span class="label">回饋：</span>${p.reward}</span>`;
        });
      } else {
        act.tiers.slice(0, 2).forEach(t => {
          tiersHtml += `<span>${t}</span>`;
        });
      }
      html += `<div class="activity">
        <div class="activity-title">${act.name} ${tags}</div>
        <div class="activity-info">
          ${act.period ? `<span><span class="label">消費區間：</span>${act.period}</span>` : ''}
          ${tiersHtml}
          ${act.registration ? `<span><span class="label">登錄：</span>${act.registration}${act.limit ? `（${act.limit}）` : ''}</span>` : ''}
          ${act.needsInstallment ? `<span><span class="label">分期：</span>✅ 可</span>` : ''}
        </div>
      </div>`;
    });
  } else {
    html += `<div class="activity"><div class="activity-title">⚠️ 無活動</div><div class="activity-info"><span>本月無酷澎相關活動</span></div></div>`;
  }
  html += '</div>';
  
  return html;
}

// ========== 4. 完整 HTML 結構 ==========
function generateHTML(cathayData, esunData, updateDate, existingHtml) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthLabel = `${currentMonth.slice(0, 4)}年${parseInt(currentMonth.slice(5))}月`;
  const prevMonth = new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().slice(0, 7);
  const prevMonthLabel = `${prevMonth.slice(0, 4)}年${parseInt(prevMonth.slice(5))}月`;
  
  const oldGroups = extractOldMonthGroups(existingHtml || '', currentMonth);
  const hasPrevOption = existingHtml ? existingHtml.includes(`value="${prevMonth}"`) : false;
  const prevMonthOption = hasPrevOption ? '' : `<option value="${prevMonth}">${prevMonthLabel}</option>`;
  
  const currentMonthContent = `
                <div class="bank-section" data-bank="esun">
                    <div class="bank-title"><span class="bank-icon">🏦</span>玉山銀行</div>
                    ${renderBankSection(esunData, 'esun')}
                </div>
                <div class="bank-section" data-bank="cathay">
                    <div class="bank-title"><span class="bank-icon">💳</span>國泰世華銀行</div>
                    ${renderBankSection(cathayData, 'cathay')}
                </div>
  `;
  
  const currentMonthGroup = `<div class="month-group" data-month="${currentMonth}">
                ${currentMonthContent}
            </div>`;
  
  const allMonthGroups = [currentMonthGroup, ...oldGroups].join('\n');
  
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>信用卡電商活動整理</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: "PingFang TC", "Microsoft JhengHei", sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 1000px; margin: 0 auto; background: white; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); overflow: hidden; display: flex; }
        .sidebar { width: 240px; background: #f8f9fa; padding: 20px; border-right: 1px solid #eee; }
        .sidebar h3 { font-size: 1em; color: #333; margin-bottom: 12px; margin-top: 15px; }
        .sidebar h3:first-child { margin-top: 0; }
        .filter-group label { display: block; padding: 10px 15px; margin-bottom: 6px; border-radius: 8px; cursor: pointer; transition: all 0.3s; color: #555; font-size: 0.95em; }
        .filter-group label:hover { background: #e9ecef; }
        .filter-group input[type="checkbox"] { display: none; }
        .filter-group label span { display: block; padding: 10px 15px; margin-bottom: 6px; border-radius: 8px; background: white; transition: all 0.3s; font-size: 0.95em; }
        .filter-group input[type="checkbox"]:checked + span { background: #667eea; color: white; }
        .month-select { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #ddd; font-size: 1em; background: white; cursor: pointer; margin-bottom: 10px; }
        .main-content { flex: 1; padding: 30px; max-height: 90vh; overflow-y: auto; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 20px 20px 0 0; }
        .header h1 { font-size: 1.8em; margin-bottom: 10px; }
        .header p { opacity: 0.9; font-size: 1em; }
        .bank-section { padding: 20px 0; border-bottom: 1px solid #eee; }
        .bank-section:last-child { border-bottom: none; }
        .bank-title { font-size: 1.5em; color: #333; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; }
        .bank-icon { font-size: 1.3em; }
        .platform { margin-bottom: 25px; }
        .platform-name { font-size: 1.2em; color: #667eea; margin-bottom: 15px; font-weight: bold; }
        .activity { background: #f8f9fa; border-radius: 12px; padding: 18px; margin-bottom: 15px; border-left: 4px solid #667eea; }
        .activity-title { font-weight: bold; font-size: 1.05em; color: #333; margin-bottom: 10px; }
        .activity-info { display: flex; flex-direction: column; gap: 6px; font-size: 0.9em; color: #555; }
        .activity-info > div { padding: 2px 0; }
        .activity-info span { display: inline; }
        .label { font-weight: bold; color: #333; }
        .tier-section { margin-bottom: 8px; }
        .tier-items { padding-left: 10px; }
        .tier-item { padding: 2px 0; }
        .tag { display: inline-block; background: #667eea; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; margin-right: 5px; }
        .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 0.85em; }
        .hidden { display: none !important; }
        @media (max-width: 768px) { .container { flex-direction: column; } .sidebar { width: 100%; border-right: none; border-bottom: 1px solid #eee; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="sidebar">
            <h3>📅 選擇月份</h3>
            <select class="month-select" id="monthSelect" onchange="filterByMonth()">
                <option value="${currentMonth}" selected>${monthLabel}（最新）</option>
                ${prevMonthOption}
            </select>
            <h3>🏷️ 篩選電商平台</h3>
            <div class="filter-group">
                <label><input type="checkbox" id="filter-shopee" checked onchange="filterActivities()"><span>🦐 蝦皮購物</span></label>
                <label><input type="checkbox" id="filter-momo" checked onchange="filterActivities()"><span>🛍️ momo購物</span></label>
                <label><input type="checkbox" id="filter-coupang" checked onchange="filterActivities()"><span>🚀 酷澎</span></label>
            </div>
            <h3>🏦 篩選銀行</h3>
            <div class="filter-group">
                <label><input type="checkbox" id="filter-esun" checked onchange="filterActivities()"><span>🏦 玉山銀行</span></label>
                <label><input type="checkbox" id="filter-cathay" checked onchange="filterActivities()"><span>💳 國泰世華</span></label>
            </div>
        </div>
        <div class="main-content">
            <div class="header">
                <h1>💳 信用卡電商活動整理</h1>
                <p>玉山銀行 x 國泰世華銀行</p>
            </div>
            ${allMonthGroups}
            <div class="footer">
                <p>⚠️ 活動內容可能隨時變動，請以官方公告為準</p>
                <p>資料更新日期：${updateDate}</p>
            </div>
        </div>
    </div>
    <script>
        function filterByMonth() { const sm = document.getElementById('monthSelect').value; document.querySelectorAll('.month-group').forEach(g => g.getAttribute('data-month') === sm ? g.classList.remove('hidden') : g.classList.add('hidden')); filterActivities(); }
        function filterActivities() { const ss = document.getElementById('filter-shopee').checked, sm = document.getElementById('filter-momo').checked, sc = document.getElementById('filter-coupang').checked, se = document.getElementById('filter-esun').checked, cc = document.getElementById('filter-cathay').checked; document.querySelectorAll('.platform').forEach(p => { const n = p.getAttribute('data-platform'); if (n === 'shopee' && !ss || n === 'momo' && !sm || n === 'coupang' && !sc) p.classList.add('hidden'); else p.classList.remove('hidden'); }); document.querySelectorAll('.bank-section').forEach(b => { const n = b.getAttribute('data-bank'); if (n === 'esun' && !se || n === 'cathay' && !cc) b.classList.add('hidden'); else b.classList.remove('hidden'); }); }
        filterByMonth();
    </script>
</body>
</html>`;
}

// ========== 5. 主流程 ==========
async function main() {
  console.log('========== 開始更新信用卡活動 ==========');
  console.log(`時間: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
  
  const repoPath = __dirname;
  const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '/');
  
  let existingHtml = '';
  const existingPath = path.join(repoPath, 'index.html');
  if (fs.existsSync(existingPath)) {
    existingHtml = fs.readFileSync(existingPath, 'utf8');
    console.log('📋 找到舊 HTML，將保留舊月份資料');
  }
  
  const esunData = await scrapeEsun().catch(e => { console.error('[玉山] 失敗:', e.message); return []; });
  const cathayData = await scrapeCathay().catch(e => { console.error('[國泰] 失敗:', e.message); return []; });
  
  const html = generateHTML(cathayData, esunData, today, existingHtml);
  fs.writeFileSync(existingPath, html, 'utf8');
  console.log('✅ 已更新 index.html');
  
  try {
    execSync('git config user.email "shaxia-agent@openclaw.ai"', { cwd: repoPath });
    execSync('git config user.name "蝦蝦 Agent"', { cwd: repoPath });
    execSync('git add index.html', { cwd: repoPath });
    execSync(`git commit -m "Update activities - ${today}"`, { cwd: repoPath });
    execSync('git push', { cwd: repoPath });
    console.log('✅ 已推送到 GitHub');
  } catch (e) {
    console.error('⚠️ Git 操作失敗:', e.message);
  }
  
  console.log('\n========== 更新摘要 ==========');
  console.log(`國泰世華: ${cathayData.length} 個活動`);
  console.log(`玉山銀行: ${esunData.length} 個活動`);
  console.log(`GitHub Pages: https://supercompany31123-spec.github.io/bank-activities/`);
  
  // Debug: 顯示解析結果
  if (cathayData.length > 0) {
    console.log('\n--- 國泰解析結果 ---');
    cathayData.forEach(a => {
      console.log(`[${a.name}]`);
      console.log(`  期間: ${a.period} | 登錄: ${a.registration} ${a.limit}`);
      console.log(`  分期: ${a.needsInstallment} | 條款數: ${a.tiers.length}`);
      a.tiers.slice(0, 2).forEach(t => console.log(`  - ${t.substring(0, 80)}`));
    });
  }
  if (esunData.length > 0) {
    console.log('\n--- 玉山解析結果 ---');
    esunData.forEach(a => {
      console.log(`[${a.name}]`);
      console.log(`  期間: ${a.period} | 登錄: ${a.registration} ${a.limit}`);
      console.log(`  分期: ${a.needsInstallment} | 條款數: ${a.tiers.length}`);
      a.tiers.slice(0, 2).forEach(t => console.log(`  - ${t.substring(0, 80)}`));
    });
  }
}

main().catch(console.error);
