// ============================================================================
// 云端观赛提醒（GitHub Actions 版）
// 功能与本地版一致：曼城（英超/足总杯/联赛杯/欧冠）+ MotoGP（GP 组别全环节）
// 每天/每 15 分钟在 GitHub 云端运行，与你的电脑完全无关：
//   1) 前一天（北京日历日）推送"明天开赛"提醒
//   2) 开赛前约 1 小时推送手机提醒（Bark / ntfy）
// 运行：node src/reminder.mjs （本地可用 DRY_RUN=1 试运行，不真发推送）
// ============================================================================
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 配置（环境变量）
// ---------------------------------------------------------------------------
const BARK_KEY = process.env.BARK_KEY || '';
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NOTIFY_ALL_SESSIONS = String(process.env.NOTIFY_ALL_SESSIONS || '') === '1';
const DRY_RUN = process.env.DRY_RUN === '1';
const STATE_FILE = path.join(__dirname, '..', 'state', 'reminded.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// ---------------------------------------------------------------------------
// 北京时间工具（UTC+8 固定无夏令时，纯算术）
// ---------------------------------------------------------------------------
const BJ_OFFSET = 8 * 3600 * 1000;
const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function toBJ(d) { return new Date(d.getTime() + BJ_OFFSET); }
function bjDateKey(d) { return toBJ(new Date(d)).toISOString().slice(0, 10); }
function todayBJKey() { return bjDateKey(new Date()); }
function formatBJ(d) {
  const b = toBJ(new Date(d));
  const iso = b.toISOString();
  const [y, m, dd] = iso.slice(0, 10).split('-').map(Number);
  const hhmm = iso.slice(11, 16);
  const wd = WEEK_CN[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
  return `${y}年${m}月${dd}日 ${wd} ${hhmm}`;
}
function daysBetween(aKey, bKey) {
  const a = Date.UTC(+aKey.slice(0, 4), +aKey.slice(5, 7) - 1, +aKey.slice(8, 10));
  const b = Date.UTC(+bKey.slice(0, 4), +bKey.slice(5, 7) - 1, +bKey.slice(8, 10));
  return Math.round((b - a) / 86400000);
}
function pad(n) { return String(n).padStart(2, '0'); }
function normTitle(s) { return String(s || '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, ''); }
function log(...a) { console.log(new Date().toISOString(), ...a); }

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------
async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json,*/*' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}
async function fetchJson(url) { return JSON.parse(await fetchText(url)); }

// ---------------------------------------------------------------------------
// 球队名中文映射
// ---------------------------------------------------------------------------
const TEAM_CN = {
  'manchester city': '曼城', 'arsenal': '阿森纳', 'aston villa': '阿斯顿维拉',
  'bournemouth': '伯恩茅斯', 'brentford': '布伦特福德', 'brighton': '布莱顿',
  'chelsea': '切尔西', 'crystal palace': '水晶宫', 'everton': '埃弗顿',
  'fulham': '富勒姆', 'ipswich': '伊普斯维奇', 'leeds': '利兹联',
  'leicester': '莱斯特城', 'liverpool': '利物浦', 'manchester united': '曼联',
  'newcastle': '纽卡斯尔', 'nottingham forest': '诺丁汉森林', 'southampton': '南安普顿',
  'sunderland': '桑德兰', 'tottenham': '热刺', 'west ham': '西汉姆联',
  'wolves': '狼队', 'hull': '赫尔城', 'coventry': '考文垂',
};
function teamCN(name) {
  const low = String(name || '').toLowerCase();
  for (const [k, v] of Object.entries(TEAM_CN)) { if (low.includes(k)) return v; }
  return String(name || '').replace(/\bAFC\b|\bFC\b|\bCF\b/g, '').trim();
}
function competitionCN(raw) {
  const s = (raw || '').toLowerCase();
  if (s.includes('premier league')) return '英超';
  if (s.includes('fa cup')) return '足总杯';
  if (s.includes('efl') || s.includes('carabao') || s.includes('league cup')) return '联赛杯';
  if (s.includes('champions league')) return '欧冠';
  if (s.includes('europa league')) return '欧联杯';
  if (s.includes('community shield')) return '社区盾';
  if (s.includes('club world cup')) return '世俱杯';
  return s;
}

// ---------------------------------------------------------------------------
// 数据源 1：曼城 — ESPN 比分板（英超/足总杯/欧冠/联赛杯）
// ---------------------------------------------------------------------------
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const CITY_COMP_QUERIES = [
  { slug: 'eng.1', cn: '英超' },
  { slug: 'eng.fa', cn: '足总杯' },
  { slug: 'uefa.champions', cn: '欧冠' },
  { slug: 'eng.efl', cn: '联赛杯' },
];
function monthRanges(months) {
  const now = new Date();
  const arr = [];
  for (let i = 0; i < months; i++) {
    const y = now.getFullYear(), m = now.getMonth() + i;
    const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12 + 1;
    const days = new Date(yy, mm, 0).getDate();
    arr.push({ from: `${yy}${pad(mm)}01`, to: `${yy}${pad(mm)}${pad(days)}` });
  }
  return arr;
}
function parseEspnEvent(e, compCN) {
  const comp = (e.competitions && e.competitions[0]) || {};
  const comps = comp.competitors || [];
  const home = comps.find((c) => c.homeAway === 'home');
  const away = comps.find((c) => c.homeAway === 'away');
  if (!home || !away || !e.date) return null;
  const hName = (home.team && home.team.displayName) || '';
  const aName = (away.team && away.team.displayName) || '';
  if (!hName.includes('Manchester City') && !aName.includes('Manchester City')) return null;
  const start = new Date(e.date);
  if (isNaN(start.getTime())) return null;
  const st = (comp.status && comp.status.type) || {};
  const state = String(st.state || '').toLowerCase();
  const name = String(st.name || '').toLowerCase();
  const status = state === 'post' || st.completed === true ? 'finished'
    : name.includes('postponed') || name.includes('cancelled') ? 'postponed'
    : state === 'in' || name.includes('progress') ? 'live'
    : 'upcoming';
  return {
    id: 'city-' + e.id, sport: 'city', competition: compCN,
    round: (comp.notes && comp.notes[0] && comp.notes[0].headline) ? String(comp.notes[0].headline).trim() : '',
    title: `${teamCN(hName)} vs ${teamCN(aName)}`,
    startUtc: start.toISOString(), status, timeKnown: true, sessionType: 'comp',
  };
}
async function fetchManCity() {
  const ranges = monthRanges(3);
  const all = [];
  for (const comp of CITY_COMP_QUERIES) {
    const tasks = ranges.map((r) => ({ comp, r }));
    const results = await Promise.all(tasks.map(async ({ comp, r }) => {
      try {
        const data = await fetchJson(`${ESPN_BASE}/${comp.slug}/scoreboard?dates=${r.from}-${r.to}`);
        return ((data && data.events) || []).map((e) => parseEspnEvent(e, comp.cn)).filter(Boolean);
      } catch (e) {
        if (String(e.message).includes('HTTP 4')) return null;
        return [];
      }
    }));
    if (results.some((r) => r === null)) continue;
    all.push(...results.flat());
  }
  const seen = new Set();
  const out = [];
  for (const ev of all) {
    const k = ev.sport + '|' + ev.title + '|' + ev.startUtc;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ev);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 数据源 2：MotoGP — motorsport.com 官方赛历（JSON-LD）+ 内置各站时刻表
// ---------------------------------------------------------------------------
const MGP_GP_CN = {
  thailand: '泰国大奖赛', brazil: '巴西大奖赛', americas: '美洲大奖赛',
  spanish: '西班牙大奖赛', french: '法国大奖赛', catalan: '加泰罗尼亚大奖赛',
  italian: '意大利大奖赛', hungarian: '匈牙利大奖赛', czech: '捷克大奖赛',
  dutch: '荷兰大奖赛', german: '德国大奖赛', british: '英国大奖赛',
  aragon: '阿拉贡大奖赛', 'san marino': '圣马力诺大奖赛', austrian: '奥地利大奖赛',
  japanese: '日本大奖赛', indonesian: '印度尼西亚大奖赛', australian: '澳大利亚大奖赛',
  malaysian: '马来西亚大奖赛', qatar: '卡塔尔大奖赛', portuguese: '葡萄牙大奖赛',
  valencia: '瓦伦西亚大奖赛',
};
// 各站正赛当地开赛时刻 + 时区（与本地内置数据一致；未知新站用默认值）
const MGP_ROUND_TIMES = {
  thailand: { o: 7, r: '15:00' }, brazil: { o: -3, r: '14:00' }, americas: { o: -5, r: '14:00' },
  spanish: { o: 2, r: '14:00' }, french: { o: 2, r: '14:00' }, catalan: { o: 2, r: '14:00' },
  italian: { o: 2, r: '14:00' }, hungarian: { o: 2, r: '14:00' }, czech: { o: 2, r: '14:00' },
  dutch: { o: 2, r: '14:00' }, german: { o: 2, r: '14:00' }, british: { o: 1, r: '14:00' },
  aragon: { o: 2, r: '14:00' }, 'san marino': { o: 2, r: '14:00' }, austrian: { o: 2, r: '14:00' },
  japanese: { o: 9, r: '14:00' }, indonesian: { o: 8, r: '14:00' }, australian: { o: 11, r: '14:00' },
  malaysian: { o: 8, r: '14:00' }, qatar: { o: 3, r: '19:00' }, portuguese: { o: 0, r: '14:00' },
  valencia: { o: 1, r: '14:00' },
};
const MGP_SESSION_PROFILES = {
  aragon: {
    o: 2,
    fri: [['fp1', 'FP1 练习赛', '10:45'], ['pr', '练习（PR）', '15:00']],
    sat: [['fp2', 'FP2 练习赛', '10:10'], ['q', '排位赛（Q1/Q2）', '10:50'], ['sprint', '冲刺赛', '15:00']],
    sun: [['wup', '热身（Warm-up）', '09:40']],
  },
  british: {
    o: 1,
    fri: [['fp1', 'FP1 练习赛', '11:45'], ['pr', '练习（PR）', '16:00']],
    sat: [['fp2', 'FP2 练习赛', '11:10'], ['q', '排位赛（Q1/Q2）', '11:50'], ['sprint', '冲刺赛', '16:00']],
    sun: [['wup', '热身（Warm-up）', '09:40']],
  },
  qatar: {
    o: 3,
    fri: [['fp1', 'FP1 练习赛', '17:00'], ['pr', '练习（PR）', '21:00']],
    sat: [['fp2', 'FP2 练习赛', '16:10'], ['q', '排位赛（Q1/Q2）', '17:50'], ['sprint', '冲刺赛', '21:00']],
    sun: [['wup', '热身（Warm-up）', '15:40']],
  },
  default: {
    o: 2,
    fri: [['fp1', 'FP1 练习赛', '10:45'], ['pr', '练习（PR）', '15:00']],
    sat: [['fp2', 'FP2 练习赛', '10:10'], ['q', '排位赛（Q1/Q2）', '10:50'], ['sprint', '冲刺赛', '15:00']],
    sun: [['wup', '热身（Warm-up）', '09:40']],
  },
};
function mgpToken(name) {
  return String(name || '').split(',')[0].trim().toLowerCase().replace(/ gp$/, '').replace(/\s+/g, ' ');
}
async function fetchMotogpRounds() {
  const year = new Date().getFullYear();
  const html = await fetchText(`https://www.motorsport.com/motogp/schedule/${year}/?event_types%5B0%5D=race`, 20000);
  const blocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const found = [];
  for (const b of blocks) {
    try {
      const j = JSON.parse(b);
      const graph = j['@graph'] || [j];
      for (const item of graph) {
        if (item['@type'] !== 'SportsEvent' || !item.name) continue;
        if (!String(item.name).toLowerCase().includes('motogp')) continue;
        const end = item.endDate || item.startDate;
        if (!end) continue;
        found.push({ rawName: item.name, raceDay: String(end).slice(0, 10) });
      }
    } catch { /* 忽略单个块 */ }
  }
  if (!found.length) throw new Error('未找到 ' + year + ' 赛季赛历');
  found.sort((a, b) => a.raceDay.localeCompare(b.raceDay));
  return found.map((f, i) => {
    const token = mgpToken(f.rawName);
    const cn = MGP_GP_CN[token] || (token.split(' ')[0] && MGP_GP_CN[token.split(' ')[0]]) || f.rawName.replace(/, MotoGP - \d{4}/, '');
    return { token, title: cn, round: `第${i + 1}站`, rawName: f.rawName, raceDay: f.raceDay };
  });
}
// 生成一个分站的全部环节（含正赛）
function expandSessions(round) {
  const t = normTitle(round.title);
  const profile = /阿拉贡|aragon/.test(t) ? MGP_SESSION_PROFILES.aragon
    : /英国|银石|british/.test(t) ? MGP_SESSION_PROFILES.british
    : /卡塔尔|qatar/.test(t) ? MGP_SESSION_PROFILES.qatar
    : MGP_SESSION_PROFILES.default;
  const rt = MGP_ROUND_TIMES[round.token] || { o: 2, r: '14:00' };
  const offsetH = profile.o != null ? profile.o : rt.o;
  const [ry, rm, rd] = round.raceDay.split('-').map(Number);
  const [rh, rmin] = String(rt.r || '14:00').split(':').map(Number);
  const raceUtc = Date.UTC(ry, rm - 1, rd, rh - offsetH, rmin || 0, 0);
  const sessions = [];
  const dayAt = (dayOffset, hhmm) => {
    const [hh, mm] = hhmm.split(':').map(Number);
    return new Date(Date.UTC(ry, rm - 1, rd + dayOffset, hh - offsetH, mm || 0, 0));
  };
  for (const day of ['fri', 'sat', 'sun']) {
    const dayOffset = day === 'fri' ? -2 : day === 'sat' ? -1 : 0;
    for (const [key, label, hhmm] of profile[day]) {
      const start = new Date(dayAt(dayOffset, hhmm).getTime());
      sessions.push({
        id: `mgp-${round.token}-${key}`, sport: 'motogp', competition: 'MotoGP 大奖赛',
        round: round.round, title: `${round.title} ${label}`,
        startUtc: start.toISOString(), timeKnown: true,
        status: start.getTime() < Date.now() ? 'finished' : 'upcoming',
        sessionType: (key === 'race' || key === 'sprint' || key === 'q') ? 'comp' : 'practice',
      });
    }
  }
  // 正赛用内置确认时间
  sessions.push({
    id: `mgp-${round.token}-race`, sport: 'motogp', competition: 'MotoGP 大奖赛',
    round: round.round, title: `${round.title} 正赛`,
    startUtc: new Date(raceUtc).toISOString(), timeKnown: true,
    status: raceUtc < Date.now() ? 'finished' : 'upcoming',
    sessionType: 'comp',
  });
  sessions.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  return sessions;
}

// ---------------------------------------------------------------------------
// 推送
// ---------------------------------------------------------------------------
function normalizeBarkKey(k) {
  let s = String(k || '').trim();
  const i = s.indexOf('api.day.app/');
  if (i >= 0) s = s.slice(i + 'api.day.app/'.length);
  return s.replace(/\/+$/, '');
}
async function sendPush(title, body) {
  const results = [];
  const key = normalizeBarkKey(BARK_KEY);
  if (key) {
    try {
      const res = await fetch(`https://api.day.app/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, group: 'MatchReminder' }),
      });
      results.push('Bark:' + res.status);
    } catch (e) { results.push('Bark:ERR:' + e.message); }
  }
  if (NTFY_TOPIC) {
    try {
      const asciiTitle = String(title).replace(/[^\x00-\x7F]/g, '').trim() || 'Match Reminder';
      const res = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Title: asciiTitle, Priority: 'high' },
        body,
      });
      results.push('ntfy:' + res.status);
    } catch (e) { results.push('ntfy:ERR:' + e.message); }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8') || '{}'); } catch { return {}; }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function main() {
  log('云端观赛提醒开始运行（DRY_RUN=' + DRY_RUN + '）');
  if (!DRY_RUN && !normalizeBarkKey(BARK_KEY) && !NTFY_TOPIC) {
    log('⚠ 未配置 BARK_KEY / NTFY_TOPIC，本次跳过推送（仅记录）');
  }

  // 1) 抓取赛程
  let events = [];
  try { events.push(...await fetchManCity()); log('曼城赛事:', events.length, '场'); }
  catch (e) { log('曼城抓取失败:', e.message); }
  try {
    const rounds = await fetchMotogpRounds();
    log('MotoGP 分站:', rounds.length, '站');
    for (const r of rounds) events.push(...expandSessions(r));
  } catch (e) { log('MotoGP 抓取失败:', e.message); }

  const state = loadState();
  // 清理 45 天前的旧状态
  const cutoff = Date.now() - 45 * 86400000;
  for (const k of Object.keys(state)) {
    if (k.startsWith('_')) continue;
    if (new Date(state[k]).getTime() < cutoff) delete state[k];
  }

  const today = todayBJKey();
  const now = Date.now();
  let changed = false;

  // 首次运行的启用提示
  if (!state._hello) {
    state._hello = new Date().toISOString();
    changed = true;
    if (!DRY_RUN) {
      const r = await sendPush('✅ 云端观赛提醒已启用', '从此手机推送不再依赖电脑开机：每天自动检查赛程，赛前一天和开赛前 1 小时推送提醒（北京时间）。');
      log('启用提示推送:', r.join(' '));
    } else { log('[DRY] 启用提示（未发送）'); }
  }

  // 2) 计算提醒
  for (const ev of events) {
    if (ev.status !== 'upcoming') continue;
    if (ev.sessionType === 'practice' && !NOTIFY_ALL_SESSIONS) continue; // 练习/热身默认不提醒
    const startMs = new Date(ev.startUtc).getTime();
    const diff = daysBetween(today, bjDateKey(new Date(ev.startUtc)));
    const bj = formatBJ(new Date(ev.startUtc));
    const keyBase = `${ev.sport}:${normTitle(ev.title)}:${ev.startUtc}`;

    // a) 前一天提醒
    if (diff === 1 && !state[keyBase + ':day']) {
      state[keyBase + ':day'] = new Date().toISOString();
      changed = true;
      const head = `${ev.sport === 'motogp' ? '🏁' : '⚽'} 明天观赛提醒：${ev.title}`;
      const body = `${ev.competition}${ev.round ? ' ' + ev.round : ''}，${bj}（北京时间），记得准时观赛！`;
      if (DRY_RUN) { log('[DRY] 明天提醒:', head, '|', body); }
      else { const r = await sendPush(head, body); log('明天提醒推送:', r.join(' '), '|', head); }
    }

    // b) 开赛前 1 小时提醒（含 15 分钟运行余量）
    if (ev.timeKnown && startMs > now) {
      const minsLeft = (startMs - now) / 60000;
      if (minsLeft <= 75 && !state[keyBase + ':1h']) {
        state[keyBase + ':1h'] = new Date().toISOString();
        changed = true;
        const head = `${ev.sport === 'motogp' ? '🏁' : '⚽'} 1小时后开赛：${ev.title}`;
        const body = `${ev.competition}${ev.round ? ' ' + ev.round : ''}，${bj}（北京时间），准备观赛！`;
        if (DRY_RUN) { log('[DRY] 1小时提醒:', head, '|', body); }
        else { const r = await sendPush(head, body); log('1小时提醒推送:', r.join(' '), '|', head); }
      }
    }
  }

  // 3) 保存状态（由 workflow 提交到仓库）
  if (changed) saveState(state);
  log('完成。事件总数:', events.length, '| 状态变化:', changed);
}

main().catch((e) => { console.error('运行失败:', e); process.exit(1); });
