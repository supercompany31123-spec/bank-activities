/**
 * 信用卡電商活動爬蟲 + HTML 更新腳本
 * 每月 1號執行，爬取玉山/國泰活動，更新 bank-activities repo
 * 注意：會保留舊月份的資料，只更新當月
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ========== 工具：讀取舊 HTML 中的月份區塊 ==========
function extractOldMonthGroups(existingHtml, currentMonth) {
  const oldGroups = [];
  if (!existingHtml) return oldGroups;
  
  // 找每個 month-group div
  const regex = /<div class="month-group[^"]*"[^>]*data-month="([^"]+)"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*(?=<div class="(?:month-group|footer)")/gi;
  let match;
  while ((match = regex.exec(existingHtml)) !== null) {
    const month = match[1];
    if (month !== currentMonth) {
      // 補回結尾的 </div>（因為正則消耗了一個）
      oldGroups.push(match[0] + '</div>');
    }
  }
  return oldGroups;
}

function buildMonthGroupDiv(monthStr, content) {
  return `<div class="month-group" data-month="${monthStr}">\n                ${content}\n            </div>\n            <!-- /月份群組 -->`;
}

// ========== 1. 爬取國泰世華 ==========
async function scrapeCathay() {
  const BASE_URL = 'https://www.cathay-cube.com.tw/cathaybk/personal/event/overview';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log('[國泰] 導航...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  
  // 點擊「網購、APP」分類 tab
  const clicked = await page.evaluate(() => {
    const labels = document.querySelectorAll('label.cursor-\\[inherit\\]\\.select-none');
    for (const label of labels) {
      if (label.textContent.trim() === '網購、APP') {
        label.click();
        return true;
      }
    }
    return false;
  });
  if (clicked) {
    console.log('[國泰] 已點擊「網購、APP」tab');
    await page.waitForTimeout(3000);
  }
  
  const h3Selector = 'h3.mb-2\\.5.text-lg.leading-normal.font-cathay-medium';
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
      results.push({ name: act.name, url: act.url, raw: content });
    } catch (e) {
      console.log(`[國泰] 錯誤: ${e.message}`);
      results.push({ name: act.name, url: act.url, raw: '', error: e.message });
    }
  }
  
  await browser.close();
  return results;
}

// ========== 2. 爬取玉山銀行 ==========
async function scrapeEsun() {
  const BASE_URL = 'https://www.esunbank.com/zh-tw/personal/credit-card/discount/shops/all?category=onlineshop';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log('[玉山] 導航...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  
  const selector = 'p.l-cardDiscountAllContent__discount--title.h3';
  const keywords = ['蝦皮', '酷澎', 'momo', 'Shopee', 'Coupang'];
  const activities = await page.locator(selector).all();
  
  const filtered = [];
  for (const act of activities) {
    const text = await act.textContent();
    if (keywords.some(kw => text.toLowerCase().includes(kw.toLowerCase()))) {
      const parentA = await act.locator('xpath=ancestor::a').first();
      const href = await parentA.getAttribute('href');
      filtered.push({
        name: text.trim(),
        url: href ? `https://www.esunbank.com${href}` : null
      });
    }
  }
  
  const results = [];
  for (const act of filtered) {
    if (!act.url) continue;
    console.log(`[玉山] 爬取: ${act.name}`);
    try {
      await page.goto(act.url, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(1500);
      const content = await page.textContent('body');
      results.push({ name: act.name, url: act.url, raw: content });
    } catch (e) {
      console.log(`[玉山] 錯誤: ${e.message}`);
      results.push({ name: act.name, url: act.url, raw: '', error: e.message });
    }
  }
  
  await browser.close();
  return results;
}

// ========== 3. 解析活動內容 ==========
function parseActivity(raw, bank) {
  if (!raw) return { period: '', registration: '', tiers: [], needsInstallment: false, limit: '' };
  
  // 期間
  const periodMatch = raw.match(/(\d{4}\/\d{2}\/\d{2})\s*[~–]\s*(\d{4}\/\d{2}\/\d{2})/);
  const period = periodMatch ? `${periodMatch[1]} ~ ${periodMatch[2]}` : '';
  
  // 登錄時間
  let registration = '';
  if (bank === 'cathay') {
    const regMatch = raw.match(/(\d{1,2}\/\d{1,2})\s*\d{1,2}:\d{2}\s*[至到]\s*(\d{1,2}\/\d{1,2})\s*\d{1,2}:\d{2}/);
    registration = regMatch ? `${regMatch[1]} - ${regMatch[2]}` : '';
  } else {
    const regMatch = raw.match(/登錄\s*期間[：:]?\s*(\d{1,2}\/\d{1,2})\s*[\-~]\s*(\d{1,2}\/\d{1,2})/);
    registration = regMatch ? `${regMatch[1]} - ${regMatch[2]}` : '';
  }
  
  // 門檻/回饋
  const tiers = [];
  const tierRegex = bank === 'cathay'
    ? /滿NT?[\$]?([0-9,]+)(?:元|以上)[含]?[，]?(?:贈|回饋)[：:]?\s*(?:NT?[\$]?)?([0-9,]+)?\s*(?:點|元|蝦幣|刷卡金|小樹點)?/gi
    : /滿(NT)?[\$]?([0-9,]+)(?:元|以上)[，]?(?:贈|回饋)[：:]?\s*(?:NT)?([0-9,]+)?\s*(?:點|e\s*point|刷卡金|mo幣)?/gi;
  
  let tierMatch;
  while ((tierMatch = tierRegex.exec(raw)) !== null) {
    if (tierMatch[2]) {
      const reward = tierMatch[3] || '';
      tiers.push({ threshold: tierMatch[2], reward: reward.replace(/^\s+/, '') });
    }
  }
  
  // 是否分期
  const needsInstallment = /須分期|分期付款|分期3|分期6|分期9|分期12|分期24/.test(raw);
  
  // 限量
  const limitMatch = raw.match(/限量[名額]?([0-9,]+)[名]?/);
  const limit = limitMatch ? `限量 ${limitMatch[1]} 名` : '';
  
  return { period, registration, tiers, needsInstallment, limit };
}

// ========== 4. 渲染單一平台活動 ==========
function renderBankSection(data, bank, parseFn) {
  if (!data || data.length === 0) {
    return `<div class="activity"><div class="activity-title">⚠️ 目前無活動資訊</div><div class="activity-info"><span>請留意銀行官網或app通知</span></div></div>`;
  }
  
  let html = '';
  
  // 蝦皮
  const shopee = data.filter(a => /蝦皮|Shopee|shopee/i.test(a.name));
  if (shopee.length > 0) {
    html += '<div class="platform" data-platform="shopee"><div class="platform-name">🦐 蝦皮購物</div>';
    shopee.forEach(act => {
      const info = parseFn(act.raw, bank);
      const tags = info.needsInstallment ? '<span class="tag">需分期</span>' : '';
      let tiersHtml = info.tiers.map(t => 
        `<span><span class="label">門檻：</span>NT$${t.threshold} → ${t.reward}</span>`
      ).join('');
      html += `<div class="activity">
        <div class="activity-title">${act.name} ${tags}</div>
        <div class="activity-info">
          ${info.period ? `<span><span class="label">消費區間：</span>${info.period}</span>` : ''}
          ${tiersHtml}
          ${info.registration ? `<span><span class="label">登錄：</span>${info.registration}${info.limit ? `（${info.limit}）` : ''}</span>` : ''}
          ${info.limit && !info.registration ? `<span><span class="label">${info.limit}</span></span>` : ''}
        </div>
      </div>`;
    });
    html += '</div>';
  } else {
    html += `<div class="platform" data-platform="shopee"><div class="platform-name">🦐 蝦皮購物</div>
      <div class="activity"><div class="activity-title">⚠️ 無活動</div><div class="activity-info"><span>本月無蝦皮相關活動</span></div></div></div>`;
  }
  
  // momo
  const momo = data.filter(a => /momo|Momo/i.test(a.name));
  if (momo.length > 0) {
    html += '<div class="platform" data-platform="momo"><div class="platform-name">🛍️ momo購物</div>';
    momo.forEach(act => {
      const info = parseFn(act.raw, bank);
      const tags = info.needsInstallment ? '<span class="tag">需分期</span>' : '';
      let tiersHtml = info.tiers.map(t => 
        `<span><span class="label">門檻：</span>NT$${t.threshold} → ${t.reward}</span>`
      ).join('');
      html += `<div class="activity">
        <div class="activity-title">${act.name} ${tags}</div>
        <div class="activity-info">
          ${info.period ? `<span><span class="label">消費區間：</span>${info.period}</span>` : ''}
          ${tiersHtml}
          ${info.registration ? `<span><span class="label">登錄：</span>${info.registration}${info.limit ? `（${info.limit}）` : ''}</span>` : ''}
        </div>
      </div>`;
    });
    html += '</div>';
  } else {
    html += `<div class="platform" data-platform="momo"><div class="platform-name">🛍️ momo購物</div>
      <div class="activity"><div class="activity-title">⚠️ 無活動</div><div class="activity-info"><span>本月無momo相關活動</span></div></div></div>`;
  }
  
  // 酷澎
  const coupang = data.filter(a => /酷澎|Coupang/i.test(a.name));
  if (coupang.length > 0) {
    html += '<div class="platform" data-platform="coupang"><div class="platform-name">🚀 酷澎 Coupang</div>';
    coupang.forEach(act => {
      const info = parseFn(act.raw, bank);
      const tags = info.needsInstallment ? '<span class="tag">需分期</span>' : '';
      let tiersHtml = info.tiers.map(t => 
        `<span><span class="label">門檻：</span>NT$${t.threshold} → ${t.reward}</span>`
      ).join('');
      html += `<div class="activity">
        <div class="activity-title">${act.name} ${tags}</div>
        <div class="activity-info">
          ${info.period ? `<span><span class="label">消費區間：</span>${info.period}</span>` : ''}
          ${tiersHtml}
          ${info.registration ? `<span><span class="label">登錄：</span>${info.registration}${info.limit ? `（${info.limit}）` : ''}</span>` : ''}
        </div>
      </div>`;
    });
    html += '</div>';
  } else {
    html += `<div class="platform" data-platform="coupang"><div class="platform-name">🚀 酷澎 Coupang</div>
      <div class="activity"><div class="activity-title">⚠️ 無活動</div><div class="activity-info"><span>本月無酷澎相關活動</span></div></div></div>`;
  }
  
  return html;
}

// ========== 5. 完整 HTML 結構（保留舊月） ==========
function generateHTML(cathayData, esunData, updateDate, existingHtml) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthLabel = `${currentMonth.slice(0, 4)}年${parseInt(currentMonth.slice(5))}月`;
  const prevMonth = new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().slice(0, 7);
  const prevMonthLabel = `${prevMonth.slice(0, 4)}年${parseInt(prevMonth.slice(5))}月`;
  
  // 讀取舊月份的 month-group（排除當月）
  const oldGroups = extractOldMonthGroups(existingHtml || '', currentMonth);
  
  // 建立「上個月」的 option 標籤（如果還沒有）
  const hasPrevOption = existingHtml ? existingHtml.includes(`value="${prevMonth}"`) : false;
  const prevMonthOption = hasPrevOption ? '' : `<option value="${prevMonth}">${prevMonthLabel}</option>`;
  
  // 當月內容
  const currentMonthContent = `
                <div class="bank-section" data-bank="esun">
                    <div class="bank-title"><span class="bank-icon">🏦</span>玉山銀行</div>
                    ${renderBankSection(esunData, 'esun', parseActivity)}
                </div>
                <div class="bank-section" data-bank="cathay">
                    <div class="bank-title"><span class="bank-icon">💳</span>國泰世華銀行</div>
                    ${renderBankSection(cathayData, 'cathay', parseActivity)}
                </div>
  `;
  
  const currentMonthGroup = buildMonthGroupDiv(currentMonth, currentMonthContent);
  
  // 組合所有月份區塊
  const allMonthGroups = [currentMonthGroup, ...oldGroups].join('\n');
  
  const html = `<!DOCTYPE html>
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
        .activity-info { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; font-size: 0.9em; color: #555; }
        .activity-info span { display: flex; align-items: center; gap: 5px; }
        .label { font-weight: bold; color: #333; }
        .tag { display: inline-block; background: #667eea; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; margin-right: 5px; }
        .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 0.85em; }
        .hidden { display: none !important; }
        @media (max-width: 768px) { .container { flex-direction: column; } .sidebar { width: 100%; border-right: none; border-bottom: 1px solid #eee; } .activity-info { grid-template-columns: 1fr; } }
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
  
  return html;
}

// ========== 6. 主流程 ==========
async function main() {
  console.log('========== 開始更新信用卡活動 ==========');
  console.log(`時間: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
  
  const repoPath = __dirname;
  const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '/');
  
  // 讀取現有 HTML（用於保留舊月份）
  let existingHtml = '';
  const existingPath = path.join(repoPath, 'index.html');
  if (fs.existsSync(existingPath)) {
    existingHtml = fs.readFileSync(existingPath, 'utf8');
    console.log('📋 找到舊 HTML，將保留舊月份資料');
  }
  
  // 爬蟲
  const [cathayData, esunData] = await Promise.all([
    scrapeCathay().catch(e => { console.error('[國泰] 失敗:', e.message); return []; }),
    scrapeEsun().catch(e => { console.error('[玉山] 失敗:', e.message); return []; })
  ]);
  
  // 產生 HTML
  const html = generateHTML(cathayData, esunData, today, existingHtml);
  fs.writeFileSync(existingPath, html, 'utf8');
  console.log('✅ 已更新 index.html');
  
  // Git
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
}

main().catch(console.error);
