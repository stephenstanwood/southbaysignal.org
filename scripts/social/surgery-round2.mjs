// Round 2 surgery (2026-04-19): trim to 10 days, remove tUrn/Thompson/Penny Lane,
// pad thin plans, strip stale DOW refs from blurbs, regen affected copy.

import fs from 'node:fs';
import path from 'node:path';
import { generateDayPlanCopy } from './lib/copy-gen.mjs';
import { canonicalizePlanCards } from '../../src/lib/south-bay/canonicalizeCard.mjs';

const ROOT = process.cwd();
const SCHEDULE = path.join(ROOT, 'src/data/south-bay/social-schedule.json');
const SHARED = path.join(ROOT, 'src/data/south-bay/shared-plans.json');
const PLACES = path.join(ROOT, 'src/data/south-bay/places.json');

const schedule = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
const shared = JSON.parse(fs.readFileSync(SHARED, 'utf8'));
const placesData = JSON.parse(fs.readFileSync(PLACES, 'utf8'));

const DOW_NAMES = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];

const placesArr = placesData.places || placesData;
const placesByCity = {};
for (const p of placesArr) {
  if (!p.rating || p.rating < 4.3) continue;
  if (!p.ratingCount || p.ratingCount < 50) continue;
  if (!p.city || !p.name) continue;
  const blob = [p.primaryType, p.category, p.name, ...(p.types || [])].filter(Boolean).join(' ').toLowerCase();
  if (/spa|massage|dental|government|post_office|bank|atm|storage|gas_station|car_wash/.test(blob)) continue;
  (placesByCity[p.city] ||= []).push(p);
}
for (const city of Object.keys(placesByCity)) {
  placesByCity[city].sort((a, b) => (b.rating * Math.log(b.ratingCount + 1)) - (a.rating * Math.log(a.ratingCount + 1)));
}

function placeCat(p) {
  const t = [p.primaryType, p.category, ...(p.types || [])].filter(Boolean).join(' ').toLowerCase();
  if (/restaurant|food|bakery|cafe|coffee|bar|brewery|bistro/.test(t)) return 'food';
  if (/park|trail|garden|nature/.test(t)) return 'outdoor';
  if (/museum|gallery|art/.test(t)) return 'arts';
  if (/store|shop|market|mall/.test(t)) return 'shopping';
  if (/bowling|arcade|entertainment/.test(t)) return 'entertainment';
  return 'other';
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
  const filled = new Set();
  for (const c of cards) {
    const h = parseStartHour(c.timeBlock);
    if (h != null) for (let i = h; i < h + 2; i++) filled.add(i);
  }
  return [
    { label: '9:00 AM - 10:00 AM', startH: 9 },
    { label: '10:30 AM - 12:00 PM', startH: 10 },
    { label: '12:30 PM - 2:00 PM', startH: 12 },
    { label: '2:30 PM - 4:00 PM', startH: 14 },
    { label: '4:30 PM - 6:00 PM', startH: 16 },
    { label: '6:30 PM - 8:00 PM', startH: 18 },
    { label: '8:30 PM - 10:00 PM', startH: 20 },
  ].filter(s => !filled.has(s.startH));
}

// Strip stale DOW+time-of-day refs from blurb text. Replace with neutral versions.
function scrubDowFromBlurb(text) {
  if (!text) return text;
  let out = text;
  const timeOfDay = '(morning|afternoon|evening|night)';
  const dow = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
  // "a great sunday afternoon" → "a great afternoon"
  out = out.replace(new RegExp(`\\b${dow}\\s+${timeOfDay}\\b`, 'gi'), (m, d, t) => t.toLowerCase());
  // "this sunday" / "on sunday" → drop
  out = out.replace(new RegExp(`\\b(this|on|a|every)\\s+${dow}\\b`, 'gi'), '');
  // stray leading "sunday" at sentence start → drop
  out = out.replace(new RegExp(`\\b${dow}\\b`, 'gi'), '');
  // cleanup: double spaces, leading/trailing punctuation
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
  // If result is empty or tiny, return original (better a stale blurb than empty)
  if (out.length < 10) return text;
  return out;
}

// Step 1: trim schedule to 10 days (cut 4/29 through 5/02)
console.log('Step 1: trim to 10 days\n');
const keep = new Set(['2026-04-17','2026-04-18','2026-04-19','2026-04-20','2026-04-21','2026-04-22','2026-04-23','2026-04-24','2026-04-25','2026-04-26','2026-04-27','2026-04-28']);
const toDrop = Object.keys(schedule.days).filter(d => !keep.has(d));
for (const d of toDrop) {
  const day = schedule.days[d];
  // Drop any shared-plans entries
  for (const slotType of ['day-plan','tonight-pick','wildcard']) {
    const slot = day[slotType];
    if (slot?.planUrl) {
      const planId = slot.planUrl.split('/').pop();
      if (shared[planId]) delete shared[planId];
    }
  }
  delete schedule.days[d];
  console.log(`  dropped ${d}`);
}

// Step 2: remove specific bad cards
console.log('\nStep 2: remove flagged cards\n');

const CARD_REMOVALS = {
  '2026-04-20': [/\btUrn\b/i, /liveable planet.*human right/i, /climate science en español/i, /director.?s keynote/i],
  '2026-04-22': [/natalie and james thompson gallery/i, /click on my mouth/i],
  '2026-04-24': [/stroll down penny lane/i, /paul mccartney/i],
};

const datesTouched = new Set();

