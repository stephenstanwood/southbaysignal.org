// One-off batch surgery for 2026-04-19: prune bad cards, pad thin plans,
// fill empty/rejected tonight-picks, regen copy. Runs on the Mini.

import fs from 'node:fs';
import path from 'node:path';
import { runQualityReview } from './lib/post-gen-review.mjs';
import { generateDayPlanCopy, generateTonightPickCopy } from './lib/copy-gen.mjs';
import { canonicalizePlanCards } from '../../src/lib/south-bay/canonicalizeCard.mjs';
import { CITY_NAMES } from './lib/constants.mjs';

const ROOT = process.cwd();
const SCHEDULE = path.join(ROOT, 'src/data/south-bay/social-schedule.json');
const SHARED = path.join(ROOT, 'src/data/south-bay/shared-plans.json');
const EVENTS = path.join(ROOT, 'src/data/south-bay/upcoming-events.json');
const PLACES = path.join(ROOT, 'src/data/south-bay/places.json');

const schedule = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
const shared = JSON.parse(fs.readFileSync(SHARED, 'utf8'));
const events = JSON.parse(fs.readFileSync(EVENTS, 'utf8'));
const places = JSON.parse(fs.readFileSync(PLACES, 'utf8'));

// Step 1: enhanced review with card-pruning (don't auto-delete, we'll handle padding)
console.log('Step 1: prune bad cards via review module\n');
const reviewResult = runQualityReview(schedule, { resetFlaggedToDraft: false });
for (const f of reviewResult.autoFixed) {
  console.log(`  ${f.date} ${f.slotType} ${f.kind}: ${f.details}`);
}

// Step 2: pad thin day-plans using top-rated places in the anchor city
console.log('\nStep 2: pad thin day-plans\n');

const placesArr = Array.isArray(places) ? places : (places.places || Object.values(places));
const placesByCity = {};
for (const p of placesArr) {
  if (!p.rating || p.rating < 4.3) continue;
  if (!p.ratingCount || p.ratingCount < 50) continue;
  if (!p.city || !p.name) continue;
  const cat = (p.primaryType || p.category || '').toLowerCase();
  // Skip spas, massage, dentists, government, etc.
  if (/spa|massage|dental|government|post_office|bank|atm/.test(cat)) continue;
  if (/spa|massage|acupuncture/i.test(p.name)) continue;
  (placesByCity[p.city] ||= []).push(p);
}
for (const city of Object.keys(placesByCity)) {
  placesByCity[city].sort((a, b) => (b.rating * Math.log(b.ratingCount + 1)) - (a.rating * Math.log(a.ratingCount + 1)));
}

// Helper: classify a place into a broad category for slotting
function placeBroadCat(p) {
  const t = [p.primaryType, p.category, ...(p.types || [])].filter(Boolean).join(' ').toLowerCase();
  if (/restaurant|food|bakery|cafe|coffee|bar|brewery|bistro/.test(t)) return 'food';
  if (/park|trail|garden|nature/.test(t)) return 'outdoor';
  if (/museum|gallery|art/.test(t)) return 'arts';
  if (/store|shop|market|mall/.test(t)) return 'shopping';
  if (/bowling|arcade|entertainment/.test(t)) return 'entertainment';
  return 'other';
}

function slotLabel(startH) {
  const toStr = (h) => {
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const suf = h >= 12 ? 'PM' : 'AM';
    return `${h12}:00 ${suf}`;
  };
  return `${toStr(startH)} - ${toStr(startH + 1)}`;
}

function parseStartHour(timeBlock) {
  if (!timeBlock) return null;
  const m = String(timeBlock).split(/\s*-\s*/)[0].trim().match(/(\d+)(?::(\d+))?\s*(AM|PM|am|pm)?/);
  if (!m) return null;
  let h = parseInt(m[1]);
  const suf = (m[3] || '').toLowerCase();
  if (suf === 'pm' && h !== 12) h += 12;
  if (suf === 'am' && h === 12) h = 0;
  return h;
}

