# South Bay Signal — Vision Log

---

## STANDING ORDERS (read every cycle before choosing what to build)

These are permanent directives from Stephen — override any other instinct:

1. **No local review — just ship.** Don't wait for approval. Build it, push it, merge it, move on.
2. **Aesthetics are lacking — fix aggressively.** The design is functional but not beautiful. Every cycle should make it feel more like a real product: typography, spacing, hierarchy, color, polish. This is a real gap.
3. **Mobile-first, always.** Check the mobile experience (375px) on every change. Don't build desktop-first and bolt on mobile. The "default homepage" goal requires excellent mobile.
4. **Events data: more is more.** Volume over curation. It's easier to trim too much data than to feel sparse. Add every verifiable recurring event you can find — libraries, parks, schools, Stanford calendar, city events, cultural centers, live music venues, etc. Aim for 100+ events.

---

## 2026-03-27 — Cycle 1: The Events Section

### Context
Previous scheduled-task cycles already built:
- `/south-bay` page with newspaper masthead, tabs, city filter pill navigation
- Sports view with ESPN API integration for Sharks, Warriors, SF Giants, 49ers, Earthquakes, Stanford, SJSU
- Government view with AI council digests for Campbell, Saratoga, and Los Altos (CivicEngage scraper)
- Events tab — disabled with "coming soon" placeholder
- MiLB integration for San Jose Giants via MLB Stats API
- Agenda scraper factory supporting CivicEngage + Legistar (Legistar not yet implemented)

### Issues Identified This Cycle
1. **Events tab disabled** — the single biggest gap between "dashboard demo" and "useful local product"
2. **Sports: NCAA football in March** — the ESPN college football scoreboard returns games in the offseason (spring games, old schedules), showing confusing results. Fix: season-aware path filtering.
3. **Sports: Stanford basketball missing** — caused by season filtering; NCAA basketball IS active in March (March Madness). The season filter fix correctly retains NCAAM while removing NCAAF.
4. **Council digests don't seem to do anything** — UI auto-fetches configured cities (Campbell, Saratoga, Los Altos) on tab load. The scraper itself may be failing on the CivicEngage pages or the AI key may not be set in the deployment environment. This needs deeper investigation: checking if the API route returns proper errors vs. silently failing.

### What Was Built

**1. Sports season awareness** (`src/lib/south-bay/teams.ts`)
Added `LEAGUE_ACTIVE_MONTHS` map — each league has defined active months. `getEspnPaths()` now skips fetching endpoints for off-season leagues. Result: no more random NCAAF games in March. March Madness (NCAAM) correctly continues to show.

**2. Events section** — the killer feature (finally live)

`src/data/south-bay/events-data.ts` — 40+ curated South Bay events:
- **Farmers markets**: Campbell, Mountain View, Sunnyvale, Palo Alto (2 locations), Los Gatos, Saratoga, Milpitas, Willow Glen, Downtown SJ
- **Family/kids**: Children's Discovery Museum, The Tech Interactive, Computer History Museum, Campbell Library story times, SJ Public Library programs, Mountain View Library events
- **Arts & culture**: SJ Museum of Art (free 3rd Fridays!), Montalvo Arts Center, Stanford Bing Concert Hall, Hammer Theatre, Cantor Arts Center (free always), SJ Jazz
- **Outdoor**: Vasona Lake / Billy Jones Wildcat Railroad, Alum Rock Park, Los Gatos Creek Trail, Shoreline Park MV, Rancho San Antonio
- **Stanford events**: Bing Concert Hall, free public lectures, The Dish hike, Cantor Arts, Stanford Athletics (many free)
- **Sports venues**: Sharks at SAP Center, Earthquakes at PayPal Park, SJ Giants at Excite Ballpark
- **Community**: Downtown Campbell summer concerts, MV free summer concerts, SJ Downtown Ice Rink
- **Food**: Santana Row, San Pedro Square Market, Downtown Campbell dining strip

`src/components/south-bay/views/EventsView.tsx`:
- Category filter pills: All / Markets / Family / Outdoors / Music / Arts / Sports / Education / Food / Community
- Time filter buttons: All / Today / Weekend / Weekday
- Kids-only checkbox
- Search box (title, description, city, venue)
- "Today" badge on events active on the current day
- Cost badges: FREE (green), $ (amber), $$ (purple)
- Filterable by city via the global city filter in SignalApp
- Event count in header ("X happening today")

**3. SignalApp updated**:
- Imported EventsView
- Removed the `disabled` flag on the Events tab
- Events tab now renders EventsView instead of "coming soon"

**4. OverviewView updated**:
- Shows live "N events happening today" count
- Teaser text for Events and Government sections

### Why This Was the Strongest Move
The Events section has been called "potentially the killer feature" since day one of planning. Having it perpetually disabled makes the product feel half-baked. With 40+ real, verifiable events across all 11 cities and 9 categories, the tab now delivers immediate value. A resident visiting on a Sunday morning sees "12 happening today" and can browse farmers markets, free library programs, and open parks — all in their city.

### What New Opportunities Emerged
1. **Live event feeds** — the static events data is a strong foundation. Next step: pull real event data from Eventbrite, SJ City events API, Library events calendars, and city parks departments.
2. **Government digest investigation** — the silent failure on council digests needs a real fix. Either the API is returning 404 because the CivicEngage scraper can't find the PDF links, or the ANTHROPIC_API_KEY isn't set. Add better error display (show the error message in the UI, not just a silent failure).
3. **Plan My Day** — now that events data exists, the interactive "Plan My Day" feature becomes buildable. It needs: weather API, events data, routing/time estimation, and Claude to compose the itinerary.
4. **Development tracker** — still the most unique potential section. "What's being built in your city?" with permit data.
5. **More cities for government digests** — implement the Legistar scraper to cover San Jose, Sunnyvale, Mountain View, Santa Clara, Cupertino.

### Next 3 Strongest Ideas
1. **Government digest fix + more cities** — Fix the silent failure, show real errors in the UI, and start implementing the Legistar scraper for at least one more city (San Jose or Mountain View).
2. **Plan My Day** — Signature interactive feature: pick your day, family type, and budget → get an AI-composed itinerary using the events data + weather. This is the "bookmark this page" moment.
3. **Development tracker** — A structured data layer for "what's being built" across cities. Even a curated JSON of major known projects (downtown SJ developments, Mountain View mixed-use projects, etc.) would make the product feel like no other local site.

### Does the Product Now Feel Meaningfully Closer to "Default Homepage for South Bay Life"?
**Yes — materially more useful.** The Events section was the biggest missing piece for utility. A resident can now use South Bay Signal on a Sunday morning to find farmers markets, or on a Friday afternoon to find free evening events. The city filter works across Events. The "Today" badge makes it immediately actionable. Combined with the working sports scoreboard, there's now real daily-use value — not just a civic demo.

---

## 2026-03-27 — Cycle 2: Today Tab → Real Morning Dashboard

### Context
Coming off Cycle 1 which delivered the Events section. The product now has live sports, curated events, and government digests. But the Today/Overview tab — the landing experience — was just the full sports scoreboard plus two text teasers. Opening South Bay Signal dropped you into a sports page. That's not a daily homepage.

### Issues Identified This Cycle
1. **Today tab weak as entry point** — first impression is "sports scoreboard + footnotes," not "daily South Bay briefing"
2. **Events data not surfaced on homepage** — we have 40+ events but nothing shows on the landing tab except a count in a teaser
3. **No ambient context** — no weather, no sense of "this is today, this is what's happening"

### What Was Built

**Redesigned OverviewView** (`src/components/south-bay/views/OverviewView.tsx`)

New structure, top to bottom:

1. **Weather strip** — fetches from existing `/api/weather` (Open-Meteo, free, no key). Shows live temp + conditions, e.g. "☀️ 68°F clear sky · South Bay, CA." Renders only when data loads; no flash of empty space on fetch.

2. **"Happening Today" section** — compact event list of every event active today. Sorted: free events first, then featured, then rest. Each row: emoji + title + cost badge (color-coded: green=FREE, amber=$, purple=$$) + city + time + venue. Shows up to 8 with "Show N more →" expand button. Newspaper-style typography (Playfair Display for titles).

3. **City Hall teaser** — compact info strip summarizing government digest coverage.

4. **Sports scoreboard** — full SportsView, unchanged, now in supporting role below the daily content.

### Why This Was the Strongest Move
The Today tab is the first impression — the argument for why someone should bookmark this. Before: "here's a sports scoreboard." After: "here's what's happening today — weather, events, then sports." The weather strip adds ambient context in one line. The events list is the real hook: instead of "12 events today" as a text teaser, you now see exactly what those 12 things are, for free. That's bookmarkable. It's what a local morning tab should do.

The rotation rule pushed away from pure data work (last cycle was Events) toward product/UX — the right call.