for (const [date, patterns] of Object.entries(CARD_REMOVALS)) {
  const day = schedule.days[date];
  if (!day) continue;
  const dp = day['day-plan'];
  if (!dp?.plan?.cards) continue;
  const before = dp.plan.cards.length;
  dp.plan.cards = dp.plan.cards.filter(c => {
    const text = [c.name, c.title, c.featuredPlace, c.venue].filter(Boolean).join(' ');
    const blocked = patterns.some(re => re.test(text));
    if (blocked) console.log(`  ${date}: removed "${c.name || c.title}"`);
    return !blocked;
  });
  if (dp.plan.cards.length !== before) datesTouched.add(date);
}

// Step 3: pad thin day-plans (< 6 cards)
console.log('\nStep 3: pad thin plans\n');
const MIN_CARDS = 6;

for (const date of Object.keys(schedule.days)) {
  const day = schedule.days[date];
  const dp = day['day-plan'];
  if (!dp || dp.status !== 'draft') continue;
  const cards = dp.plan?.cards || [];
  if (cards.length >= MIN_CARDS) continue;

  const anchor = (dp.city || '').toLowerCase();
  const pool = placesByCity[anchor] || [];
  // Also blend in neighboring cities for anchors with thin pools
  const nearbyByCity = {
    'saratoga': ['campbell','los-gatos','cupertino'],
    'los-altos': ['mountain-view','palo-alto'],
    'milpitas': ['san-jose','santa-clara'],
    'campbell': ['san-jose','los-gatos','saratoga'],
    'cupertino': ['saratoga','sunnyvale','santa-clara'],
    'los-gatos': ['saratoga','campbell','san-jose'],
    'mountain-view': ['palo-alto','sunnyvale','los-altos'],
    'palo-alto': ['mountain-view','los-altos'],
    'santa-clara': ['san-jose','sunnyvale'],
    'sunnyvale': ['mountain-view','santa-clara','cupertino'],
    'san-jose': ['santa-clara','campbell','milpitas'],
  };
  const extended = [...(pool || [])];
  for (const c of (nearbyByCity[anchor] || [])) {
    for (const p of (placesByCity[c] || []).slice(0, 50)) extended.push(p);
  }

  const usedNames = new Set(cards.map(c => (c.name || '').toLowerCase()));
  const open = findOpenSlots(cards);
  let needed = MIN_CARDS - cards.length;
  const picked = [];
  for (const slot of open) {
    if (needed <= 0) break;
    const pick = extended.find(p => !usedNames.has(p.name.toLowerCase()) && !picked.some(x => x.id === p.id));
    if (!pick) break;
    const cat = placeCat(pick);
    const cityLabel = (pick.city || '').split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    picked.push({
      id: `pad:${pick.id}`,
      type: 'place',
      name: pick.name,
      category: cat,
      address: pick.address,
      timeBlock: slot.label,
      neighborhood: pick.city,
      blurb: `${cityLabel} ${cat === 'food' ? 'pick' : 'spot'} worth the stop.`,
    });
    usedNames.add(pick.name.toLowerCase());
    needed--;
  }

  if (picked.length) {
    dp.plan.cards = [...cards, ...picked].sort((a, b) => (parseStartHour(a.timeBlock) ?? 99) - (parseStartHour(b.timeBlock) ?? 99));
    datesTouched.add(date);
    console.log(`  ${date}: padded ${picked.length} → ${dp.plan.cards.length} cards: ${picked.map(p => p.name).join(', ')}`);
  }
}

// Step 4: scrub stale DOW refs from blurbs in ALL drafted day-plans
console.log('\nStep 4: scrub stale day-of-week references from blurbs\n');
let scrubbed = 0;
for (const date of Object.keys(schedule.days)) {
  const day = schedule.days[date];
  const dp = day['day-plan'];
  if (!dp?.plan?.cards) continue;
  const planDow = DOW_NAMES[new Date(date + 'T12:00:00').getDay()];
  for (const c of dp.plan.cards) {
    for (const field of ['blurb', 'why']) {
      const v = c[field];
      if (!v) continue;
      const scrub = scrubDowFromBlurb(v);
      // Only scrub if text mentioned a DOW that wasn't the plan's own DOW
      const hasMismatch = DOW_NAMES.some(d => d !== planDow && new RegExp(`\\b${d}\\b`, 'i').test(v));
      if (hasMismatch && scrub !== v) {
        c[field] = scrub;
        scrubbed++;
      }
    }
  }
}
console.log(`  scrubbed ${scrubbed} blurb(s)`);

// Step 5: sync shared-plans with modified plans
console.log('\nStep 5: sync shared-plans\n');
for (const date of datesTouched) {
  const dp = schedule.days[date]['day-plan'];
  if (!dp?.planUrl) continue;
  const planId = dp.planUrl.split('/').pop();
  if (shared[planId]) {
    shared[planId].cards = canonicalizePlanCards(dp.plan.cards);
    shared[planId].updatedAt = new Date().toISOString();
    console.log(`  synced ${planId} (${date})`);
  }
}

// Step 6: regen copy for touched day-plans
console.log('\nStep 6: regen copy for touched day-plans\n');
for (const date of [...datesTouched].sort()) {
  const dp = schedule.days[date]['day-plan'];
  if (!dp || dp.status !== 'draft') continue;
  try {
    const copy = await generateDayPlanCopy(dp.plan, date, dp.planUrl || '');
    dp.copy = copy;
    console.log(`  ${date}: regenerated copy`);
  } catch (e) {
    console.log(`  ${date}: COPY ERROR ${e.message}`);
  }
}

fs.writeFileSync(SCHEDULE, JSON.stringify(schedule, null, 2));
fs.writeFileSync(SHARED, JSON.stringify(shared, null, 2));
console.log('\nDone.');