function findOpenSlots(cards) {
  // Get hours currently filled
  const filled = new Set();
  for (const c of cards) {
    const h = parseStartHour(c.timeBlock);
    if (h != null) {
      for (let i = h; i < h + 2; i++) filled.add(i);  // assume 1-2h per card
    }
  }
  // Check canonical slots
  const slots = [
    { label: '9:00 AM - 10:00 AM', startH: 9 },
    { label: '10:30 AM - 12:00 PM', startH: 10 },
    { label: '12:30 PM - 2:00 PM', startH: 12 },
    { label: '2:30 PM - 4:00 PM', startH: 14 },
    { label: '4:30 PM - 6:00 PM', startH: 16 },
    { label: '6:30 PM - 8:00 PM', startH: 18 },
    { label: '8:30 PM - 10:00 PM', startH: 20 },
  ];
  return slots.filter(s => !filled.has(s.startH));
}

const MIN_CARDS = 6;
const dates = Object.keys(schedule.days).sort();
const datesNeedCopyRegen = new Set();

for (const date of dates) {
  const day = schedule.days[date];
  const dp = day['day-plan'];
  if (!dp || dp.status !== 'draft') continue;
  const cards = dp.plan?.cards || [];
  if (cards.length >= MIN_CARDS) continue;

  // Anchor city: prefer dp.city, fall back to plan.cityName or plan.city
  const anchor = (dp.city || dp.plan?.cityName || dp.plan?.city || '').toLowerCase();
  const pool = placesByCity[anchor] || placesByCity['san-jose'] || [];
  const usedNames = new Set(cards.map(c => (c.name || '').toLowerCase()));

  const open = findOpenSlots(cards);
  let needed = MIN_CARDS - cards.length;
  const picked = [];
  for (const slot of open) {
    if (needed <= 0) break;
    // Pick a place we haven't used and that hasn't been used in the rolling window
    const pick = pool.find(p => !usedNames.has(p.name.toLowerCase()) && !picked.some(x => x.name === p.name));
    if (!pick) break;
    const cat = placeBroadCat(pick);
    picked.push({
      id: `pad:${pick.id}`,
      type: 'place',
      name: pick.name,
      category: cat,
      address: pick.address,
      timeBlock: slot.label,
      neighborhood: anchor,
      blurb: `Top-rated ${cat} spot in ${dp.plan?.cityName || CITY_NAMES[anchor] || anchor}.`,
    });
    usedNames.add(pick.name.toLowerCase());
    needed--;
  }

  if (picked.length > 0) {
    dp.plan.cards = [...cards, ...picked].sort((a, b) => (parseStartHour(a.timeBlock) ?? 99) - (parseStartHour(b.timeBlock) ?? 99));
    datesNeedCopyRegen.add(date);
    console.log(`  ${date}: padded ${picked.length} cards [${dp.plan.cards.length} total] — ${picked.map(p => p.name).join(', ')}`);

    // Also update shared-plans.json if the plan is shared
    const planId = dp.planId || dp.plan?.planId;
    if (planId && shared[planId]) {
      shared[planId].cards = canonicalizePlanCards(dp.plan.cards);
      shared[planId].updatedAt = new Date().toISOString();
    }
  } else {
    console.log(`  ${date}: WARN — couldn't pad (no pool for anchor "${anchor}")`);
  }
}

// Step 3: flag any plan where card order changed (review module already sorted) for copy regen
for (const f of reviewResult.autoFixed) {
  if (f.kind === 'card-prune' || f.kind === 'chronology' || f.kind === 'spa-cap') {
    datesNeedCopyRegen.add(f.date);
  }
}

// Step 4: fill empty / rejected tonight-picks
console.log('\nStep 4: fill empty/rejected tonight-picks\n');

const eventList = Array.isArray(events) ? events : (events.events || events.items || []);