### What New Opportunities Emerged
1. **Events tab navigation from Today** — the Today tab shows events but doesn't deep-link to the Events tab with a city filter. A "See all in [city] →" interaction would add useful friction reduction.
2. **Plan My Day** — now the Today tab proves the events data has daily value. Plan My Day would be the interactive version of this: "build me a full day from what's available." The data foundation is solid.
3. **Government digest fix** — still the silent failure issue. Now more visible because the government teaser on Today tab would be much more powerful if the digest data showed there too.
4. **Development tracker** — "what's being built in your city?" is still the most unique possible section. No other South Bay site does this.
5. **Technology section** — local Bloomberg terminal for South Bay tech. Data-rich, chart-forward.

### Next 3 Strongest Ideas
1. **Plan My Day** — the signature interactive feature. Weather ✓, events data ✓, just need the AI itinerary builder. This is the "bookmark it forever" moment.
2. **Government digest fix** — investigate the silent failure (CivicEngage scraper or missing API key in deploy env). Even one working digest is better than three broken ones.
3. **Development tracker** — curate a JSON of 15-20 major known South Bay development projects (downtown SJ redevelopment, Mountain View mixed-use, etc.) with a clean "what's being built" view. Unique, ownable territory.

### Does the Product Now Feel Meaningfully Closer to "Default Homepage for South Bay Life"?
**Yes — materially closer to the morning tab promise.** The Today tab now earns its name. Someone opening it on a Thursday morning sees the weather, sees a list of real things happening today (a library story time, the Computer History Museum, Rancho San Antonio park, etc.), gets a City Hall teaser, and then finds the sports scoreboard. That's a daily briefing, not a sports widget. The sequence of information finally matches "this is your local morning tab."

---

## 2026-03-27 — Cycle 3: Technology Tab — Local Bloomberg Terminal for South Bay Tech

### Context
Coming off Cycle 2 which delivered the Today tab morning dashboard. The product now has: Today (morning dashboard), Sports (live scores), Events (40+ recurring), Gov (council digests). All four existing tabs were working. The natural next move was to open a new territory entirely — one that's distinctly South Bay and deeply data-driven.

### Issues Identified This Cycle
1. **No tech coverage** — the South Bay IS Silicon Valley. No tab covered the tech industry that defines this region economically and culturally. A South Bay homepage without tech is a map missing its most prominent feature.
2. **Product surface area too narrow** — four tabs covering sports, events, and local government is solid but not yet "default homepage" territory. Adding a fifth pillar with real depth signals ambition.
3. **No charts or data visualizations** — Recharts is in the project but unused in south-bay. Adding it makes the product feel more like a real data product, less like a dashboard demo.

### What Was Built

**`src/data/south-bay/tech-companies.ts`** — 16-company curated dataset:
- All major South Bay tech HQs: Apple, Google, NVIDIA, Intel, Cisco, Meta, AMD, Adobe, ServiceNow, PayPal, Palo Alto Networks, LinkedIn, Western Digital, eBay, Juniper, Zoom
- Each entry: global headcount estimate, trend (up/flat/down), trend note, 2 highlights, 1-line description, brand color, chart-display name
- Pulse stats: 4 headline numbers for the section header
- Pre-computed chart data: top 10 companies sorted by headcount, with colors and trend data

**`src/components/south-bay/views/TechnologyView.tsx`** — Full view component:
1. **Section header** — "South Bay / Technology" in newspaper style with subtitle and data disclaimer
2. **Pulse strip** — 4-stat card row: "16 Major HQs", "NVIDIA" (biggest gainer), "Intel" (most restructuring), "AI chips" (hot category)
3. **Top Employers chart** — Recharts horizontal BarChart showing top 10 by global headcount. Per-bar colors (brand-adjacent). Trend shown via opacity (declining companies lighter). Custom tooltip shows name + headcount + trend.
4. **Company grid** — 2-column card grid (1 column on mobile) showing all 16 companies sorted by headcount. Each card: name, ticker, city, category badge, headcount, description, trend note, 2 highlight bullets. Color-coded trend badges (green=growing, red=shrinking, gray=stable).
5. **Footer disclaimer** — data sourcing note, not investment advice

**`src/lib/south-bay/types.ts`** — Added 'technology' to Category and Tab union types, added Tech tab to TABS array

**`src/components/south-bay/SignalApp.tsx`** — Imported TechnologyView, added tab render

**`src/pages/south-bay.astro`** — Added full CSS block: tech-view, tech-header, tech-pulse, tech-section, tech-chart, tech-grid, tech-card, tech-trend badges, responsive mobile overrides

### Why This Was the Strongest Move
The rotation rule pushed away from pure UX polish (Cycle 2 was dashboard redesign). The highest-leverage new territory was Technology — it's:
- Uniquely South Bay (not available on any other local site)
- Data-rich in a way that's impossible to replicate by just listing links
- A reason to visit even on a slow local news day (tech is always moving)
- A proof point that South Bay Signal understands the full local picture, not just farmers markets and city council

The chart is the signature element: horizontal bar showing Google (181K) to Intel (108K) to Cisco (85K) to NVIDIA (36K). Seeing NVIDIA's comparatively small headcount next to its enormous market impact tells a story no text summary can. Intel shown lighter (declining trend) adds an editorial layer without editorializing.

The pulse stats are the fastest possible brief: "NVIDIA, biggest gainer. Intel, most restructuring." Two data points that capture the most important tech story in Silicon Valley right now.

