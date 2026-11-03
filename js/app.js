'use strict';

// 식당 운영 시간 (PRD 5.1) — 시간이 바뀌면 여기만 고치세요
const MEAL_TIMES = {
  breakfast: { label: '조식', start: '08:20', end: '09:00' },
  lunch: { label: '중식', start: '11:30', end: '14:00' },
  dinner: { label: '석식', start: '17:30', end: '19:00' },
};

const MEAL_ORDER = ['breakfast', 'lunch', 'dinner'];
const DATA_DIR = 'data/weeks';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const state = {
  today: '',
  minutes: 0,
  weeks: [],
  indexError: null,
  cache: new Map(),
  homeWeek: '',
  homeDay: '',
  week: '',
  day: '',
  weekendNotice: '',
};

let renderToken = 0;

const $ = (id) => document.getElementById(id);

// ---------- 날짜 (모두 KST 기준 'YYYY-MM-DD' 문자열로 다룸) ----------

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// 테스트용: 주소 뒤에 ?now=2026-11-07T18:30 을 붙이면 그 시각으로 동작
function getNow() {
  const override = new URLSearchParams(location.search).get('now');
  if (override && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(override)) {
    const [date, time] = override.split('T');
    return { date, minutes: toMinutes(time) };
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(s, n) {
  const dt = parseDate(s);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function weekdayOf(s) {
  return parseDate(s).getUTCDay();
}

function mondayOf(s) {
  return addDays(s, -((weekdayOf(s) + 6) % 7));
}

function shortDate(s) {
  const [, m, d] = s.split('-');
  return `${m}.${d}(${WEEKDAYS[weekdayOf(s)]})`;
}

function weekDates(monday) {
  return [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
}

// ---------- 데이터 ----------

class DataError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.path = path;
    this.reason = reason;
  }
}

async function loadJSON(path) {
  let res;
  try {
    res = await fetch(path, { cache: 'no-cache' });
  } catch (e) {
    throw new DataError(path, `파일을 불러오지 못했습니다 (${e.message})`);
  }
  if (!res.ok) throw new DataError(path, `파일이 없습니다 (HTTP ${res.status})`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new DataError(path, `JSON 형식 오류 — ${e.message}`);
  }
}

async function loadIndex() {
  const path = `${DATA_DIR}/index.json`;
  const data = await loadJSON(path);
  if (!data || !Array.isArray(data.weeks)) {
    throw new DataError(path, '"weeks" 목록이 없습니다');
  }
  const bad = data.weeks.find((w) => typeof w !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(w));
  if (bad !== undefined) {
    throw new DataError(path, `날짜 형식이 잘못되었습니다: ${JSON.stringify(bad)} (예: "2026-11-02")`);
  }
  return [...new Set(data.weeks)].sort();
}

// 목록에 없는 주는 null
async function loadWeek(week) {
  if (!state.weeks.includes(week)) return null;
  if (state.cache.has(week)) return state.cache.get(week);
  const path = `${DATA_DIR}/${week}.json`;
  const data = await loadJSON(path);
  if (!data || !Array.isArray(data.days)) {
    throw new DataError(path, '"days" 목록이 없습니다');
  }
  state.cache.set(week, data);
  return data;
}

function reportError(err) {
  console.error(`[식단 데이터 오류] ${err.message}`);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function mealCorners(dayData, key) {
  return list(dayData?.meals?.[key]?.corners);
}

function mealExtras(dayData, key) {
  return list(dayData?.meals?.[key]?.extras);
}

// PRD 5.1: 끝나지 않은 첫 끼니(운영하는)를 강조
function currentMeal(dayData) {
  for (const key of MEAL_ORDER) {
    const { start, end } = MEAL_TIMES[key];
    if (state.minutes >= toMinutes(end)) continue;
    if (!mealCorners(dayData, key).length) continue;
    return { key, status: state.minutes >= toMinutes(start) ? 'open' : 'next' };
  }
  return null;
}

// ---------- 화면 ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function won(price) {
  return typeof price === 'number' ? `${price.toLocaleString('ko-KR')}원` : '';
}

function kcalHtml(corner) {
  if (typeof corner.kcal !== 'number') return '';
  const approx = corner.estimated ? '≈' : '';
  return `<span class="corner-kcal">${approx}${corner.kcal.toLocaleString('ko-KR')}<span class="unit">kcal</span></span>`;
}

function menuListHtml(items) {
  return `<ul class="menu-list">${list(items)
    .map((name) => `<li>${esc(name)}</li>`)
    .join('')}</ul>`;
}

function extrasHtml(extras) {
  if (!extras.length) return '';
  return `<dl class="extras">${extras
    .map((extra) => {
      const meta = [won(extra.price), extra.note].filter(Boolean).join(' · ');
      return `
        <div class="extra">
          <dt>${esc(extra.name)}${meta ? ` <span class="extra-meta">${esc(meta)}</span>` : ''}</dt>
          <dd>${list(extra.items).map(esc).join(' · ')}</dd>
        </div>`;
    })
    .join('')}</dl>`;
}

function prevWeekOf(week) {
  return state.weeks.filter((w) => w < week).pop() ?? null;
}

function nextWeekOf(week) {
  return state.weeks.find((w) => w > week) ?? null;
}

function renderHeader() {
  const dates = weekDates(state.week);
  $('week-range').textContent = `${shortDate(dates[0])} ~ ${shortDate(dates[4])}`;
  $('prev-week').disabled = !prevWeekOf(state.week);
  $('next-week').disabled = !nextWeekOf(state.week);
  $('this-week').hidden = state.week === state.homeWeek;
}

function renderTabs() {
  $('day-tabs').innerHTML = weekDates(state.week)
    .map((date) => {
      const selected = date === state.day;
      const [, , d] = date.split('-');
      return `
        <button type="button" role="tab" class="day-tab" id="tab-${date}" data-date="${date}"
          aria-selected="${selected}" tabindex="${selected ? 0 : -1}"
          aria-label="${shortDate(date)}${date === state.today ? ', 오늘' : ''}">
          ${date === state.today ? '<span class="tab-today">오늘</span>' : ''}
          <span class="tab-day">${WEEKDAYS[weekdayOf(date)]}</span>
          <span class="tab-date">${Number(d)}</span>
        </button>`;
    })
    .join('');
}

function messageCard(title, body, action = '') {
  return `
    <div class="message-card">
      <h2>${esc(title)}</h2>
      <p>${esc(body)}</p>
      ${action}
    </div>`;
}

function renderMealCard(dayData, key, current, price) {
  const { label, start, end } = MEAL_TIMES[key];
  const corners = mealCorners(dayData, key);
  const isCurrent = current?.key === key;
  const badge = isCurrent
    ? current.status === 'open'
      ? '<span class="badge badge-open">운영 중</span>'
      : '<span class="badge badge-next">다음 식사</span>'
    : '';
  const body = corners.length
    ? corners
        .map((corner) => `
          <div class="corner">
            <div class="corner-head">
              <span class="corner-name">${esc(corner.name)} 코너</span>
              ${kcalHtml(corner)}
            </div>
            ${menuListHtml(corner.items)}
          </div>`)
        .join('') + extrasHtml(mealExtras(dayData, key))
    : '<p class="empty">운영하지 않습니다</p>';

  return `
    <section class="meal-card${isCurrent ? ' is-current' : ''}${corners.length ? '' : ' is-closed'}" aria-label="${label}">
      <div class="meal-head">
        <div class="meal-title"><h2>${label}</h2>${badge}</div>
        <div class="meal-time">${start}~${end}${price && corners.length ? ` · ${won(price)}` : ''}</div>
      </div>
      ${body}
    </section>`;
}

function renderAllDay(allDay) {
  return list(allDay)
    .map((item) => {
      const meta = [item.time, won(item.price)].filter(Boolean).join(' · ');
      return `
        <section class="meal-card all-day" aria-label="${esc(item.name)}">
          <div class="meal-head">
            <div class="meal-title"><h2>${esc(item.name)}</h2></div>
            ${meta ? `<div class="meal-time">${esc(meta)}</div>` : ''}
          </div>
          <p class="all-day-items">${list(item.items).map(esc).join(' · ')}</p>
        </section>`;
    })
    .join('');
}

function renderContent(data) {
  const content = $('content');
  const notices = [];
  if (state.week === state.homeWeek && state.weekendNotice) {
    notices.push(state.weekendNotice);
  }

  if (!data) {
    const prev = prevWeekOf(state.week);
    if (state.week === state.homeWeek) {
      content.innerHTML = messageCard(
        '이번 주 식단을 준비 중입니다',
        '식단표는 매주 월요일에 등록됩니다.',
        prev ? '<button type="button" class="primary-btn" data-action="prev-week">지난주 식단 보기</button>' : ''
      );
    } else {
      content.innerHTML = messageCard('등록된 식단이 없습니다', '다른 주를 선택해 주세요.');
    }
    return;
  }

  const dayData = data.days.find((d) => d.date === state.day);
  const hasEstimate = MEAL_ORDER.some((key) => mealCorners(dayData, key).some((c) => c.estimated));
  const footer = `
    <footer class="page-footer">
      <p>칼로리는 코너별 한 끼 기준입니다.</p>
      ${hasEstimate ? '<p>≈ 표시는 원본에 칼로리가 없어 추정한 값입니다.</p>' : ''}
      ${list(data.notes).map((n) => `<p>${esc(n)}</p>`).join('')}
      ${data.updatedAt ? `<p>업데이트: ${esc(data.updatedAt)}</p>` : ''}
    </footer>`;

  if (!dayData || MEAL_ORDER.every((key) => !mealCorners(dayData, key).length)) {
    content.innerHTML =
      notices.map((n) => `<p class="notice">${esc(n)}</p>`).join('') +
      messageCard('등록된 식단이 없습니다', `${shortDate(state.day)}에는 등록된 메뉴가 없습니다.`) +
      footer;
    return;
  }

  const isToday = state.day === state.today;
  const current = isToday ? currentMeal(dayData) : null;
  if (isToday && !current) notices.push('오늘 식당 운영이 끝났어요.');

  content.innerHTML = `
    ${notices.map((n) => `<p class="notice">${esc(n)}</p>`).join('')}
    ${MEAL_ORDER.map((key) => renderMealCard(dayData, key, current, data.prices?.[key])).join('')}
    ${renderAllDay(data.allDay)}
    ${footer}`;
}

async function render() {
  const token = ++renderToken;
  renderHeader();
  renderTabs();

  if (state.indexError) {
    $('content').innerHTML = messageCard(
      '식단 정보를 불러오지 못했습니다',
      '잠시 후 다시 시도하거나 담당자에게 알려 주세요.'
    );
    return;
  }

  let data;
  try {
    data = await loadWeek(state.week);
  } catch (err) {
    if (token !== renderToken) return;
    reportError(err);
    $('content').innerHTML = messageCard(
      '식단 정보를 불러오지 못했습니다',
      '잠시 후 다시 시도하거나 담당자에게 알려 주세요.'
    );
    return;
  }
  if (token !== renderToken) return;
  renderContent(data);
}

// ---------- 동작 ----------

// 오늘을 볼 때 강조된 끼니로 스크롤 (조식이면 헤더가 보이도록 맨 위 유지)
// 다른 날이면 내려가 있던 화면을 그 날의 처음으로 되돌림
function scrollToCurrentMeal(smooth) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior = smooth && !reduceMotion ? 'smooth' : 'auto';
  const card = state.day === state.today ? document.querySelector('.meal-card.is-current') : null;
  if (card && card !== document.querySelector('.meal-card')) {
    card.scrollIntoView({ behavior, block: 'start' });
    return;
  }
  const content = $('content');
  if (content.getBoundingClientRect().top < $('day-tabs').offsetHeight) content.scrollIntoView({ behavior, block: 'start' });
}

async function showDay(smooth) {
  await render();
  scrollToCurrentMeal(smooth);
}

function selectDay(date, focus = false) {
  state.day = date;
  showDay(true);
  if (focus) $(`tab-${date}`)?.focus();
}

// 다른 주로 가도 같은 요일을 유지 (그 주에 오늘이 있으면 오늘)
function goToWeek(week) {
  if (!week) return;
  const dates = weekDates(week);
  const index = (weekdayOf(state.day) + 6) % 7;
  state.week = week;
  state.day = dates.includes(state.today) ? state.today : dates[Math.min(index, 4)];
  showDay(true);
}

function bindEvents() {
  $('prev-week').addEventListener('click', () => goToWeek(prevWeekOf(state.week)));
  $('next-week').addEventListener('click', () => goToWeek(nextWeekOf(state.week)));
  $('this-week').addEventListener('click', () => {
    state.week = state.homeWeek;
    state.day = state.homeDay;
    showDay(true);
  });

  const tabs = $('day-tabs');
  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-date]');
    if (tab) selectDay(tab.dataset.date);
  });
  tabs.addEventListener('keydown', (e) => {
    const dates = weekDates(state.week);
    const i = dates.indexOf(state.day);
    const moves = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: dates.length - 1 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    const next = (moves[e.key] + dates.length) % dates.length;
    selectDay(dates[next], true);
  });

  $('content').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="prev-week"]')) goToWeek(prevWeekOf(state.week));
  });
}

async function init() {
  const now = getNow();
  state.today = now.date;
  state.minutes = now.minutes;

  try {
    state.weeks = await loadIndex();
  } catch (err) {
    reportError(err);
    state.indexError = err;
  }

  // PRD 4장: 주말에는 다음 주가 있으면 다음 주 월요일, 없으면 이번 주 금요일
  const thisMonday = mondayOf(state.today);
  const dow = weekdayOf(state.today);
  let week = thisMonday;
  let day = state.today;
  if (dow === 0 || dow === 6) {
    const nextMonday = addDays(thisMonday, 7);
    if (state.weeks.includes(nextMonday)) {
      week = nextMonday;
      day = nextMonday;
    } else {
      day = addDays(thisMonday, 4);
      state.weekendNotice = '다음 주 식단은 월요일에 등록됩니다.';
    }
  }

  state.homeWeek = state.week = week;
  state.homeDay = state.day = day;
  bindEvents();
  showDay(false);
}

init();