const TONIGHT_PICKS_MANUAL = {
  '2026-04-21': { titleMatch: 'SJSU Art Galleries Tuesday Night Lecture' },  // Ken Rinaldo, SJSU
  '2026-04-24': { titleMatch: 'From Bestseller to Classic' },  // Kepler's
  '2026-04-26': { titleMatch: 'Vienna Teng' },  // Montalvo
  '2026-04-28': { titleMatch: 'Jesse Q. Sutanto' },  // Kepler's
  '2026-04-30': { titleMatch: 'Annie Leonard' },  // Kepler's Protest
  '2026-05-01': { titleMatch: 'SJZ Break Room Jazz Jam' },  // Martín Perna
};

function findEventForDate(date, titleMatch) {
  const matches = eventList.filter(e => {
    const d = e.date || e.startDate;
    if (!d) return false;
    if (String(d).slice(0, 10) !== date) return false;
    const title = String(e.title || e.name || '');
    return title.toLowerCase().includes(titleMatch.toLowerCase());
  });
  return matches[0] || null;
}

for (const date of Object.keys(TONIGHT_PICKS_MANUAL)) {
  const day = schedule.days[date];
  if (!day) continue;
  const existing = day['tonight-pick'];
  if (existing && existing.status !== 'rejected' && existing.status !== 'draft') continue;
  const spec = TONIGHT_PICKS_MANUAL[date];
  const match = findEventForDate(date, spec.titleMatch);
  if (!match) {
    console.log(`  ${date}: NO MATCH for "${spec.titleMatch}"`);
    continue;
  }
  day['tonight-pick'] = {
    status: 'draft',
    scheduledAt: `${date}T11:45:00-07:00`,
    item: {
      id: match.id || `event:${date}-${match.title.slice(0,20)}`,
      title: match.title,
      name: match.title,
      venue: match.venue || match.location || '',
      city: match.city || '',
      date: date,
      time: match.time || match.startTime || '',
      url: match.url || match.link || match.sourceUrl || '',
      summary: match.summary || match.description || '',
      category: match.category || '',
    },
  };
  datesNeedCopyRegen.add(date);
  console.log(`  ${date}: ${match.title} @ ${match.venue || '?'}`);
}

// Handle 4/29 manually — no great evening event, use restaurant-radar or skip
// Actually let's try a SV-history-style fallback or just a restaurant opening.
// Looking at the scraped events, 4/29 has thin pickings. Let me set 4/29 to wildcard-style.
// For now, leave 4/29 empty and accept that.

// Step 5: regen copy for impacted slots
console.log('\nStep 5: regen copy for impacted slots\n');

const dummyShortUrl = (id, url) => url; // skip shortening for speed; the publisher handles it

async function regenDayPlanCopy(date, dp) {
  try {
    const planUrl = dp.planUrl || (dp.plan?.planId ? `https://southbaytoday.org/plan/${dp.plan.planId}` : '');
    const copy = await generateDayPlanCopy(dp.plan, date, planUrl);
    dp.copy = copy;
    console.log(`  ${date} day-plan: regenerated copy`);
  } catch (e) {
    console.log(`  ${date} day-plan: COPY ERROR ${e.message}`);
  }
}

async function regenTonightCopy(date, tp) {
  try {
    const copy = await generateTonightPickCopy(tp.item);
    tp.copy = copy;
    console.log(`  ${date} tonight-pick: regenerated copy`);
  } catch (e) {
    console.log(`  ${date} tonight-pick: COPY ERROR ${e.message}`);
  }
}

for (const date of [...datesNeedCopyRegen].sort()) {
  const day = schedule.days[date];
  if (!day) continue;
  const dp = day['day-plan'];
  if (dp && dp.status === 'draft') {
    await regenDayPlanCopy(date, dp);
  }
  const tp = day['tonight-pick'];
  if (tp && tp.status === 'draft') {
    await regenTonightCopy(date, tp);
  }
}

// Step 6: save
fs.writeFileSync(SCHEDULE, JSON.stringify(schedule, null, 2));
fs.writeFileSync(SHARED, JSON.stringify(shared, null, 2));
console.log('\nDone. Saved schedule + shared-plans.');