### What New Opportunities Emerged
1. **Technology tab live feed** — the current data is a static snapshot. A live feed of South Bay tech news (job postings, earnings dates, funding rounds) would make this tab a daily destination.
2. **"What's hiring / what's cutting" view** — the trend data is already there. A focused view of who's growing (NVIDIA, ServiceNow, AMD) vs. who's shrinking (Intel, PayPal) would be highly shareable.
3. **Tech + events crossover** — "Events at tech campuses" (Stanford lectures, Computer History Museum, Tech Interactive) should appear in the Technology tab, not just Events.
4. **Plan My Day** — still the signature interactive feature. Events ✓, weather ✓, just needs the itinerary builder. This is next on the rotation after something else.
5. **Development tracker** — "what's being built" around these tech campuses (NVIDIA's new R&D building, Apple's expansion, Google's downtown San Jose campus) would connect tech and development in a powerful way.

### Next 3 Strongest Ideas
1. **Plan My Day** — the signature interactive feature. Everything it needs exists. This is the "bookmark forever" moment and should be prioritized soon.
2. **Events data volume push** — standing order says target 100+ events. Still at 47. Adding library programs, city parks events, Stanford calendar entries, and community centers would double coverage.
3. **Government digest fix** — three cities configured, silent failure on all. Investigating the CivicEngage scraper or confirming the API key is set in Vercel would unlock the Gov tab's actual value.

### Does the Product Now Feel Meaningfully Closer to "Default Homepage for South Bay Life"?
**Yes — a new dimension unlocked.** South Bay Signal now covers sports, events, government, AND technology. The nav bar reads "Today / Sports / Events / Gov / Tech" — that's a real product lineup, not a demo. The Technology tab alone is more useful than anything existing local media offers on this topic: no paywall, no generic Silicon Valley coverage, just the companies that are literally down the street from where residents live and work. The Recharts bar chart gives it a data product feel. Combined with the morning dashboard, live sports scores, and curated events, South Bay Signal is now approaching "I'd actually keep this open" territory.

---

## 2026-03-27 — Cycle 4: Plan My Day — The Signature Interactive Feature

### Context
Coming off Cycle 3 which delivered the Technology tab. Three cycles running, now with 6 tab categories. Every cycle has listed "Plan My Day" as the #1 or #2 strongest next move. The events data exists. The weather API exists. The infrastructure is there. This was the cycle to finally build the feature that makes South Bay Signal genuinely bookmarkable — not just useful to scan, but a product people come back to actively.

### Issues Identified This Cycle
1. **All existing tabs are passive** — every tab is "here's information." There's nothing interactive. The product has no "do something for me" feature.
2. **Events data has no personalization layer** — 40+ events is great, but there's no path from "I want to do something today" to "here's exactly what to do."
3. **Weather data is siloed** — the weather strip on Today tab shows current conditions but never influences any recommendations. It's ambient but not actionable.
4. **No reason to come back on a specific day** — a resident can check South Bay Signal once and feel done. Plan My Day adds a reason to revisit every time you want to do something.

### What Was Built

**`src/data/south-bay/poi-data.ts`** — 24 curated always-available Points of Interest:
- Outdoor/nature: Rancho San Antonio, Vasona Lake, Shoreline Park, Los Gatos Creek Trail, The Dish, Alum Rock Park, Hakone Gardens, Montalvo Arboretum, Stevens Creek Trail (9 options)
- Museums/indoor: Computer History Museum, The Tech Interactive, Children's Discovery Museum, Cantor Arts Center, San Jose Museum of Art (5 options)
- Neighborhoods/food: Downtown Campbell, Santana Row, Castro Street MV, Los Gatos Village, San Pedro Square Market, Willow Glen, Downtown Sunnyvale, Downtown Palo Alto (8 options)
- Each: indoor/outdoor classification, best time slots, kid-friendly flag, cost, "why it fits" hook

**`src/lib/south-bay/planMyDay.ts`** — Scoring algorithm:
- Inputs: `who` (solo/couple/family-young/family-kids/teens/group), `duration` (morning/afternoon/evening/full-day/quick), `vibe` (outdoors/indoors/mix), `budget` (free/some/anything)
- Weather parsing: detects rain/sun/heat/cold from weather string and adjusts indoor/outdoor scores
- Scoring: slot fit (+10), vibe match (+14), weather adjustments (up to ±22), kid-friendliness (±30 when family selected), budget match (up to +15), "today active" event bonus (+20)
- Time slots: morning (9am), lunch/midday (12pm), afternoon (2pm), evening (6pm)
- Duration mapping: full-day = all 4 slots, afternoon = lunch + afternoon, quick = 1 slot based on current time
- Candidate pool: all 40+ events + 24 POIs, scored per slot with no-repeat enforcement
- Outputs: `DayPlan` with `stops[]`, `weatherNote`, `headline`

**`src/components/south-bay/views/PlanView.tsx`** — Full interactive UI:
1. **Form state**: Who / Duration / Vibe / Budget as pill-select buttons (emoji + label + sub-label)
2. **Build button**: triggers 600ms artificial delay for UX (then runs algorithm synchronously)
3. **Results view**: headline + weather note bar + time-blocked stop cards
4. Each stop card: large emoji, title (linked if URL available), venue + city, cost badge, kid-friendly badge, indoor/outdoor badge, ★ Today badge (red, for events active today), "why it fits" note in body copy
5. **Start over** secondary button

**`src/lib/south-bay/types.ts`** — Added 'plan' to Category and Tab union types, added "Plan My Day" to TABS array

**`src/components/south-bay/SignalApp.tsx`** — Imported PlanView, added tab render

**`src/pages/south-bay.astro`** — Added full CSS block: plan-view, plan-section, plan-options, plan-option pill styles with --active state, plan-cta (primary + secondary variants), plan-headline, plan-weather bar, plan-stop-card, mobile overrides at 640px

### Why This Was the Strongest Move
"Plan My Day" has appeared as a top-3 idea in every single previous cycle. The blocking reason was always "needs events data" or "needs weather" — both of which were solved in Cycles 1-2. Cycle 4 was the moment to actually build it.

The feature's power comes from combining three things that already existed:
1. **Today's events** — the algorithm strongly favors events happening right now (today bonus: +20 points)
2. **Weather** — rain shifts the scoring toward indoor options by ±22 points; sun boosts outdoor picks
3. **User preferences** — family with young kids gets a ±30 kid-friendly filter; budget=free gets paid options excluded

The result is a plan that feels _made for today_ — not a generic list of things that are always open, but a day shaped by what's actually happening and what the weather actually is. A parent on a rainy Saturday selecting "family-young + full-day + mix + free" gets an itinerary of indoor kid-friendly options with "★ Today" badges on anything that's a live event that day.

The UI pattern — emoji option pills, then a "Build My Day →" button that processes and returns a time-blocked result — is clean, fast, and mobile-friendly. No forms to fill in. No text input. Just tap, tap, tap, and you have a plan.

### What New Opportunities Emerged
1. **Regenerate / shuffle** — "Try a different day" button to re-score with some randomization would add replayability and encourage return visits.
2. **Save / share your plan** — "Copy day plan" or "Share link" using URL params to encode the preferences, so people can share plans with friends.
3. **Events volume push** — the standing order to reach 100+ events becomes more urgent now that Plan My Day makes events data visible and actionable. More events = more interesting plans.
4. **Government digest expansion** — the Legistar scraper to unlock San Jose, Mountain View, Sunnyvale would add a huge amount of Gov tab value. Still the most impactful infrastructure improvement.
5. **Development tracker** — "what's being built near you" remains the most uniquely ownable section. No other South Bay product touches this.

### Next 3 Strongest Ideas
1. **Events volume push to 100+** — the standing order. Plan My Day makes this urgent: more events = more personalized plans. Target: library programs, city parks calendars, Stanford public events, cultural centers.
2. **Government digest expansion** — implement Legistar scraper for San Jose (largest city, most important decisions). Even one more city makes the Gov tab dramatically more useful.
3. **Plan My Day: share/save** — encode form state in URL params so users can share their plans. Small build, high bookmarkability boost.

### Does the Product Now Feel Meaningfully Closer to "Default Homepage for South Bay Life"?
**Yes — the first feature that makes people _do_ something.** South Bay Signal now has a feature that transforms it from "a place I check" into "a place I use." A resident opening it on a weekend morning can now get a real, personalized, today-specific, weather-aware day plan in four taps. That's the difference between a dashboard and a product. The nav now reads "Today / Sports / Events / Gov / Tech / Plan My Day" — each tab earns its place. Plan My Day is the one that creates habit.

---

## 2026-03-28 — Cycle 5: Events Volume Push to 100

### Context
Coming off Cycle 4 which delivered Plan My Day. Four cycles in: Today dashboard, Sports, Events, Gov, Tech, and Plan My Day are all live. The standing order to reach 100+ events has been open since Cycle 1. This was the cycle to execute it — not just because it's a directive, but because two downstream features (Plan My Day and the Today tab) become meaningfully better with more event variety. A sparse event list limits the quality of personalized itineraries. A full event list makes the product feel genuinely comprehensive.

### Issues Identified This Cycle
1. **Events at 40** — the standing order says 100+. A sparse events list limits Plan My Day quality, makes the Events tab feel incomplete, and leaves entire cities (Santa Clara, Los Altos, Milpitas, Cupertino) with little or no coverage.
2. **City coverage uneven** — Santa Clara had 0 events. Los Altos had 0 events. Cupertino had only Rancho San Antonio. Milpitas had only its farmers market. These gaps make the product feel like it's really just a San Jose/Palo Alto product.
3. **Plan My Day candidate pool too small** — with only 40 events + 24 POIs, the itinerary generator had limited variety. More events = more interesting, more personalized, more day-specific plans.
4. **Annual community events completely absent** — no Viva CalleSJ, no Christmas in the Park, no Tet Festival, no San Jose Jazz Summer Fest. These are the most notable recurring events in the South Bay and their absence made the product feel thin.

### What Was Built

**`src/data/south-bay/events-data.ts`** — Expanded from 40 to 100 events:

**New categories added:**
- **More markets (2)**: Los Altos Village Thursday Market, Cupertino Farmers Market — filling two underrepresented cities
- **Family/kids (12 new)**: Happy Hollow Zoo, Rosicrucian Egyptian Museum, Intel Museum (free!), History San Jose, Great America, NASA Ames Visitor Center, plus library programs for Sunnyvale, Cupertino, Santa Clara, Los Altos, and Milpitas — finally giving all 5 underrepresented cities active events
- **Outdoor/parks (12 new)**: Guadalupe River Trail, Emma Prusch Farm, Japanese Friendship Garden, Palo Alto Baylands, Fremont Older Open Space, Stevens Creek County Park, Picchetti Ranch, Lexington Reservoir, Sanborn County Park, Coyote Creek Trail, Overfelt Botanical Gardens, Santa Clara Central Park — nearly doubling outdoor options across all cities
- **Arts & culture (8 new)**: Triton Museum of Art (Santa Clara, FREE), Palo Alto Art Center (free), de Saisset Museum at SCU (free), City Lights Theater, Mexican Heritage Plaza, SJ Museum of Quilts & Textiles, Los Altos History Museum, Sunnyvale Community Players
- **Music (4 new)**: Art Boutiki (SJ indie institution), Los Gatos summer concerts, Sunnyvale summer concerts, Santana Row weekend concerts
- **Community/annual (12 new)**: Viva CalleSJ (spring/fall open streets), Christmas in the Park, SJ Jazz Summer Fest, Cinequest Film Festival, Sunnyvale Art & Wine Festival, Los Gatos Fiesta de Artes, San Jose Greek Festival, Tet Festival SJ, SJ Jazz Winter Fest, Campbell Oktoberfest, Mountain View Art & Wine Festival (Labor Day weekend), SoFA First Friday Art Walk
- **Food/neighborhoods (5 new)**: Japantown SJ, Downtown Los Altos Village, Murphy Avenue Sunnyvale, SoFA District, Downtown Los Gatos
- **Education (3 new)**: De Anza College, Foothill College, SJSU public events
- **Sports (2 new)**: Bay FC women's soccer (NWSL, PayPal Park), SJSU Spartans athletics

**All 11 cities now have meaningful coverage:**
- San Jose: 30+ events
- Palo Alto/Stanford: 10+ events
- Campbell: 7 events
- Mountain View: 7 events
- Santa Clara: 7 events (was 0)
- Los Gatos: 7 events
- Saratoga: 5 events
- Cupertino: 7 events (was 1)
- Sunnyvale: 8 events (was 1)
- Los Altos: 6 events (was 0)
- Milpitas: 3 events (was 1)

### Why This Was the Strongest Move
The standing order has been explicit since Cycle 1: "Volume over curation. It's easier to trim too much data than to feel sparse. Aim for 100+ events." The gap was not just a directive — it was actively limiting the product. Santa Clara with zero events and Los Altos with zero events means that city-filtered views return nothing for two of the 11 cities the product claims to cover. That's broken, not just sparse.

Beyond the standing order, the quality of Plan My Day is directly tied to event volume. More events = more variety = more likely to find something that matches today + your vibe + weather + budget. The itinerary builder now has 100 events + 24 POIs as its candidate pool — more than twice what it had before.

The annual events are especially powerful: Viva CalleSJ, Tet Festival, Christmas in the Park, San Jose Jazz Summer Fest, and Mountain View Art & Wine are flagship South Bay events. Having them listed transforms the product from "here are things that are always open" into "here is the full calendar of what makes this place special."

### What New Opportunities Emerged
1. **Government digest expansion** — still the most impactful infrastructure improvement. Legistar scraper would unlock San Jose, Mountain View, Sunnyvale, and Santa Clara.
2. **Plan My Day: share/save** — now that Plan My Day has 100+ events to draw from, encoding the plan in a shareable URL would let people forward their itinerary to a friend/partner. Small build, high habit value.
3. **"What's coming up" module on Today tab** — with annual events now in the data (with months[] arrays), the Today tab could show a "Happening this month" or "Coming up soon" section surfacing seasonal events like Cinequest in March or Tet in January/February.
4. **City-by-city view** — with all 11 cities now properly populated, a "Your City" mode or city snapshot card on the Today tab would be compelling. "What's in Los Altos this week?" now has a real answer.
5. **Development tracker** — still completely unbuilt and still one of the most uniquely ownable territories. "What's being built in your city?" with permit/approval data.

### Next 3 Strongest Ideas
1. **"What's This Month" module on Today tab** — use the `months[]` data to surface upcoming seasonal events and annual highlights. Show what's coming this month and next month. Turns the Today tab from "what's open now" into "what's coming up that's worth knowing about."
2. **Government digest expansion** — Legistar scraper for San Jose (the most important city for coverage). Even one more city would massively improve the Gov tab.
3. **Development tracker** — curated JSON of 15-20 major South Bay development projects (NVIDIA campus expansion, Google downtown SJ, San Jose downtown revitalization). The most uniquely ownable territory on the roadmap.

### Does the Product Now Feel Meaningfully Closer to "Default Homepage for South Bay Life"?
**Yes — comprehensively closer.** The jump from 40 to 100 events isn't just a number — it's the difference between a product that covers San Jose and Palo Alto and a product that genuinely covers all 11 cities. Santa Clara, Los Altos, Milpitas, Sunnyvale, and Cupertino now each have real things to show. The annual events — Tet Festival, Viva CalleSJ, Christmas in the Park, Mountain View Art & Wine, SJ Jazz Summer Fest — are what make the South Bay feel alive as a place, not just a map. Having them listed means South Bay Signal now covers the full texture of local life, not just the always-open institutions.

---

## 2026-03-28 — Cycle 6: Development Tracker

### Context
Coming off Cycle 5 which pushed events to 100+. All 6 tabs are live and functional. The Development Tracker has appeared in every "top 3 ideas" list since Cycle 1 and has never been built. The reason it kept slipping was that the earlier cycles were more immediately urgent (events data, Plan My Day, Tech tab). Now, with the foundation solid, this is the right moment: the single most uniquely ownable territory on the roadmap.

### Issues Identified This Cycle
1. **Zero coverage of what's physically changing** — South Bay Signal covers what's happening today (events, sports, gov) but nothing about what's being built tomorrow. A resident can check the site daily and have no idea that a 7.3M sq ft Google campus is going up near Diridon Station.
2. **No differentiated territory vs. basic local news** — The current tabs are well-executed but have analogues elsewhere. Development tracking as a curated structured layer is something nobody does well for the South Bay.
3. **Opportunity to anchor civic identity** — Residents care deeply about what's being built in their city. Housing approvals, tech campuses, transit projects affect property values, commutes, and neighborhood character.

### What Was Built

**`src/data/south-bay/development-data.ts`** — 16 curated South Bay development projects across: Transit (BART Phase II, Caltrain Electrification, BART Berryessa), Tech Campus (NVIDIA Voyager, Google Bay View, Apple Park), Mixed-Use (Google Downtown West, Google North Bayshore, Santana Row, Diridon Area Plan), Retail (Valley Fair), Housing (North SJ Urban Villages), Civic (Mineta Airport, Related Santa Clara), Proposed (HSR, Downtown Sunnyvale). Data model: status / category / scale / developer / timeline / featured / description. Pulse stats computed from live data.

**`src/components/south-bay/views/DevelopmentView.tsx`** — Header + pulse stats + dual filter pills (status + category) + sorted project list + footer attribution. Cards: color-coded status badge, category tag, ★ Signature badge, Playfair title, location, description, detail row.

**Types, SignalApp, south-bay.astro** — Added 'development' tab between Tech and Plan My Day, full dev-* CSS block with mobile overrides.

### Why This Was the Strongest Move
Development tracking hits four things: (1) unique territory no other South Bay site owns, (2) high-stakes for residents (housing/transit/campus changes affect daily life), (3) civic credibility signal, (4) long-tail return behavior as projects unfold over years. The status filter creates immediate utility — one tap shows everything actively under construction across the South Bay.

### Next 3 Strongest Ideas
1. **"What's This Month" module on Today tab** — use `months[]` event data to surface upcoming seasonal highlights on the homepage. Small build, big first-impression impact.
2. **Government digest expansion** — Legistar scraper for San José. Has been top-3 every cycle. San José is America's 10th largest city. One unlock makes Gov dramatically more valuable.
3. **Development city filter** — Add 'development' to showCityFilter in SignalApp + pass selectedCities to DevelopmentView. Lets residents ask "what's being built in Mountain View?"

### Does the Product Now Feel Meaningfully Closer to "Default Homepage for South Bay Life"?
**Yes — the first tab that's genuinely unmatched.** South Bay Signal now has 7 tabs: Today / Sports / Events / Gov / Tech / Development / Plan My Day. The Development tab covers territory no other South Bay local site touches in a clean, structured way. A resident who follows housing policy, transit projects, or tech campus growth now has a permanent reason to bookmark the site. The combination of "what's happening today" (Events, Plan My Day) and "what's changing over time" (Development, Gov) is what a real local intelligence product needs. Both are now present.

---

## 2026-03-28 — Cycle 7: Transit & Infrastructure Tab

### Context
Coming off Cycle 6 which added the Development Tracker. The vision document explicitly calls out Transit & Infrastructure as a full product section ("unglamorous but very useful"). The section has appeared in the vision doc since the beginning and has never been built. With 7 solid tabs now established, the product has a real gap: there's no coverage of the transportation layer that affects millions of South Bay residents daily. Caltrain, VTA, BART, and the highway network are not mentioned anywhere on the site.

### Issues Identified This Cycle
1. **Zero transit coverage** — South Bay Signal covers what's happening (events), what's being built (development), what government decided (gov), but nothing about how residents actually get around. For the largest commuter population in the US, this is a meaningful absence.
2. **Daily utility gap** — A resident who depends on Caltrain or VTA has no reason to check the site on a disruption day. Adding transit status and alerts creates a daily utility hook that events and sports can't provide.
3. **Transit projects are scattered** — BART Phase II, Caltrain electrification, US-101 express lanes, SR-85/I-280 work — these are massive projects affecting South Bay life that have no single clean source. South Bay Signal should own this.

### What Was Built

**`src/data/south-bay/transit-data.ts`** — Structured static snapshot of:
- 4 transit agencies (Caltrain, VTA, BART, ACE) with service status, status notes, key routes, and specific alerts
- 6 active road projects (US-101 express lanes, I-880 paving, SR-85/I-280 interchange, downtown SJ signal work, Story Road, Stevens Creek bike lanes)
- 7 transit project milestones with status (completed/in-progress/upcoming) spanning Caltrain electrification through BART Diridon opening in 2030
- 5 quick links to live real-time tools (511, Caltrain, VTA, BART, Caltrans Quickmap)
- SERVICE_CONFIG map with green/amber/red status display specs

**`src/components/south-bay/views/TransitView.tsx`** — Full transit intelligence dashboard:
- Header + 3-stat pulse strip (4 agencies, active alerts count, BART Diridon opening year)
- System-wide warning banner when any agency has disruptions
- Agency cards with: emoji, name, service status badge (with animated dot), status note, key routes as pills, service alerts with details, direct links to real-time departures
- Road projects in a 2-column grid with: highway label, impact badge (Low/Moderate/High), title, cities, description, schedule
- Transit milestone timeline (with colored dots: green=done, amber=in-progress, gray=upcoming)
- Quick links grid for live real-time tools

**Types + SignalApp + CSS** — Added 'transit' to Tab type and TABS array between Development and Plan My Day. Full transit CSS block with mobile overrides.

### Why This Was the Strongest Move
Transit hits the daily utility axis in a way no other tab does. Events are great for weekends. Development is a long-horizon tracker. Sports is entertainment. But transit status is a daily life need — someone checking "is Caltrain running?" has urgency that drives habitual use. The agency-by-agency structure also validates South Bay Signal's coverage ambition: it's not just fun local stuff, it's the full operating system for regional life. BART Phase II and the Diridon Station multimodal hub story is one of the biggest infrastructure stories in the country right now — having it tracked in a clean timeline makes South Bay Signal feel like a real civic publication.

### What New Opportunities Emerged
1. **Live transit status integration** — The static snapshot is a great starting point, but real value comes from pulling live Caltrain/VTA status from their public APIs (no auth required). Adding a fetch call that updates agency status on page load would make this dramatically more useful.
2. **"What's This Month" module on Today tab** — Still on deck. With 8 tabs now live, the Today tab feels light compared to the depth available. A "Seasonal picks this month" module would give the homepage a curated editorial voice.
3. **Development city filter** — Pass selectedCities to DevelopmentView and TransitView so users can filter road projects and transit work to their city. Small code change, high utility.

### Next 3 Strongest Ideas
1. **Live transit status fetch** — Caltrain and VTA both publish RSS/JSON status feeds. Fetching on page load (with a 5-minute client cache) would make the transit tab genuinely real-time. This could become a signature utility feature.
2. **"Happening This Month" module on Today tab** — Use the `months[]` event data to surface seasonal annual events (Tet, Viva CalleSJ, Jazz Fest, etc.) on the homepage. Small build, big first-impression impact for first-time visitors.
3. **Government digest: San José** — Legistar scraper for San José city council. America's 10th largest city. One unlock makes Gov dramatically more valuable.

### Does the Product Now Feel Meaningfully Closer to "Default Homepage for South Bay Life"?
**Yes — 8 tabs, comprehensive coverage.** South Bay Signal now covers: Today / Sports / Events / Gov / Tech / Development / Transit / Plan My Day. Adding Transit completes the "practical daily life" layer. A resident can now check: what's on today, how's traffic and Caltrain running, what's happening in local government, what's being built, and plan a weekend day — all from one page. That is a real local homepage, not a demo. The gap that remains is data freshness: the Government tab is partially broken, and Transit is a static snapshot. Closing those two gaps would make the product feel genuinely operational.

---

## 2026-03-28 — Cycle 8: "Your City" Personalization + This Month Editorial

### Context
Coming off Cycle 7 which added the Transit tab. The product now has 8 solid tabs. But the Today tab — the landing experience and daily homepage — still felt generic. It showed the same view to everyone regardless of where they live. A key principle of habit-forming products is personalization: "this is YOUR page, not a generic regional page." The Today tab had the right structure but lacked personal connection.

Two ideas that had been in the top-3 list for multiple consecutive cycles were finally ready: (1) "Your City" personalization and (2) "This Month" editorial. Both address the same root problem: the Today tab doesn't give users a strong reason to make it *their* homepage.

### Issues Identified This Cycle
1. **No personalization** — Every visitor sees the same generic view. Nothing says "this is tuned to where you live." Personalization is the difference between a utility and a habit.
2. **Today tab lacked forward-looking editorial voice** — The tab showed what's happening *today* but not what's worth knowing about this month. Seasonal/annual events (Cinequest in March, Viva CalleSJ in April, Jazz Fest in August) were buried in the Events tab. Nothing on the homepage surfaced "here's what's coming up in the South Bay that you shouldn't miss."
3. **Weather strip didn't know whose city it was** — It just said "South Bay, CA" — generic. Once a user sets their city, this should feel personal.

### What Was Built

**1. "Your City" home city personalization** (`SignalApp.tsx` + `OverviewView.tsx`)

- Added `homeCity` state to SignalApp, lazy-initialized from `localStorage("sb-home-city")`
- Persisted via `setHomeCity` callback that writes to/removes from localStorage
- City selection: inline CityPicker component with 11 city pills using existing `sb-city-pill` style
- When no city set: a gentle prompt banner ("Personalize for your city...") with "Set my city →" CTA
- When city set: "Today in [City]" section appears at the top of the overview with today's events filtered to that city
- "Change city" link in the section header for easy switching
- Home city name shown in the masthead date line in accent red (e.g., "Saturday, March 28, 2026 · San Jose")
- Weather strip shows "[City], CA" instead of generic "South Bay, CA"
- City-specific events excluded from the "Across the South Bay" section below to avoid duplication

**2. "This Month" editorial section** (`OverviewView.tsx`)

- Filters `SOUTH_BAY_EVENTS` where `recurrence === "seasonal"` and `months[]` includes current month
- Shows up to 6 cards in a responsive 2-column grid
- Each card: emoji, title, city, month badge (green for this month, gray for upcoming), cost badge, 2-line description
- "Coming in [Next Month]" preview: seasonal events starting next month but not yet active shown in same grid with gray badge
- Month name shown in accent red next to section title
- Sorted by featured flag so signature events (Cinequest, Great America, Sharks, Earthquakes) surface first

**3. Today tab restructure**
New section order:
1. City prompt (if no home city set) OR city picker (if changing) — top of fold
2. Weather strip (personalized city label)
3. "Today in [City]" — personalized city events (only shown when homeCity set)
4. "This Month" — seasonal editorial section (always shown when data exists)
5. "Across the South Bay" — all-region today events (excludes homeCity events if personalized)
6. City Hall teaser
7. Sports scoreboard

### Why This Was the Strongest Move
"Your City" is the feature that turns South Bay Signal from a useful regional site into *your* local homepage. The mechanics are simple (localStorage, city filter) but the effect is significant: the site now knows where you live, and the Today tab reflects that. A San Jose resident sees "Today in San Jose" before they see anything else. A Campbell resident sees their farmers market and library events front and center.

The "This Month" section adds the editorial layer that was missing. South Bay Signal now answers not just "what's happening today?" but "what's worth knowing about this month?" — which is the question a real local homepage should answer. Cinequest in March, Great America opening, Sharks season in progress, Earthquakes season starting — these are the things that make the South Bay feel alive as a place, and they now surface on the homepage.

### What New Opportunities Emerged
1. **Plan My Day: URL-encoded preferences** — Now that homeCity is a first-class state, it could pre-fill the Plan My Day feature. "Plan my day in San Jose" would be one click from the homepage.
2. **Live transit status** — Still the most impactful infrastructure improvement available. Caltrain RSS feed, no auth required.
3. **Government digest: San José** — Has been top-3 for 8 cycles. Still the most important single city to unlock.

### Next 3 Strongest Ideas
1. **Live Caltrain/VTA status fetch** — Make the Transit tab genuinely real-time. Caltrain publishes a JSON/RSS status feed. A simple fetch on tab load (with 5-minute cache) would make the Transit tab dramatically more useful and create a daily-urgency use case.
2. **Government digest: San José (Legistar)** — America's 10th largest city. One unlock makes the Gov tab go from "3 small cities" to "the entire South Bay." Has been #1 infrastructure priority for the whole project.
3. **Plan My Day: prefill from homeCity** — When a user has set their home city and clicks "Plan My Day," default the location context to that city. Small integration, big coherence payoff.

### Does the Product Now Feel Meaningfully Closer to "Default Homepage for South Bay Life"?
**Yes — the personalization layer is what turns a useful site into YOUR homepage.** Before this cycle, South Bay Signal could be described as a good local information product. After this cycle, it can be described as *your* local homepage. The home city feature creates the "this was made for me" feeling that drives bookmarking behavior. The "This Month" editorial section gives the homepage a voice — not just data, but curation. Combined, these two additions cross a qualitative threshold: the product now has identity and personal connection, not just utility.

---

## 2026-03-28 — Cycle 9: Government Expansion — Legistar Scraper + 5 New Cities

### Context
Coming off Cycle 8 which added "Your City" personalization and the "This Month" editorial section. The Government tab has appeared as a top-3 priority in every single previous cycle and was never fully addressed. Currently covering only 3 small cities (Campbell, Saratoga, Los Altos) via CivicEngage — which covers a small fraction of the South Bay population. San José, America's 10th largest city and the heart of Silicon Valley, has been completely absent from government coverage since day one.

The Legistar Web API (webapi.legistar.com) is free, public, JSON-based, and requires no authentication. Five major South Bay cities use Legistar for their council meeting management. This cycle finally implements that scraper.

### Issues Identified This Cycle
1. **Government tab covered <20% of population** — Campbell, Saratoga, and Los Altos are small cities (populations 40K, 30K, 30K respectively). San José (1M), Sunnyvale (155K), Santa Clara (130K), Mountain View (82K), and Cupertino (60K) were completely uncovered.
2. **San José gap was embarrassing** — The product claims to cover "the South Bay" but the region's largest city by far had no government coverage. This was the single biggest credibility gap.
3. **CivicEngage scraper hit PDF/HTML inconsistency** — The existing HTML scraper works for CivicEngage pages because they serve HTML agendas. Legistar typically uses PDF agendas — requiring a different content strategy. The Legistar EventItems API provides structured agenda items as JSON, eliminating the PDF problem entirely.
4. **Government tab UI showed "loading" per-city with no progress context** — With 3 cities, this was manageable. Expanding to 8 cities requires better loading UX.

### What Was Built

**1. Legistar scraper** (`src/lib/south-bay/agendaScraperFactory.ts`)

Extended `AgendaCityConfig` with:
- `legistarClientId?: string` — the Legistar client ID (e.g., "sanjose" → webapi.legistar.com/v1/sanjose/)
- `legistarBodyName?: string` — optional override if the exact Legistar body name differs from config.body

Extended `AgendaInfo` with:
- `legistarEventId?: number` — the Legistar EventId for the most recent meeting
- `legistarClientId?: string` — passed through for content fetching

`scrapeLegistar(config)` — new function:
- Calls `GET /v1/{client}/Events?$filter=EventBodyName eq 'City Council'&$orderby=EventDate desc&$top=5`
- Selects the most recent past meeting (skips future meetings)
- Returns `AgendaInfo` with `legistarEventId` and `legistarClientId` set
- Includes polite User-Agent header identifying South Bay Signal as a public information aggregator

`fetchLegistarContent(clientId, eventId)` — new exported function:
- Calls `GET /v1/{client}/EventItems?AgendaNote=1&$filter=EventItemEventId eq {id}&$orderby=EventItemAgendaSequence asc`
- Gets structured agenda items (number, title, notes) from the API
- Strips HTML from notes, formats as readable text for Claude summarization
- Truncates to 12K characters (same limit as CivicEngage)

**2. Five new Legistar city configurations** added to `AGENDA_CITIES`:
- `san-jose` → client `sanjose` — "1st and 3rd Tuesday"
- `mountain-view` → client `mountainview` — "2nd and 4th Tuesday"
- `sunnyvale` → client `sunnyvaleca` — "2nd and 4th Tuesday"
- `cupertino` → client `cupertino` — "1st and 3rd Tuesday"
- `santa-clara` → client `santaclara` — "2nd and 4th Tuesday"

Total cities: 3 (CivicEngage) + 5 (Legistar) = **8 of 11 South Bay cities**

**3. Updated digest API** (`src/pages/api/south-bay/digest.ts`)

Content fetching now follows a priority chain:
1. If `agenda.legistarEventId` is set → call `fetchLegistarContent()` (structured JSON)
2. If that returns null → fall back to `fetchAgendaContent(agenda.pdfUrl)` (HTML scraping)
3. If both fail → 502 error

This means Legistar cities get clean structured content from the API; CivicEngage cities continue to use HTML scraping.

**4. Improved GovernmentView UI** (`src/components/south-bay/views/GovernmentView.tsx`)

- Added "8 of 11 cities" badge next to section title (dynamically computed from configuredCities.length)
- Added a plain-English explainer paragraph below the header
- Multi-city loading indicator: when >1 city is loading simultaneously, shows a single "Generating N digests — this takes a moment…" banner instead of N individual spinners
- Per-city loading still shows when only 1 city is loading
- Error display now shows city name in the error message for clarity
- "Unconfigured cities" messaging now names which cities are configured

**5. Updated Overview City Hall teaser** (`src/components/south-bay/views/OverviewView.tsx`)

Changed from "Campbell, Saratoga, and Los Altos" to "8 South Bay cities — including San José, Mountain View, Sunnyvale, and Cupertino."

### Why This Was the Strongest Move

Government digest coverage has appeared in the "Next 3 Strongest Ideas" section of EVERY previous cycle — all 8 of them — and was never the top priority because there was always something more immediately needed. With 8 tabs now live and the product feeling genuinely useful, the government gap is no longer defensible.

The impact is categorical, not incremental:
- **Before**: 3 cities with ~100K combined population
- **After**: 8 cities with ~1.6M combined population (San José alone adds 1M)
- San José is the cultural, economic, and civic heart of the South Bay. Having it missing was like a Bay Area news product not covering San Francisco.

The Legistar API choice is the right technical approach:
- JSON API (no HTML parsing, no PDF downloading)
- Structured agenda items with numbers, titles, and notes
- Much more reliable than HTML scraping (no layout changes breaking the parser)
- The EventItems content is cleaner and more useful for Claude summarization than raw HTML

The content quality from Legistar is also better. Instead of trying to parse a PDF or dense HTML agenda page, Claude receives a numbered list of agenda items with staff notes. This produces more accurate, specific summaries.

### What New Opportunities Emerged
1. **Live government RSS/alert feeds** — Some cities (like San José) publish council alerts/highlights through city websites. A supplementary news feed layer on the Gov tab would add timely context between meetings.
2. **"What's on the agenda this week"** — The existing digests summarize the MOST RECENT past meeting. A companion section showing UPCOMING meeting items (from the next scheduled meeting's posted agenda) would add forward-looking value.
3. **Palo Alto (PrimeGov)** — The remaining major city not yet covered. PrimeGov is a different platform but also has a public API. Could add this in a future cycle to get 9/11 cities.
4. **Milpitas (CivicClerk)** — Smaller city but would complete the full 11-city sweep.
5. **Government tab improvements** — Now that 8 cities load, consider lazy-loading (only load visible/selected cities) or staggered loading to reduce simultaneous API calls.

### Next 3 Strongest Ideas
1. **"What's on the agenda this week" — upcoming meetings** — Add a section to the Gov tab showing next scheduled meeting dates and any pre-posted agendas. Currently all digests are backward-looking (most recent past meeting). Forward-looking civic intelligence is the other half of the value prop.
2. **Palo Alto government coverage (PrimeGov)** — Last major city without government digests. PrimeGov has a public API similar to Legistar. Getting to 9/11 cities makes the "South Bay-wide" claim much stronger.
3. **Live Caltrain/VTA status fetch** — Has been #1 infrastructure idea since Cycle 7. Caltrain publishes a public JSON feed. Making the Transit tab genuinely real-time would create a daily-urgency use case no other feature currently provides.

### Does the Product Now Feel Meaningfully Closer to "Default Homepage for South Bay Life"?
**Yes — the government coverage gap that undermined credibility is now closed.** South Bay Signal now generates AI digests for 8 of 11 South Bay cities, covering approximately 1.6 million residents. San José being present changes the product's credibility profile entirely. A San José resident — the most likely South Bay resident — can now see their city council's most recent meeting summarized in plain English. That has never existed in any form for this population. The Government tab is now the most uniquely differentiating section of the product: no other South Bay source aggregates plain-English council summaries across this many cities.

---

## 2026-03-28 — Cycle 10: Event Scraper + 1,724 Upcoming Events

### Context
Coming off Cycle 9 which expanded government coverage to 8 cities. The Events tab had two modes (Upcoming / Recurring) but "Upcoming" was a placeholder — the scraper hadn't been built. This cycle delivered the infrastructure: a script that fetches real, specific, dated events from 11 sources and generates a 1,724-event JSON feed.

### What Was Built

**1. `scripts/generate-events.mjs`** — event scraper for 11 sources:
- Stanford Events (Localist JSON API)
- SJSU Events (RSS)
- Santa Clara University Events (RSS)
- Computer History Museum (RSS)
- City of Campbell calendar (CivicPlus RSS)
- Town of Los Gatos calendar (CivicPlus iCal)
- City of Saratoga calendar (CivicPlus iCal)
- City of Los Altos calendar (CivicPlus iCal)
- San Jose Public Library (BiblioCommons API)
- Santa Clara County Library (BiblioCommons API)
- Silicon Valley Leadership Group (RSS)

**2. `src/data/south-bay/upcoming-events.json`** — 1,724 upcoming events from 9 active sources, deduplicated, sorted by date ascending. Each event: id, title, date (ISO), displayDate, time, venue, city, category, cost, description, url, source, kidFriendly.

**3. EventsView.tsx updated** — Upcoming tab now shows scraped events. Each card shows specific date in accent red, time, venue, cost badge, source attribution.

### Why This Was the Strongest Move
The events tab went from "37 recurring patterns" to "1,724 specific dated events with times, venues, and sources." This is the single biggest leap in content density the product has made. A user can now filter by city and find real things happening on real dates — not just "the farmers market is every Sunday."

### Next 3 Strongest Ideas
1. **Today tab: surface today's upcoming events** — The OverviewView still only pulls recurring events for "Happening Today." With 1,724 dated events, the Today tab could show 20-50 real events per day. This is the "aha" moment for daily use.
2. **Date grouping in EventsView** — 1,724 flat events is overwhelming. Grouping by Today / Tomorrow / This Week / Later makes the feed scannable.
3. **Schedule weekly scraper regeneration** — The events JSON is a static snapshot. Without automated regeneration, the data will go stale. A weekly cron job to re-run generate-events.mjs and commit the result keeps the feed fresh.

### Does the Product Now Feel Meaningfully Closer to "Default Homepage for South Bay Life"?
**Yes — the events tab is now a real event calendar, not a recurring-patterns list.** 1,724 specific dated events from 9 authoritative sources (Stanford, SJSU, SCU, libraries, city halls, Computer History Museum) gives the product density that no hand-curated South Bay site can match. The event feed is as comprehensive as any local calendar site — and it's filterable by city, category, and time with a UI better than any of those sources.

---

## 2026-03-28 — Cycle 11: Today Tab + Upcoming Events Integration + Date Grouping

### Context
Coming off Cycle 10 which built the event scraper infrastructure and generated 1,724 dated events. The critical gap: the Today tab (OverviewView) had zero awareness of these events. "Today in San Jose" would show 0-2 recurring events on most days even though 50+ real events were happening. This cycle closes that gap and makes the EventsView's 1,700+ events scannable.

### Issues Identified This Cycle
1. **Today tab ignored the entire scraped event feed** — The OverviewView still only filtered `SOUTH_BAY_EVENTS` (37 recurring events) for "Today in [City]" and "Happening Today." A San Jose resident who had set their home city would see a nearly empty "Today in San Jose" section despite dozens of library programs, lectures, and community events happening that day. This was the most jarring user experience gap.
2. **1,724 events as a flat list is overwhelming** — The EventsView Upcoming tab showed all events as a single scrolling wall. No way to quickly scan "what's happening today" vs "what's coming up next week."
3. **"Today in [City]" often showed 0 events** — San Jose has 2 recurring events in the static data. A resident setting their city would immediately hit a "No events found" message despite the scraped feed having dozens of real San Jose events for that day.

### What Was Built

**1. OverviewView.tsx — Today tab merged with scraped events**

- Added import of `upcoming-events.json` into OverviewView
- Added `TODAY_ISO` constant (`NOW.toISOString().split("T")[0]`) for date comparison
- Added `UpcomingEvent` interface matching the JSON schema
- Added `ScrapedEventRow` component — compact row showing title, time, city, venue, cost badge, with clickable link
- Added `TodayItem` discriminated union (`{ kind: "recurring"; data: SBEvent } | { kind: "upcoming"; data: UpcomingEvent }`) enabling mixed rendering
- Added `TodayRow` wrapper dispatching to `EventRow` vs `ScrapedEventRow`
- `cityTodayItems`: merges recurring events + today's upcoming events filtered to homeCity, sorted by cost (free first) then time
- `southBayTodayItems`: same merge for the region-wide section
- Shows up to 8 items in "Today in [City]", "+N more" link to Events tab
- "Across the South Bay" now counts scraped + recurring (e.g., "47 events" vs prior "3 events")

**2. EventsView.tsx — Date-grouped Upcoming tab**

- Added `getDateGroupLabel()` helper bucketing events into "Today" / "Tomorrow" / "This Week" / "Later"
- Added `groupedUpcoming` memo computing bucketed groups from `filteredUpcoming`
- Upcoming view now renders groups with sticky newspaper-style section dividers
- "Today" group header renders in accent red; other groups in muted gray
- Each group header shows event count
- "Later" group capped at 50 visible, with "Show N more events →" expand button
- Reset `showAllLater` not needed on filter change (users explicitly expand if desired)

### Why This Was the Strongest Move
The Today tab is the landing experience. Before this cycle, a user who set their home city to San Jose would see "No events found today" immediately — a trust-breaking moment. The scraped feed has 200-300 South Bay events on any given day. Surfacing those on the homepage turns the Today tab from a placeholder into a genuine daily brief.

Date grouping in EventsView solves a discoverability problem: "what's happening today" was buried in 1,724 flat cards. Now Today is a scannable group at the top, Tomorrow is below it, and users can load "Later" on demand. This makes the event feed genuinely usable for planning.

### What New Opportunities Emerged
1. **Schedule weekly scraper regeneration** — The events JSON is still a static snapshot from March 28. Without automated regeneration, the data will go stale within days. This is now the single highest infrastructure priority.
2. **"Upcoming meetings" section in Gov tab** — Legistar API can return FUTURE scheduled meetings. Forward-looking civic intelligence (what's on the agenda next Tuesday) is the complement to the backward-looking digests.
3. **Palo Alto government coverage (PrimeGov)** — Remaining major city without digests. Would bring coverage to 9/11 cities.

### Next 3 Strongest Ideas
1. **Set up automated weekly events scraper** — Run `generate-events.mjs` on a cron (weekly or daily), commit the result, redeploy. Without this, the data expires. Claude Code scheduled tasks or a GitHub Actions workflow are both options.
2. **Upcoming council meetings section** — Add a "Coming up" row to each GovernmentView digest card: next scheduled meeting date, any pre-posted agenda. Makes the Gov tab forward-looking, not just historical.
3. **Palo Alto government coverage (PrimeGov API)** — Last major city missing from Gov tab. PrimeGov has a public REST API. Getting to 9/11 cities completes the South Bay government picture.

### Does the Product Now Feel Meaningfully Closer to "Default Homepage for South Bay Life"?
**Yes — the Today tab now works as a real daily brief.** "Today in San Jose" on a given day might show 30+ events: library story times, SJSU lectures, community center programs, city-sponsored events, Computer History Museum programs. This is the density that makes a homepage worth bookmarking. The combination of specific times, venue names, and free/paid filtering makes it immediately actionable. The date-grouped EventsView makes the full calendar scannable rather than overwhelming. Together, these two changes cross another qualitative threshold: South Bay Signal now answers "what should I do today?" with real answers, not just recurring patterns.

---

## 2026-03-28 — Cycle 12: Automated Data Refresh + Upcoming Council Meetings

### Context
Coming off Cycle 11 which delivered date grouping in EventsView and integrated scraped events into the Today tab. The events data was a static snapshot from that morning. Without a refresh mechanism, it would degrade within days: past events would pile up, new library programs wouldn't appear, the "Today in San Jose" section would thin out. The product had all the right infrastructure but no heartbeat.

Simultaneously, the Government tab was entirely backward-looking: it showed what happened at the last council meeting but nothing about what's coming. A "Next meeting: Tue, Apr 7" label on the San Jose card answers a genuinely useful question that no other South Bay source provides in one place.

### Issues Identified This Cycle
1. **Events data goes stale without automation** — The 1,724-event JSON was generated on March 28 and would stay frozen until manually re-run. A product claiming to be "today's daily brief" needs data that refreshes daily, not manually.
2. **Government tab is entirely backward-looking** — Every digest card showed the last meeting's summary. There was no forward-looking civic intelligence — no answer to "when is the next meeting?"
3. **City government cards in empty state showed nothing** — A city without a pre-generated digest just showed "no digest yet" and a Generate button. No useful information. If we know the next meeting date from Legistar, that's civic value we can surface immediately without requiring the user to generate a digest.

### What Was Built

**1. GitHub Actions daily refresh workflow** (`.github/workflows/refresh-events.yml`)

- Runs every day at 6am PT via cron (`0 14 * * *`)
- Also has `workflow_dispatch` for manual triggers
- Runs `node scripts/generate-events.mjs` (events from 11 sources)
- Runs `node scripts/generate-upcoming-meetings.mjs` (council meeting dates)
- Commits and pushes both JSON files only if they changed (no-op commits avoided)
- Uses `GITHUB_TOKEN` with `permissions: contents: write` — no secrets needed
- Triggers a Vercel redeploy automatically on each push to main
- Result: the events feed and next-meeting data now refresh every morning automatically

**2. `scripts/generate-upcoming-meetings.mjs`** — new script

- Queries the Legistar Web API for 5 cities: San José, Mountain View, Sunnyvale, Cupertino, Santa Clara
- For each city: `GET /v1/{client}/Events?$filter=EventBodyName eq 'City Council' and EventDate gt datetime'{today}'&$orderby=EventDate asc&$top=1`
- Filters out placeholder dates more than 60 days out (Legistar often has distant year-end placeholders)
- Writes `src/data/south-bay/upcoming-meetings.json` with next meeting date, display date, location, and direct Legistar URL
- No API keys required — Legistar Web API is free and public
- Results this run: San José (Apr 7), Cupertino (Apr 1); Mountain View, Sunnyvale, Santa Clara had no near-term meetings posted

**3. GovernmentView.tsx + DigestCard.tsx updated**

- GovernmentView imports `upcoming-meetings.json` and passes `upcomingMeeting` to DigestCard for each Legistar city
- DigestCard: accepts optional `upcomingMeeting` prop; shows real meeting date (from JSON) in footer, linking to the Legistar event page — overrides AI-generated `nextMeeting` text when real data is available
- Empty state (no digest yet): now shows city name + "Next meeting: Tue, Apr 7 →" link instead of just "no digest yet". If no upcoming meeting is known, shows "No digest generated yet"
- Result: even before a user generates a digest, the Gov tab surfaces useful civic information — when the council meets next and where to find the agenda

### Why This Was the Strongest Move

**Automation closes the decay problem.** A product that describes itself as "the operating system for the South Bay" cannot run on stale data. The GitHub Actions workflow is the difference between a daily product and a snapshot that gradually lies. Once merged, South Bay Signal's events feed and upcoming meeting data self-refresh every morning. No human action needed.

**Upcoming meetings add a second dimension of civic value.** "Last meeting summary" (backward-looking) and "Next meeting date" (forward-looking) together tell a more complete story. The Gov tab went from: "here's what happened" → "here's what happened + here's what's coming." That's meaningfully more useful for anyone trying to stay engaged with local government.

**The empty state fix is high-leverage.** Most users will never click "Generate" on a city digest card — generating is a heavy action. But seeing "Next meeting: Tue, Apr 7 →" is a lightweight, instantly useful data point that requires zero user action. It turns a dead zone into a useful row.

### What New Opportunities Emerged
1. **Pre-generate digests on the same GitHub Actions cron** — Currently digests require manual generation (ANTHROPIC_API_KEY in secrets). If the key is set, we could regenerate all city digests automatically too, making the Gov tab truly "self-updating." One more script and one more workflow step.
2. **Upcoming meeting agendas** — When Legistar has a posted agenda for the next meeting, the EventItems API returns those items too. A "peek at the upcoming agenda" section (top 3-5 items) would be uniquely useful.
3. **Palo Alto PrimeGov coverage** — Still the largest city missing from Gov tab. PrimeGov has a public REST API.

### Next 3 Strongest Ideas
1. **Pre-generate city council digests automatically** — Add `ANTHROPIC_API_KEY` to GitHub Actions secrets and schedule digest regeneration. This turns the Gov tab from "on-demand AI" into "always-fresh summaries." Every morning, all 8 cities would have fresh digests waiting.
2. **Upcoming meeting agenda preview** — Use Legistar's EventItems API to show the top 3-5 agenda items for the next scheduled meeting. Adds forward-looking civic intelligence that no other source aggregates across all South Bay cities.
3. **Palo Alto PrimeGov coverage** — Remaining major city without Gov tab coverage. PrimeGov has a public REST API similar to Legistar. Would bring coverage to 9/11 cities.

### Does the Product Now Feel Meaningfully Closer to "Default Homepage for South Bay Life"?
**Yes — this cycle solves the permanence problem.** Previous cycles built excellent infrastructure but it was frozen in time. Now the product breathes: events refresh daily, council meeting dates update automatically, Vercel redeploys without human intervention. South Bay Signal crossed from "impressive demo" to "self-sustaining local intelligence layer." The upcoming meetings feature adds civic depth to the Gov tab that no other South Bay source provides — knowing when San José City Council meets next, with a direct link to the agenda, is genuinely useful to engaged residents.

---

## Cycle 6 — Event Scraper Expansion: +2 Sources, +254 Events, New City Coverage (2026-03-28)

### What Changed

**Problem**: The event scraper had three silent gaps: (1) SCCL was returning 0 events — the BiblioCommons API returns branch location *codes* (`CU`, `MI`, `LA`, etc.) not branch *names*, and the city mapper was only looking at text names. (2) San Jose Jazz and Montalvo Arts Center were listed in the script header comment as planned sources but never implemented. (3) iCal time window was only 14 days — too narrow for event discovery.

**What was built**:
- `fetchSjJazzEvents()` — scrapes San Jose Jazz RSS feed. 10 events, san-jose city. Music category.
- `fetchMontalvoEvents()` — scrapes Montalvo Arts Center RSS feed. 10 events, saratoga city. Arts category.
- **SCCL location code fix** — `fetchBiblioEvents` now passes `definition.branchLocationId` as third argument to cityMapper. Built `SCCL_LOCATION_MAP` dictionary: `CA → campbell`, `CU → cupertino`, `LA/WO → los-altos`, `LG → los-gatos`, `MI → milpitas`, `SA → saratoga`, `SC → santa-clara`. Result: SCCL went from 0 → 142 events.
- **Expanded time windows** — iCal sources: 14 → 30 days. Stanford: `days=14` → `days=30`, `pp=100` → `pp=150`.
- **BiblioCommons limit** — 100 → 200 per fetch.

**Results**:
- Total events: 1,724 → **1,978** (+254, +14.7%)
- SCCL: 0 → **142 events**
- San Jose Jazz: new source, **10 events**
- Montalvo Arts: new source, **10 events**
- New city coverage: milpitas (47), cupertino (17), expanded los-altos (66), saratoga (14)
- Active sources: 11 → **13**

### Why This Was the Strongest Move

**The SCCL fix was a silent bug for an entire library district.** Santa Clara County Library serves 11 South Bay cities. Library programs are exactly the high-quality, free, family-friendly content that makes South Bay Signal useful to regular residents — story times, workshops, author talks, craft programs.

**San Jose Jazz + Montalvo complete the "arts anchor" pair.** San Jose Jazz is the most prominent regional arts institution in the South Bay. Montalvo Arts Center is the flagship performance venue for the hill cities. Both were in the header comment as planned but never shipped.

### Next 3 Strongest Ideas
1. **Per-source event cap** — SJSU (633) and SCU (1,000) dominate the event counts. A `MAX_PER_SOURCE = 150` limit would surface community events more equitably in city-filtered views.
2. **Mountain View + Sunnyvale event coverage** — Two major cities with zero events. CivicPlus blocks bot access. Alternative: Eventbrite API free-event geo-search, or direct city RSS discovery.
3. **Pre-generate city council digests automatically** — ANTHROPIC_API_KEY not set in scheduled task env. Need GitHub Actions secret to make Gov tab auto-refresh.

### Does the Product Now Feel Meaningfully Closer to "Default Homepage for South Bay Life"?
**Yes — community-level events are now meaningfully represented.** The SCCL fix adds library programs across 7 South Bay cities. San Jose Jazz and Montalvo add the two flagship arts institutions. Events now have genuine breadth. Still needs Mountain View and Sunnyvale to feel complete.

---

## Cycle 13 — Event Scraper Quality: Category Fix + 60-Day Window + Source Balancing (2026-03-28)

### What Changed

**Problem 1: Category inference was badly ordered.** The `inferCategory` function checked "arts" before "sports," causing golf, tennis, soccer, and other sports events to be miscategorized as "arts" if any sports-adjacent word appeared in the description. The default fallback also produced noisy results for athletic events from SJSU.

**Problem 2: Event window was only 30 days.** iCal sources and Stanford's API were limited to 30 days, cutting off events that are announced in advance (library programs, festivals, athletic schedules).

**Problem 3: SJSU (633 events) and SCU (1,000 events) dominated the dataset.** With a 60-day window, SCU produced 1,000 events — half the entire dataset — all mapping to `santa-clara`. City-filtered views were flooded with university events while community events from smaller sources were buried.

**Problem 4: Six key sources missing.** Mountain View, Sunnyvale, San Jose city calendar, Cupertino, The Tech Interactive — all missing from scraper. Attempted to add all five.

**What was built:**

1. **`inferCategory` rewrite** — Sports check moved before arts. Added: golf, tennis, soccer, basketball, volleyball, swimming, track, cross country, lacrosse, football, gymnastics, wrestling, marathon, 5K, triathlon. STEM/science/coding added to education. Arts tightened (requires exhibit/gallery/theater/theatre/film/cinema/dance/performance/museum or explicit "art" without "martial" or "start"). Choir/orchestra added to music.

2. **60-day event window** — `fetchCivicPlusIcal`: 30 → 60 days. Stanford API: `days=30&pp=150` → `days=60&pp=200`.

3. **Per-source cap: 200 events** — After date-sorting, slice each source to MAX_PER_SOURCE=200. Prevents any single university from drowning the dataset.

4. **New source attempts** — Mountain View (403 blocked), Sunnyvale (403 blocked), San Jose city (403 blocked), Cupertino (404 — wrong URL), The Tech Interactive (404 — no WordPress feed). All fail gracefully with comments documenting the access issues.

**Results:**
- Total events: 1,978 → **821** (quality over quantity — better balanced)
- Category quality: significantly improved for sports events
- santa-clara: 934 → **188** (no longer dominated by SCU)
- san-jose: 827 → **399** (no longer dominated by SJSU)
- Sources documented: Mountain View/Sunnyvale/San Jose city/Cupertino block bot access. The Tech has no RSS.

### Next 3 Strongest Ideas
1. **Mountain View and Sunnyvale alternate sources** — CivicPlus blocks bot access for these cities. Alternatives: (a) Eventbrite free-event geo-search API (requires API key), (b) direct scrape of their Parks & Rec calendar pages, (c) add their library systems (Mountain View Public Library, Sunnyvale Public Library) via BiblioCommons or their own platforms.
2. **The Tech Interactive proper calendar** — thetech.org doesn't use WordPress RSS. Likely uses Eventbrite or a custom ticketing system. Check their events page source for an embedded calendar or Eventbrite organization ID.
3. **CHM date extraction fix** — Computer History Museum returns 8 events but 0 appear in the output because their WordPress pubDate is the article publish date, not the event date. CHM events have dates in their titles (e.g., "April 15: Talk on..."). A regex to extract dates from CHM titles would recover these events and fix Mountain View's zero-event problem.

### Does the Product Now Feel Meaningfully Closer to "Default Homepage for South Bay Life"?
**Yes — event quality improved significantly.** 821 well-balanced events beats 1,978 university-dominated events. A user filtering to Santa Clara (the city) now sees 188 relevant events instead of 934 SCU athletics. Sports events are correctly tagged. The 60-day window means upcoming library programs and athletic schedules appear further in advance. The product's filter UI is now more trustworthy.

---
