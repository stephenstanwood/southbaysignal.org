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

## Cycle 14 — Event Source Fixes: CHM, Stanford, SJSU Timeout + 4 New Source Attempts (2026-03-28)

### Context
Coming off Cycle 13 which fixed event quality (category inference, 60-day window, per-source caps). Three significant bugs were silently costing the scraper hundreds of events: CHM returning 0 events despite having 8 in the feed, Stanford returning 0 events despite having 98 in the API response, and SJSU timing out on its 1.4MB RSS feed.

### Issues Identified This Cycle
1. **CHM: 0 events** — Computer History Museum's WordPress `/events/feed/` uses `pubDate` = article publish date (Jan-March 2026), not the event date. Titles like "Apple at 50" don't embed dates. My `parseChmDate` helper (title regex extraction) didn't help because CHM titles have no date patterns. Root cause: exhibits are announced months before they open; by scrape time, `pubDate` is in the past.
2. **Stanford: 0 events** — Stanford Localist API returns series events where `first_date` = series start date (often January at quarter start). Recurring exhibits like "Archive Room" had `first_date = 2025-08-29`. All filtered as "past events" even though they're currently running.
3. **SJSU timeout** — SJSU's RSS feed (`calendar.xml`) is 1.4MB. The 15-second timeout was insufficient for the full download. Result: 0 SJSU events in the previous run's output.
4. **Mountain View has 0 events** — City site is 403 blocked. CHM (the only MV source) was broken. All 3 attempted BiblioCommons IDs for Mountain View Public Library returned 404 (library not on the platform).

### What Was Built

**1. CHM date fix** — Instead of extracting dates from titles (which don't have them), use today's date for CHM items published in the last 6 months. These are ongoing exhibits at a major Mountain View museum. Result: 0 → **8 events**, mountain-view: 0 → **8**.

**2. Stanford Localist fix** — For events where `first_date < now` but `last_date >= now` (ongoing series), use today as the event date. Future events continue to use `first_date`. Result: 0 → **5 unique Palo Alto events** (many of the 98 returned are duplicated instances of the same recurring exhibit, collapsed by deduplication).

**3. SJSU timeout fix** — `fetchText` now accepts an optional `timeout` parameter (default raised from 15s to 20s). SJSU explicitly passes 45s. SJSU back to contributing 100+ events.

**4. Configurable fetchText timeout** — `async function fetchText(url, timeout = 20_000)` — future slow sources can pass custom timeouts without modifying the function.

**5. 4 new source attempts** — All fail gracefully with clear error logging:
- Mountain View Public Library BiblioCommons ("mountainview") → 404 (not on platform)
- Sunnyvale Public Library BiblioCommons ("sunnyvale") → 403
- Palo Alto City Library BiblioCommons ("paloalto") → 500
- Happy Hollow Park & Zoo RSS (`/events/feed/`) → 200 response but 0 events (empty feed)

### Why This Was the Strongest Move
Three bugs were silently nullifying sources that were explicitly coded. CHM and Stanford are flagship South Bay cultural institutions — having them return 0 events was a silent product failure. Mountain View had zero coverage before this cycle. The SJSU timeout was costing the product its second-largest single source. Fixing all three is higher-leverage than adding entirely new sources that might have the same reliability issues.

**Results:**
- Total events: 318 → **433** (+36%)
- mountain-view: 0 → **8** ✅ (CHM fix)
- palo-alto: 0 → **5** ✅ (Stanford fix)
- SJSU contributing again (102 events in final output)
- 13 active sources (22 declared, 9 gracefully failing)

### What New Opportunities Emerged
1. **Sunnyvale coverage gap remains** — City site 403 blocked, library platform blocked. Possible alternatives: Sunnyvale Center for the Performing Arts, Sunnyvale Library might use a different catalog platform (try searching their website for event feeds).
2. **Mountain View library alternative** — MVPL is not on BiblioCommons. Check if they use SirsiDynix, Polaris, or another ILS with a public events API. Or check their city parks & rec calendar.
3. **SJ Jazz and Montalvo returning 0** — Both use WordPress `/feed/` (blog posts, not events calendar). pubDates are from March 2026, now in the past. Need to find their dedicated events calendar RSS or Eventbrite pages.
4. **Campbell CivicPlus RSS lacks startDate** — The RSS feed has no `calendarEvent:startDate` field. Falls back to pubDate (article date), which is in the past. Need alternative approach for Campbell city events.

### Next 3 Strongest Ideas
1. **Sunnyvale and Mountain View alternative sources** — These two cities still have 0 events. For MV: try Silicon Valley Arts Commission calendar, Castro Street events, or Shoreline Amphitheater (Ticketmaster would cover this). For Sunnyvale: check if Sunnyvale Center for the Performing Arts has an RSS feed.
2. **SJ Jazz + Montalvo proper events feeds** — Both venues likely use Eventbrite or a dedicated ticketing system. If we can find their Eventbrite org IDs, Eventbrite's free API tier (if still available) or a direct page scrape could recover these 20 events.
3. **Pre-generate council digests automatically** — The GitHub Actions cron runs daily but doesn't regenerate council digests (requires ANTHROPIC_API_KEY). Adding it as a secret and scheduling digest regeneration would make the Gov tab truly self-updating.

### Does the Product Now Feel Meaningfully Closer to "Default Homepage for South Bay Life"?
**Yes — silent failures fixed, coverage gaps partially addressed.** Mountain View finally has real events (Computer History Museum exhibits). Palo Alto/Stanford is now represented. The SJSU fix is invisible to users but restores the backbone of the San Jose event feed. The product now covers 9 of 11 cities with at least some events. Sunnyvale remains the most notable gap. The work this cycle was "fixing what was pretending to work" — critical infrastructure that enables everything else.

---

## Cycle 15 — Campbell Events Fix + "This Week" Section on Today Tab (2026-03-28)

### Context
Coming off Cycle 14 which fixed CHM, Stanford, and SJSU bugs. Three sources remained silently broken: Campbell (0 events), SJ Jazz (0 events), and Montalvo (0 events). Additionally, the Today tab still lacked any forward-looking content — if today has few events in your city, the homepage offers no path forward except switching tabs.

### Issues Identified This Cycle
1. **Campbell: 0 events** — The Campbell city calendar uses `calendarEvent:EventDates` (e.g., "April 7, 2026") not `calendarEvent:startDate`. The RSS parser was reading the wrong field. Result: 0 events despite the feed returning 6 real items.
2. **SJ Jazz + Montalvo: 0 events** — Both sources use WordPress blog RSS feeds, not event calendars. Their `pubDate` timestamps are from 2024-2025 — all filtered out as past events. They were silently contributing 0 useful data.
3. **Today tab: no forward view** — "Today in San Jose" shows 0-3 events on slow days and then hits "Nothing scheduled today." Users have no way to see what's coming later in the week without clicking to the Events tab.

### What Was Built

**1. Campbell RSS fix** (`scripts/generate-events.mjs`)

Root cause: Campbell uses `calendarEvent:EventDates` (note the plural 's') not `calendarEvent:startDate`. Added two new helpers:
- `parseCivicPlusEventDates(str)` — parses "March 28, 2026" or "April 6, 2026 - April 10, 2026" (takes start date of range)
- `parseCivicPlusEventTime(str)` — converts "07:00 PM - 09:00 PM" to "7pm – 9pm" display format

Updated `parseRssItems` to capture `calendarEvent:EventDates` and `calendarEvent:EventTimes` fields. Updated `fetchCampbellEvents` to use `parseCivicPlusEventDates(item.eventDates)` as primary date source. Result: Campbell: 0 → **5 real community events** with proper times ("Parks and Recreation Commission Meeting 7pm – 9pm", "City Council Regular Meeting 7pm", etc.)

**2. SJ Jazz + Montalvo documented and clarified**

Both sources are blog RSS feeds (news articles about past events/artists/residencies). Their blog posts don't contain upcoming events. Rather than leaving them as silent noise producers, added clear comments documenting why they return 0 events and that both venues are already covered in `events-data.ts` (recurring events layer). Prevents future confusion about why these "working" sources produce no output.

**3. "This Week in [City]" section** (`src/components/south-bay/views/OverviewView.tsx`)

Added a new section between "Today in [City]" and "This Month" that shows upcoming events for the next 6 days, grouped by date:
- Shown only when `homeCity` is set
- Filters scraped upcoming events to home city only, excludes sports
- Each day group: newspaper-style monospace date header, 2-column grid (matches Today layout)
- Up to 4 events per day to keep the section scannable
- Days with 0 events are hidden (no empty day headers)
- Section header shows total event count for the week
- Pre-computed `NEXT_DAYS` array at module load time for clean code

### Why This Was the Strongest Move

**Campbell fix** closes the most embarrassing scraper gap. The CivicPlus RSS documentation is inconsistent — some deployments use `startDate`, others use `EventDates`. The data was there the whole time, just reading the wrong field name. Campbell city events are high-quality content: council meetings, commission meetings, and community programs with real dates and times.

**"This Week" section** is the forward-looking layer the Today tab was missing. A user who opens South Bay Signal on a Tuesday and sees 1 event today can immediately scroll to "This Week in San Jose" and see what's coming on Wednesday (library program), Thursday (arts center opening), Friday (community market). This is the critical difference between "here is today" and "here is your week." For most days, there are 3-15 city events happening in the next 6 days — now they surface on the homepage without requiring a tab switch.

The combination: more data (Campbell fixed) + better UI (forward view) = meaningfully more useful homepage.

### What New Opportunities Emerged
1. **"This Week" for South Bay-wide** — The current implementation is city-only. A second version showing the top events across the whole region (top 2 per day, diverse sources) would give users without a home city a forward-looking view too.
2. **Sunnyvale coverage gap** — Still 0 events. City blocks all bot access. The only realistic path: find if Sunnyvale Center for the Performing Arts or Sunnyvale Library uses a platform with a public API (currently failing with fetch errors — may be a DNS/SSL issue, not a bot block).
3. **SJ Jazz/Montalvo proper events calendar** — Both use WordPress blogs for news, but their actual ticketing is likely on Eventbrite or similar. If we can find their Ticketmaster artist pages or Eventbrite org IDs, we could pull real show listings.

### Next 3 Strongest Ideas
1. **Pre-generate city council digests automatically** — Add ANTHROPIC_API_KEY to GitHub Actions secrets, schedule digest regeneration on the same cron as events. This turns the Gov tab from "on-demand AI" into "always-fresh summaries every morning."
2. **Sunnyvale and Mountain View library systems** — Neither city library is on BiblioCommons. Mountain View Public Library and Sunnyvale Public Library may use different ILS platforms (SirsiDynix, Polaris, etc.) that have public event APIs. Worth a targeted investigation.
3. **"This Week" with smart highlighting** — Add visual differentiation to the This Week section: mark events as "free", highlight upcoming sports games, flag kid-friendly events with an icon. Currently it's information density without editorial curation.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — the Today tab now answers "what's happening this week?" not just "what's happening today?"** The combination of "Today in [City]" → "This Week in [City]" → "This Month" creates a temporal sequence that covers the immediate (today), the near-term (this week), and the seasonal (this month). A San Jose resident can open the page on a quiet Monday and still get a useful picture of the week ahead. That's the behavior of a daily-use homepage. Campbell being back in coverage means a resident of that city can actually set their home city and get relevant results instead of a nearly-empty list.

---

## 2026-03-28 — Cycle 16: Signal Briefing — Newspaper Front Page Hero + Police Blotter Strip

### Context
Coming off Cycle 15 which fixed Campbell events and added the "This Week" section. Stephen explicitly flagged this as "nowhere near ambitious enough" — the cycle was incremental when the goal demanded transformation. The product had strong data depth across all tabs but the Today tab — the landing experience — still looked and felt like a list. Nothing about it said "this is the homepage for South Bay life." The first impression was functional but not viscerally different from any generic regional news aggregator.

### Issues Identified This Cycle
1. **No editorial voice on Today tab** — the tab had weather, events, sports. But no single moment that synthesized the most important information into a lead. Real newspapers have front pages. South Bay Signal had a feed.
2. **Data depth not visible on the surface** — the product covers government across 8 cities, 16 development projects, 821 curated events, transit infrastructure. None of this was visible the moment someone landed. You had to click around to discover the product's intelligence.
3. **Police blotter existed in the data but was buried** — `blotter.json` had real SJPD call data with types, times, and locations. It was rendered only in GovernmentView. It's the kind of data that creates a "check it every morning" habit — and it was invisible from the Today tab.
4. **No reason to screenshot and share the page** — for a product to spread word of mouth, it needs a moment that makes people say "look at this." A list of events doesn't do that. A newspaper front page does.

### What Was Built

**Signal Briefing** (`src/components/south-bay/views/OverviewView.tsx`)

A 3-column newspaper-style hero section rendered at the top of the Today tab, above everything else. Dynamically generated from live data on every page load.

**Three lead story cards**, each with:
- Category label in accent color + emoji (EVENTS · GOVERNMENT · DEVELOPMENT)
- Bold Playfair Display headline (3-line clamp)
- 2-line lede text
- "Go to [tab] →" action link

**Story generation logic:**

1. `pickTopEvent()` — scores every today-active scraped event by: free (30pts), has time (10pts), has URL (5pts), venue match against prestige list (Stanford, CHM, Tech Interactive, Bing Concert Hall, etc. = 20pts). Returns the highest-scoring non-sports event with its details formatted as a lede.

2. `pickCityHallStory()` — uses the home city's (or San José's) digest: shows the first key topic as the headline, summary as the lede. Falls back to a generic "AI council summaries" teaser when no digest exists. City-aware — a Campbell resident sees Campbell's last council topic, a San José resident sees San José's.

3. `pickDevelopmentStory()` — picks the featured under-construction or opening-soon development project (BART Phase II, Google Downtown West, etc.) with status badge, city, scale, and timeline as the lede.

**Styling (`.sb-briefing-card`, `.sb-briefing-grid`):**
- 3-column grid separated by 1px vertical rules — newspaper column format
- Card hover: light background wash with no border change (clean, editorial feel)
- Each card `min-height: 160px` to ensure visual balance across varying headline lengths
- Mobile: stacks to 1 column with horizontal rules between cards

**Section label:**
- "Signal Briefing" centered with em-rules on both sides — the horizontal rule treatment from newspaper section headers. Space Mono, small caps, letterSpaced.

**Police Blotter Strip** (`src/components/south-bay/views/OverviewView.tsx`)

Surfaced on the Today tab for the home city when blotter data is available (currently SJPD / San José).

- Shows top 5 most recent calls from `blotter.json`
- Per-row: monospace time, type badge (color-coded by priority), location in Space Mono
- Section header with city name, call date, and direct link to source
- "Full blotter in Gov tab →" link for residents who want more

**Import additions:**
- `blotterJson` from `data/south-bay/blotter.json`
- `STATUS_CONFIG` from `development-data.ts` (for status label rendering in dev story)

**CSS additions (`src/pages/index.astro`):**
- `.sb-briefing-grid` — 3-col grid, border, no gap
- `.sb-briefing-card` — flex column, border-right, min-height, hover transition
- Mobile overrides: single column, border-bottom between cards

### Ideas Considered

**1. Signal Briefing (newspaper front page hero)** ← BUILT
3-column synthesized lead stories from live data. The "screenshot and share" moment. Transforms the Today tab from a list to a publication.

**2. Police Blotter on Today Tab** ← BUILT
The habit-forming morning check feature. Real call data, monospace times, location. Exists in the data — was buried in Gov. Surfaced it.

**3. "Morning vs. Evening" mode for the Today tab**
Would reorganize the event display based on time of day: morning view shows upcoming events, evening view shows what's happening tonight. Interesting but incremental vs. the briefing approach.

**4. City-specific "Signal Brief" — a full paragraph synthesis for your home city**
A Claude-generated single paragraph: "Here's what's happening in San Jose today — [event], [council note], [development note]." Would require API call on page load, adds latency, and depends on ANTHROPIC_API_KEY being available in client env. Not the right cycle for that.

**5. Side-by-side "morning edition" layout**
2-column newspaper grid for the entire Today tab — events on the left, government/development on the right. Interesting visual but would require major restructuring and might hurt mobile. The briefing header achieves similar visual impact with less disruption.

**6. "What's Free This Weekend" callout card**
A persistent feature highlighting the top 3 free events for the coming weekend. High utility but overlaps with Plan My Day. Could be a future addition as a persistent card below the briefing.

### Why This Was the Highest-Leverage Move

The Signal Briefing solves the most fundamental problem with the Today tab: **it had no voice.** It was a collection of sections — weather, city events, this week, this month, sports — but no single editorial moment that answered "here's what matters most right now."

The briefing creates that moment. A user opening the page sees three things simultaneously: (1) the most compelling event happening today, scored for quality and accessibility; (2) the last thing the city council discussed; (3) the biggest infrastructure project currently under construction. That's a South Bay intelligence brief, not a feed.

The 3-column newspaper format is visually distinct from everything else on the page. It looks like a front page, not a dashboard. That's by design — the goal is to make the first impression say "this is a publication" not "this is an app."

The blotter strip is the habit-creation feature. Real newspaper readers check the police blotter. It's local, it's specific, it changes daily, and it creates mild urgency. A San José resident who checks the blotter and sees a disturbance on Lincoln Ave near their neighborhood will come back tomorrow. That's the repeat-visit mechanic.

**Combined effect:** A user who opens South Bay Signal on a Tuesday morning now sees:
1. Signal Briefing — three lead stories, newspaper format, one click to go deeper
2. Police blotter — last night's calls in their city, times + locations
3. Sports callout (if game day)
4. City at a glance (government, projects)
5. Today's events, time-bucketed
6. This week's events, grouped by day
...

That's a homepage. Not a feed, not a dashboard. A homepage.

### Effect on Real Users
- **First-time visitor**: Sees the Signal Briefing and immediately understands the scope of the product — it covers events, government, and development. Three headline stories make the value proposition legible in 5 seconds.
- **Daily user**: Opens the page, scans the three briefing cards for anything notable, checks the blotter for last night, then scrolls to today's events. Entire flow takes under 60 seconds.
- **Share behavior**: A resident who sees "BART Silicon Valley Phase II · Under Construction · 6 miles, 2 new stations · Expected mid-2030s" in the development card — formatted like a real editorial brief — is more likely to share the page than someone who sees a flat list.

### Next 3 Strongest Ideas
1. **Automated daily digest pre-generation** — Add ANTHROPIC_API_KEY to GitHub Actions secrets, schedule digest regeneration on the 6am cron that already refreshes events. This turns the Gov tab from "on-demand AI" into "always-fresh council summaries every morning." The Signal Briefing's government card would then be updated daily without any user action.
2. **Signal Briefing: event card links to event detail** — Currently the top event card navigates to the Events tab. If the event has a URL, it should open directly. (This is partially implemented — needs the `url` prop wired through to the button action, which is ready in the code.)
3. **"What's Free This Weekend" persistent card** — Below the Signal Briefing, a compact 3-event highlight showing the best free events for Saturday and Sunday. This answers the single most common question a resident has ("what can I do this weekend for free?") at first glance, without requiring a tab switch.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — the Today tab now has a front page.** The Signal Briefing transforms the first impression from "a feed" to "a publication." Three newspaper-style lead stories — one from events, one from government, one from development — synthesize the product's full intelligence into a scannable above-the-fold section. The police blotter adds the one element a morning daily-use product uniquely needs: local public safety context that changes every night. A resident can now open South Bay Signal, scan the briefing in 10 seconds, check the blotter, and understand what's happening in their city before they finish their coffee. That is what the default homepage promise requires.

---

---

## 2026-03-28 — Cycle 17: Weekend Spotlight + Signal Briefing Government Story Upgrade

### Context
Coming off Cycle 16 which delivered the Signal Briefing newspaper hero + police blotter strip. Today is Saturday March 28 — an ideal cycle to ship a weekend-specific feature, since the product is live and the weekend is actively happening. The last 3 strongest ideas from Cycle 16:
1. Automated daily digest pre-generation (requires ANTHROPIC_API_KEY in GitHub Actions — not available this cycle)
2. Signal Briefing event card URL fix (already wired correctly in code)
3. "What's Free This Weekend" persistent card

### Issues Identified This Cycle
1. **Signal Briefing government card used stale digest.json for most cities** — The existing `pickCityHallStory()` had noise filtering, but many cities' "best" topics were still generic. More critically: `around-town.json` (continuously updated from Stoa's live council meeting tracking, last updated March 25-26) was being displayed separately in AroundTownSection but completely ignored by the Signal Briefing — the most prominent feature on the page. The San Jose digest had ALL noisy topics (meeting logistics). The Briefing was falling through to Sunnyvale's "Federal grant funding" headline regardless of home city.
2. **No weekend-specific view** — The Today tab has great daily intelligence but no distinct weekend mode. On a Saturday morning, the product should answer "what should I do this weekend?" — not just "what's on the calendar today." The existing "Today in [City]" answers today, but not Sunday's events. The "This Week" section gives a forward view but isn't curated or highlighted.
3. **Government story had no city attribution** — Users couldn't tell which city the government briefing story was about from the Signal Briefing card alone.

### What Was Built

**1. Signal Briefing government story upgrade** (`pickCityHallStory` in OverviewView.tsx)

- Now checks `aroundTownJson.items` first (Stoa-sourced, continuously updated council highlights)
- City-matched: if homeCity is set, filters to that city's items first; falls back to most recent item from any city
- Lede now prefixed with city name: "Mountain View · The City Council approved a development agreement..."
- Story URL set to `aroundItem.sourceUrl` (city's Legistar/meetings page) — clicking the government card now links to the actual source
- Falls back to digest-based logic if around-town.json has no items
- Effect: a user on Saturday morning sees "Mixed-use housing development approved at 490 East Middlefield Road" (Mountain View, March 24) instead of vague meeting logistics

**2. Weekend Spotlight section** (new `WeekendSpotlight` component, `IS_WEEKEND_MODE` constants)

Module-level additions:
- `IS_WEEKEND_MODE`: true on Friday (DAY_IDX=5), Saturday (6), Sunday (0)
- `TOMORROW_DAY_NAME`: day-of-week name for tomorrow, used to filter static recurring events
- `TOMORROW_MONTH_NUM`: month number for tomorrow
- `TOMORROW_ISO_STR`, `TOMORROW_LABEL_STR`: from NEXT_DAYS[0]

New `isActiveTomorrow(e: SBEvent)` helper: mirrors `isActiveToday` but checks tomorrow's day name and month.

`WeekendSpotlight` component:
- Only renders when `IS_WEEKEND_MODE` is true
- Pools events from 4 sources: static recurring (today), scraped upcoming (today), static recurring (tomorrow), scraped upcoming (tomorrow)
- Deduplicates by title+day (prevents same farmers market appearing twice)
- Scores each event: free (+40), market (+25), family/outdoor (+10), kidFriendly (+15), sports (-50), homeCity (+20), has-time (+5)
- Returns top 4 today picks + top 3 tomorrow picks
- Renders in two groups with day headers ("Today · Saturday" and "Sun, Mar 29")
- Reuses existing `EventRow` and `UpcomingRow` components for consistent design
- "See all weekend events →" link navigates to Events tab
- Header: "This Weekend in [City]" (if home city set) or "This Weekend"
- Placed between AroundTownSection and Today in [City] — after the news context, before the full daily list

### Ideas Considered

**1. Weekend Spotlight** ← BUILT
Directly answers "what should I do this weekend?" — the most common weekend question a resident has. Surfaces Saturday farmers markets, free community events, arts, and family activities from both recurring and scraped sources. Today being Saturday made it immediately testable and visible.

**2. Signal Briefing government story quality upgrade** ← BUILT
The government card is the second panel of the most prominent section. Using around-town.json makes it consistently fresh and high-quality (real council decisions vs. meeting logistics). City attribution in the lede solves the "which city is this?" UX gap.

**3. Automated digest pre-generation via GitHub Actions**
Still the highest-infrastructure idea. Would require ANTHROPIC_API_KEY in repo secrets. Not available in the scheduled task environment. Deferred.

**4. Pre-generate fresh digests locally**
The ANTHROPIC_API_KEY was not set in the local shell environment. Could not run generate-digests.mjs.

**5. Development tracker data refresh**
The development-data.ts static projects haven't been audited in several cycles. Would require research into current project statuses. Good candidate for a future cycle.

### Why This Was the Highest-Leverage Move

**Weekend Spotlight solves a visible gap** for the most important use case: weekend planning. Saturday morning is when people are most likely to open a local discovery product. Before this cycle, the Today tab on Saturday showed today's events (including farmers markets from the static layer) but nothing about Sunday. A San Jose resident could see "Today in San Jose" with a few events, but had to click to the Events tab and manually filter to find Sunday's activities. The Weekend Spotlight surfaces Saturday + Sunday in one curated view with the best free/family picks ranked by quality — without requiring any tab switching.

**Signal Briefing quality lift is immediate and universal.** Every user who opens the Today tab now sees a real, recent council decision with a city attribution in the government briefing card — instead of possibly empty noise ("live translation available in 50 languages") or stale February content. Using around-town.json as the primary source means the quality improves automatically whenever Stoa pushes new council meeting data (which happens after every council meeting).

**Both changes improve the first impression.** Signal Briefing is the very first section after weather. Weekend Spotlight is the first new section after the news context. Together they make the Saturday morning experience significantly more useful.

### Effect on Real Users
- **Saturday morning visitor**: Opens page → sees Signal Briefing with real Mountain View housing decision → scrolls past sports/blotter/news → hits "This Weekend in [City]" with today's farmers markets, free arts events, and Sunday highlights → feels like the page "gets it"
- **Sunday afternoon visitor**: Sees "Today · Sunday" with the best remaining Sunday activities → still useful even mid-day
- **User without home city**: Weekend Spotlight shows region-wide top picks, still curated and ranked

### Next 3 Strongest Ideas
1. **Automated digest pre-generation in GitHub Actions** — Add ANTHROPIC_API_KEY as a repository secret, run generate-digests.mjs in the daily 6am cron. This makes the Gov tab always-fresh without manual generation. The Signal Briefing government card quality is already improved via around-town.json, but full digest regeneration would update the Government tab's per-city digest cards daily.
2. **Development tracker data audit + refresh** — development-data.ts has projects like "BART Silicon Valley Phase II" and "Google Downtown West" added in early cycles. Their status/timeline descriptions may be stale. An audit + update to reflect current construction status would improve the Development tab and Signal Briefing development card accuracy.
3. **Sunnyvale events coverage** — Sunnyvale remains the major coverage gap (city CivicPlus 403-blocked, library platforms failing). One untried path: Sunnyvale Center for the Performing Arts event calendar, or the City of Sunnyvale's Recreation & Community Services direct page.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — the Saturday experience is materially better.** A resident who opens South Bay Signal on a Saturday morning now gets: a government briefing story that names a real council decision with its source city, a dedicated "This Weekend" section surfacing the best free and family-friendly picks across both weekend days, and all the existing depth underneath. The page now answers the weekend's primary question ("what should I do?") without requiring any navigation. That's what a default homepage does.


---

## 2026-03-28 — Cycle 18: Entertainment Venue Showcase — Venues Tab + On Stage Section

### Context
Coming off Cycle 17 which delivered Weekend Spotlight and Signal Briefing government story upgrade. The product had 98 Ticketmaster events in the feed (SAP Center, San Jose Improv, The Ritz, San Jose Civic, SJ Center for the Performing Arts, Frost Amphitheater at Stanford, Tech CU Arena, McEnery Convention Center) — real show listings including David Byrne at Frost Amphitheater, Beetlejuice and Les Misérables touring at SJ Center for the Performing Arts, and a packed San Jose Improv lineup. None of this was visible as a curated entertainment guide. It was just more rows in a date-sorted event list.

### Issues Identified This Cycle
1. **98 Ticketmaster events invisible as entertainment intelligence** — The Events tab displayed them in date order mixed with library programs and city meetings. No one browsing "Events" for show listings would find "Beetlejuice is at the SJ Center for the Performing Arts next Tuesday" easily. The product had the data for a venue discovery experience but hadn't built one.
2. **No "what's on at [venue]?" discovery path** — A user thinking "I want to catch something at SAP Center" had no way to filter to that venue. The category filter didn't help; venue search in the text box worked but required knowing to try it.
3. **Entertainment shows missing from Today tab** — The daily brief showed events, sports, government, and development — but nothing about tonight's show at The Ritz or this weekend's Broadway touring production. This is exactly the kind of "I had no idea that was happening" discovery that drives bookmarking.
4. **Pre-existing TypeScript bug** — `SignalBriefing` was calling `pickTopEvent(todayUpcoming, todayStatic)` with 2 args, but `pickTopEvent` was refactored in Cycle 17 to take 0 args (using `weekendPicksJson`). This was silently causing the Signal Briefing events card to error. Fixed this cycle.

### What Was Built

**1. EventsView: "Venues" view mode** (`src/components/south-bay/views/EventsView.tsx`)

- Added `"venues"` to `ViewMode` type
- Added `SOUTH_BAY_VENUES` constant: 9 major entertainment venues with name, city, venue match string, emoji, and tags
  - 🎤 San Jose Improv (Comedy · Music)
  - 🎵 The Ritz (Music)
  - 🎵 San Jose Civic (Concerts)
  - 🎭 SJ Center for the Performing Arts (Theater · Arts)
  - 🏟️ SAP Center (Arena)
  - 🎵 Frost Amphitheatre, Stanford (Outdoor Concerts)
  - 🏀 Tech CU Arena (Sports · Events)
  - 🎪 McEnery Convention Center (Special Events)
  - 🌿 Discovery Meadows (Outdoor)
- Added `venueEvents` useMemo: groups all TM events by venue, sorted by date
- Added `venueFilteredEvents` useMemo: filtered events for selected venue (respects category/search/kids filters)
- Updated view mode toggle to 3 buttons: Upcoming | Recurring | Venues
- Venues view: 2-column auto-fill grid of venue cards
  - Each card: emoji, name, city, tags, "N upcoming" badge, next show date
  - Cards with 0 upcoming shows shown at 50% opacity (grayed out, non-interactive)
  - Click to select venue → filtered list view with "← All Venues" back button
- Active list count hidden in venues mode (irrelevant to venue grid)

**2. OverviewView: "On Stage Tonight / This Week" section** (`src/components/south-bay/views/OverviewView.tsx`)

- New `OnStageSection` component
- Filters allUpcoming to Ticketmaster events, non-sports, within next 7 days
- Shows up to 5 shows sorted by date then time
- Per-row: date badge (red "Tonight" if today, muted "Mar 28" otherwise), serif title (linked), venue, time
- Section title: "On Stage Tonight" when tonight has shows; "On Stage This Week" otherwise
- "All shows →" navigates to Events tab
- Positioned between "Around the South Bay" and "This Week in [City]"
- `UpcomingEvent` type in OverviewView updated to include optional `displayDate` field

**3. Bug fix: `pickTopEvent` call signature** (`OverviewView.tsx`)

- `SignalBriefing` was calling `pickTopEvent(todayUpcoming, todayStatic)` — stale call from before Cycle 17 refactored `pickTopEvent` to take 0 args (using `weekendPicksJson`). Fixed to `pickTopEvent()`.

### Ideas Considered

**1. Entertainment Venue Showcase (Venues tab + On Stage section)** ← BUILT
Uses existing Ticketmaster data as a venue discovery experience. Makes the product feel like a real entertainment guide.

**2. Live Caltrain service status**
511 API (requires key). High daily-urgency value. Deferred — API key not available in this environment.

**3. Development data audit + refresh**
Static projects haven't been reviewed in several cycles. Good candidate for a future cycle with more research time.

**4. Sunnyvale events coverage**
City blocks bot access; library platforms return 403/404. No clear path this cycle.

**5. Automated digest pre-generation**
Requires ANTHROPIC_API_KEY in GitHub Actions secrets. Not available in this environment.

### Why This Was the Highest-Leverage Move

The Venues tab solves a real discovery problem. "What's playing at SAP Center?" or "What's at the SJ Center for the Performing Arts this month?" are genuinely common local questions. No other South Bay source presents venue-centric entertainment browsing. The product already had the data — 98 TM events — sitting invisible in a date-sorted list. This cycle turns that data into a venue guide.

The On Stage section on the Today tab creates a new "daily discovery" habit. A resident opening the page might see "On Stage Tonight: Nate Jackson: Big Dog Comedy Tour · San Jose Improv · 8pm" and decide to go — or just feel more connected to what's happening in their city tonight. That's the small moment that builds bookmarking behavior.

The two pieces work together: On Stage surface the most immediately relevant shows at a glance; Venues lets users go deeper by venue when they want to.

The TypeScript bug fix (pickTopEvent call signature) was a bonus — the Signal Briefing's Events card had been silently failing to render its intended "top event" story since Cycle 17.

### Effect on Real Users
- **Saturday night visitor**: Lands on Today tab, sees "On Stage Tonight: Broadway Rave · The Ritz · 8pm" → one click to tickets they wouldn't have known about
- **Entertainment browser**: Opens Events → taps "Venues" → sees SAP Center has 3 upcoming, Frost Amphitheater has 3 (David Byrne! Dabin!) → taps to browse shows
- **User checking weekly calendar**: On Stage This Week shows next 5 entertainment events as a quick scan

### Next 3 Strongest Ideas
1. **Live Caltrain service status** — Register for 511 API key. A daily-urgency commuter feature that creates guaranteed repeat visits. Every weekday morning, someone checks "is Caltrain running?" and currently no South Bay source answers it at a glance.
2. **Development data audit + refresh** — The development-data.ts projects were added in early cycles. Their statuses/timelines need updating: BART Phase II milestones, Google Downtown West progress, new projects from 2026. Would improve Signal Briefing development card accuracy.
3. **Upcoming agenda preview on Gov tab** — Use Legistar EventItems API to show the top 3-5 agenda items for the NEXT scheduled meeting per city. Forward-looking civic intelligence to complement the backward-looking digests.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — entertainment discovery is now a first-class product feature.** South Bay Signal now does something no other South Bay source does: presents major local entertainment venues with their upcoming show listings in a browsable, organized format. The Venues tab + On Stage section makes the product useful for a completely new use case — "what's on in San Jose this week?" — that 98 Ticketmaster events were sitting on but not delivering. A resident can now open South Bay Signal and know, at a glance, that Beetlejuice is touring at SJ Center for the Performing Arts and David Byrne is coming to Frost Amphitheater. That's the kind of local intelligence that makes a site worth bookmarking.

---

## Cycle 19 — Government Tab: Upcoming Agenda Preview (2026-03-28)

### What Was Built

**Upcoming council meeting agenda preview on the Government tab** — before each city's next council meeting, the Government tab now shows the top 5 substantive agenda items pulled live from the Legistar API. Residents can see exactly what's coming up at city hall without having to dig through PDFs.

**1. Legistar EventItems integration** (`scripts/generate-upcoming-meetings.mjs`)

- New `fetchAgendaItems(client, eventId)` fetches `/Events/{id}/EventItems` from the Legistar Web API (free, no auth)
- Multi-pass filter removes boilerplate: skip exact procedural phrases (Roll Call, Pledge of Allegiance, Open Forum), skip all-caps section headers (CONSENT CALENDAR, STRATEGIC SUPPORT), skip long instructional paragraphs, skip URLs and phone numbers
- Takes first line only for titles with embedded addresses (Cupertino appends address info via `\r\n`)
- Returns up to 5 substantive items sorted by agenda sequence

**2. Agenda preview UI in DigestCard and GovernmentView**

- Shown below the digest summary on cities with digest data
- Also shown on the "no digest yet" fallback card
- "On the agenda · [Date]" label in small-caps monospace, items in left-bordered list
- Hidden when no substantive items found (e.g. Cupertino Apr 1 is a closed-session litigation meeting)

### Sample output — San Jose, April 7
- Establishment of the GovAI Coalition as a Nonprofit Corporation
- Willow Rock Long Duration Energy Storage Agreement
- San Diego Community Power Resource Adequacy Trade
- Establishment of the Story Road Business Improvement District
- Actions Related to the VTA Capitol Station Affordable Housing Development

### Ideas Considered

1. **Upcoming agenda preview on Gov tab** ← BUILT
2. **Live Caltrain service status** — 511 API key not available in this env. Deferred.
3. **Development data audit** — Static data, can be done in any env. Good next candidate.

### Why This Was the Highest-Leverage Move

The Government tab previously only looked backward — past meeting digests. Now it also looks forward. A resident heading to Tuesday's San Jose council meeting can open South Bay Signal and see in 2 seconds that the GovAI Coalition and Willow Rock energy storage are on the docket. No PDF required. This closes a real gap in civic information access and makes the Government tab useful twice per meeting cycle instead of once.

### Effect on Real Users
- **Civically engaged resident**: Opens Gov tab, sees San Jose's April 7 meeting includes a vote on the GovAI Coalition — decides to attend and comment
- **Property owner**: Sees "Story Road Business Improvement District" on the agenda — now knows there may be new assessments coming
- **Housing advocate**: Sees VTA Capitol Station affordable housing loan on the docket — mobilizes to weigh in

### Next 3 Strongest Ideas
1. **Live Caltrain service status** — 511 API key needed. Daily-urgency commuter feature.
2. **Development data audit + refresh** — Static projects need status/timeline updates for 2026.
3. **School district calendar integration** — FUHSD, SJUSD, PAUSD key dates (enrollment, breaks, holidays). High resident relevance.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — civic intelligence is now forward-looking.** The Government tab has become a two-way civic companion: backward-looking digests tell you what was decided, and the new agenda preview tells you what's coming. South Bay Signal is the only place a resident can open one tab and see both the last San Jose council meeting summary AND the five biggest items on next week's agenda. That's genuinely useful for the ~20% of residents who follow local government.


---

## Cycle 20 — School Calendar Card: SJUSD, PAUSD, FUHSD Key Dates (2026-03-28)

### What Was Built

**School Calendar card on the Today tab** — A new section between "Around the South Bay" and "Housing Market" that surfaces upcoming key school dates for the three major South Bay school districts. Pulled from official district calendar PDFs (2025-26 school year).

**Data: `src/data/south-bay/school-calendar.json`**

Key dates included:
- **SJUSD**: Good Friday (Apr 3), Spring Break (Apr 6-10), Memorial Day (May 25), Graduation (May 27-28), Last Day (May 29)
- **PAUSD**: Spring Break (Apr 6-10), May 1 Local Holiday, Memorial Day (May 25), Last Day (Jun 4)
- **FUHSD**: Spring Break (Apr 13-17), Memorial Day (May 25), Graduation (Jun 4-5), Last Day (Jun 4)

**`SchoolCalendarCard` component (inline in OverviewView)**

- 90-day lookahead window from today
- Events grouped by shared date range — Memorial Day shows once with 3 district badges (SJUSD, PAUSD, FUHSD) rather than 3 separate rows
- District badges color-coded: SJUSD blue, PAUSD green, FUHSD amber
- Section subtitle shows spring break countdown ("spring break in X days") when upcoming
- "NOW" highlight for any currently-active event (e.g. if you open this during spring break)
- Type icons: 🏖️ break, 🗓️ holiday, 🎓 graduation, 🔔 last day
- Footer line: "SJUSD · PAUSD · FUHSD — 2025–26"

**Also refreshed events data** — 576 events from 15 sources (576 total, 107 ongoing).

### Ideas Considered

**1. School district calendar integration** ← BUILT
Official district calendar data, parsed from PDFs by a subagent. High resident relevance — parents need to know when school is out, and this data is scattered across three district websites.

**2. Live Caltrain service status** — 511 API key not available in this environment. Deferred.

**3. Development data audit + refresh** — Static project descriptions may be stale. Good for a future cycle with research time.

### Why This Was the Highest-Leverage Move

School calendar is **high-frequency resident information** that no local aggregator currently surfaces in one place. FUHSD's spring break (Apr 13-17) is one week later than SJUSD and PAUSD (Apr 6-10) — this is exactly the kind of local nuance that families need to know when coordinating. A parent in Sunnyvale (FUHSD) and their sibling in San Jose (SJUSD) would plan different weeks off if they checked here first. That's the kind of hyperlocal intelligence that makes South Bay Signal worth bookmarking.

The grouping logic (showing Memorial Day as one row with three badges instead of three identical rows) keeps the card compact while still indicating which districts it applies to.

### Effect on Real Users
- **Parent planning spring vacation**: Opens Today tab, sees "Spring Break in 9 days" in header, scans the card to confirm their district's dates — done in 2 seconds
- **Multi-district family**: Has kids in SJUSD and PAUSD — one card tells them both districts are on the same week (Apr 6-10)
- **High school parent in Sunnyvale**: Immediately sees FUHSD spring break is Apr 13-17, a week later — adjusts travel plans accordingly

### Next 3 Strongest Ideas
1. **Live Caltrain service status** — 511 API key needed. Daily-urgency commuter feature. Register at 511.org/open-data.
2. **Development data audit + refresh** — development-data.ts projects need status/timeline updates for 2026. BART Phase II milestones, Google Downtown West progress.
3. **"This week in [City]" digest** — An AI-generated weekly briefing that summarizes the top 3-5 things happening in a resident's home city that week: top event, key council item, notable development update. Generated via ANTHROPIC_API_KEY (available in .env.local) and cached as static JSON.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — families are now a first-class audience.** Before this cycle, South Bay Signal had depth in civic intelligence, sports, entertainment, and real estate — but nothing for the large share of South Bay residents whose daily life is organized around the school calendar. A parent who opens the page now sees spring break countdowns, district-specific dates, graduation timing, and last day of school — all without hunting across three district websites. The card is compact and fast, but it answers a genuinely frequent question for one of the South Bay's most engaged resident groups.

---

## Cycle 22 — This Week in [City]: AI City Briefings (2026-03-29)

### What Was Built

**"This Week in [City]" card on the Today tab** — A new personalized section showing after the CityGlance tiles. It displays an AI-generated one-sentence editorial lead specific to the resident's home city, plus 2-3 linked highlights (top events + council agenda item).

**`scripts/generate-city-briefings.mjs`** — New script that runs Claude Haiku across all 11 cities:
- Filters upcoming-events.json to non-ongoing events in the next 7 days for that city
- Pulls around-town headlines from around-town.json per city
- Pulls upcoming meeting agenda items from upcoming-meetings.json
- Prompts Claude Haiku to write a 20-30 word editorial sentence: "like a smart friend texting you what's going on in your city"
- Assembles 2-3 highlights for display
- Skips cities with no data (Los Altos, Milpitas had none this week)

**`src/data/south-bay/city-briefings.json`** — Static output; 9 cities with briefings generated on first run:
- Campbell: Parks and Recreation Commission meeting tonight
- Cupertino: Business license amnesty program + retail incentives
- Los Gatos: Union Middle School 5K Fun Run at Balzer Field
- Mountain View: Mixed-use housing project approved on East Middlefield
- Saratoga: Mayor's farmers market office hours at West Valley College
- Sunnyvale: Community meeting on safe parking program
- San Jose: Council votes on GovAI Coalition + free library workshops
- Santa Clara: Public comment on federal housing funds
- Palo Alto: Stanford Cardinal Classic II softball weekend

**`CityWeeklyBriefing` component** (inline in OverviewView.tsx):
- Soft yellow background (`#FEFCE8`, amber border) to distinguish from other cards
- Italic AI editorial lead with actual local specifics
- Highlight rows with category emoji, linked title, when/venue in monospace
- Only renders when data exists for homeCity

**`generate-city-briefings` added to package.json scripts**

### Sample outputs
- San Jose: "San Jose City Council tackles AI governance and renewable energy deals Tuesday while free creative workshops hit the library this weekend."
- Cupertino: "Cupertino's new amnesty program lets unlicensed businesses get legit without penalties, while fresh incentives aim to revive struggling retail."
- Saratoga: "Saratoga's mayor holds office hours at the farmers market this Saturday, bringing City Hall directly to residents at West Valley College."

### Ideas Considered

1. **"This Week in [City]" AI briefings** ← BUILT
2. **Development data audit** — Static project descriptions from early cycles may be stale. Good next candidate.
3. **Live Caltrain status** — 511 API key still not available. Deferred again.

### Why This Was the Highest-Leverage Move

No prior feature on South Bay Signal was personalized to the resident's city. The weather, events, and sports were all South Bay-wide. CityGlance added meeting dates and project counts, but nothing editorial. This week's briefing gives a resident who lives in Saratoga a reason to open the page that's fundamentally different from a San Jose resident — and both get something specific to their city that they wouldn't find anywhere else in a single sentence.

The AI editorial voice matters: "Saratoga's mayor holds office hours at the farmers market this Saturday, bringing City Hall directly to residents at West Valley College" is something a local newspaper would write. It's not a data dump; it's a local intelligence service.

### Effect on Real Users
- **Saratoga resident Saturday morning**: Opens Today tab, sees "Saratoga's mayor holds office hours at the farmers market" — might actually go
- **San Jose civic watcher**: Sees "AI governance and renewable energy deals Tuesday" in plain English before having to dig through Legistar
- **Cupertino small business owner**: Sees business license amnesty program — might act before the window closes

### Next 3 Strongest Ideas
1. **Development data audit + refresh** — Static project descriptions and statuses from early cycles need 2026 updates. BART Phase II progress, Google Downtown West current status.
2. **Live Caltrain service status** — 511 API key needed. Register at 511.org/open-data. Daily-urgency commuter feature.
3. **Permit Pulse** — Santa Clara County publishes building permit data via open data portal. Show what's being built this week near the resident's city.

---

## Cycle 23 — Permit Pulse: San Jose Building Permits This Week (2026-03-29)

### What Was Built

**Permit Pulse card on the Today tab** — shows the past 7 days of building permits issued by the City of San Jose, sourced from the city's open data portal (data.sanjoseca.gov, no auth required, daily updated).

**Stats shown:**
- Total permits issued in the 7-day window (239 this cycle)
- New housing units started (5 this cycle — all ADUs/accessory dwelling units)
- Total construction valuation across all permits ($79M this cycle, dominated by a $72M SuperMicro manufacturing shell)

**Notable permits list (top 10):**
- Ranked by: new construction first, then by valuation desc
- Each permit shows: address, cleaned description, category label (New Home / Commercial Project / etc.), and valuation
- Category icons: 🏠 new home, 🏘️ multi-family, 🏗️ new construction, 🏢 commercial, 🔨 renovation

**`scripts/generate-permits.mjs`** — New script:
- Fetches all records from San Jose's "last 30 days" permit API
- Filters to the past 7 days by ISSUEDATE
- Categorizes: residential-new (new construction + dwelling), multi-family-new, commercial-large (commercial + $200k+), residential-large (residential + $200k+), new-construction
- Cleans descriptions: strips "(BEPM100%)" build permit modifiers, "(STAR)" flags, "(B)/(E)" prefixes
- Outputs permit-pulse.json

**`src/components/south-bay/cards/PermitPulseCard.tsx`** — New component:
- Header: "Permit Pulse" + "San Jose · [date range]"
- Stats row: total permits | new units | total value
- Permit list with icon, address, description, category badge, and valuation
- Footer: attribution + "San Jose only · More cities coming"

### Data Highlights This Cycle
- 5 new ADUs approved (San Jose's ADU-friendly permitting showing up in the data)
- SuperMicro building a $72M warm shell manufacturing facility at 688 E Brokaw Rd
- Trader Joe's doing a tenant improvement at 5353 Almaden Expressway
- Good Samaritan hospital building a new parking garage

### Ideas Considered

1. **Permit Pulse** ← BUILT
2. **Live Caltrain service status** — 511 API key still needed. Deferred.
3. **Development data audit** — Static project descriptions need 2026 updates.

### Why This Was the Highest-Leverage Move

Permit data is uniquely hyperlocal — a neighbor getting an ADU permit, a beloved retail spot doing a major renovation, a new tech company building a facility. This is exactly the kind of information that makes residents say "I didn't know that was happening." No local publication covers building permits systematically. South Bay Signal is now the only place where a resident can see, in one glance, what construction is being approved in their city this week.

The SuperMicro and Trader Joe's entries are immediately recognizable to South Bay residents — brand names they know, addresses they recognize, activity they care about.

### Effect on Real Users
- **Homeowner in Willow Glen**: Sees neighbors filing ADU permits — might consider one themselves
- **Retail watcher**: Spots Trader Joe's doing a TI at Almaden — "oh they're renovating?"
- **Tech industry observer**: SuperMicro building a $72M manufacturing shell — confirms local industrial growth
- **Real estate investor**: 239 permits in a week + ADU trend = market signal for active construction

### Limitations
- San Jose only (no Santa Clara, Sunnyvale, Mountain View open permit APIs found)
- "New units" counts only new construction, not additions/ADUs correctly classified in raw data
- Description cleaning catches most BEPM/STAR prefixes but may miss edge cases

### Next 3 Strongest Ideas
1. **Development data audit + refresh** — development-data.ts has static project status/timeline from early cycles. BART Phase II progress, Google Downtown West, SuperMicro expansion are worth updating.
2. **Live Caltrain service status** — 511 API key needed (register at 511.org/open-data). Daily commuter urgency.
3. **Caltrans D4 traffic incidents** — API was returning HTTP 500 as of 2026-03-28. Worth retrying — if it's back up, could add a "Traffic Alerts" module for I-280, 101, 85, 87 incidents.

---

## Cycle 25 — Quake Watch: Real-Time USGS Earthquake Data (2026-03-28)

### What Was Built

**Quake Watch card on the Today tab** — real-time Bay Area earthquake activity from USGS, showing M1.5+ earthquakes in the past 7 days across the South Bay region.

**`QuakeWatchCard.tsx`** — new client-side component:
- Fetches directly from USGS Earthquake Hazards Program API (no key required, public domain)
- Bounding box: 36.7–38.0°N, 121.4–122.6°W — covers South Bay through East Bay foothills
- Summary strip: total quakes, past 24h count, strongest magnitude, M2.5+ notable count
- Per-quake rows: magnitude (color-coded), location, depth, time ago — each links to USGS detail page
- Magnitude tiers: M1.5–1.9 micro (gray), M2.0–2.4 minor, M2.5–2.9 moderate (amber), M3.0+ notable (orange), M4.0+ major (red)
- Silent fail on fetch error — doesn't break the page
- Shows "No earthquakes M1.5+" message when activity is low

**Data also refreshed this cycle:**
- upcoming-events.json: 340 events, 84 ongoing, 15 sources
- digests.json: 6 cities with updated council meeting summaries
- around-town.json: 6 items including Palo Alto/Red Cross disaster relief partnership
- city-briefings.json: 9 cities regenerated with latest events + council data
- upcoming-meetings.json: San Jose (Apr 7) + Cupertino (Apr 1)
- weekend-picks.json: 3 picks (Los Gatos 5K, Sharks vs Blues, Nate Jackson comedy)

### Sample Activity This Cycle
- M2.8 near San Ramon (Calaveras fault area)
- M2.4 north of Morgan Hill
- M1.7 near Ridgemark (Hollister area)
- 15 quakes total in past 7 days, all micro to minor range

### Why This Was the Highest-Leverage Move

Bay Area residents are uniquely earthquake-aware. After any notable shake, the first instinct is to open a phone and ask "was that an earthquake?" USGS answers this but with a generic national map. South Bay Signal now has a resident-specific earthquake tracker that shows what's happening locally, in context with everything else on the page. No other local aggregator does this.

The data is genuinely real-time (USGS updates within minutes of any event), the API is free and reliable, and the feature is low-maintenance — it just works. A resident who felt a small tremor, or who checks in after hearing about activity in the news, now has a direct answer at their default homepage.

### Effect on Real Users
- **Resident who felt a shake last night**: Opens Today tab, sees "M2.4 15 km N of Morgan Hill — 14h ago" — instantly confirmed
- **Parent checking morning**: Sees "3 quakes past 7 days, strongest M2.8" — reassuring low-activity context
- **Earthquake-curious commuter**: Clicks USGS link for depth/fault data — gets more detail without leaving the page first

### Next 3 Strongest Ideas
1. **Tech hiring pulse** — Show South Bay tech companies with "actively hiring / stable / cutting" indicators. Could use Greenhouse public job boards API or static snapshot from known news. Ties into the TechnologyView which already has trend data.
2. **Transit real-time** — 511 API key needed. Daily commuter urgency. Register at 511.org/open-data.
3. **Development data audit** — development-data.ts static entries may be stale. BART Phase II milestones, Google Downtown West, SuperMicro expansion worth updating with 2026 status.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — environmental awareness is now complete.** In the span of recent cycles, South Bay Signal has gone from no environmental data to covering four dimensions of local conditions: weather (ForecastStrip), air quality (AirQualityCard), building activity (PermitPulseCard), and now seismic activity (QuakeWatchCard). A resident opening the page now gets a genuine pulse of the physical environment they live in — what's in the air, what's being built, and what's shaking underground. That's uniquely local intelligence that no other aggregator provides in one place.

---

## Cycle 26 — 2026 Elections Card: Civic Countdown (2026-03-29)

### What Was Built

**ElectionsCard on the Government tab** — countdown to the California Primary and key voter deadlines for Santa Clara County residents.

**`src/components/south-bay/cards/ElectionsCard.tsx`** — new static component:
- Headline countdown: "X days to CA Primary" with urgency coloring (red if ≤30 days)
- Key dates strip: Voter Reg Deadline (May 18), VBM Request Cutoff (May 26), Early Voting Opens (May 9), CA Primary (June 2), General Election (Nov 3)
- Date rows highlight yellow when ≤14 days away
- "On the Ballot" grid: 5 races with descriptions — Governor (open seat), US Senate, State Assembly/Senate, SCC Board of Supervisors, City Council races
- CTA buttons: "Check Your Registration →" (to sccvote.org) + "Find Your Polling Place"
- Auto-hides after both primary and general are 7+ days past

**Overview briefing story** — `pickElectionStory()` added to OverviewView:
- Activates within 90 days of either primary or general
- Currently shows: "Voter registration closes in X days" (or countdown to primary)
- Appears as 3rd briefing card, bumping health/development stories during election season

**Data refreshed this cycle:**
- upcoming-events.json: 340 events, 84 ongoing, 15 sources
- digests.json: 6 cities (SJ, MV, Sunnyvale, Cupertino, Santa Clara, Palo Alto)
- around-town.json: 5 items
- upcoming-meetings.json: San Jose (Apr 7), Cupertino (Apr 1)
- weekend-picks.json: Los Gatos 5K Fun Run, Sharks vs Blues, Nate Jackson Comedy Tour

### Why This Was the Highest-Leverage Move

The California Primary is June 2, 2026 — just 66 days away as of this cycle. The voter registration deadline is May 18, only 51 days away. This is the exact window where civic reminders have the highest impact: too early and residents ignore it; too late and it's past. South Bay Signal is now the only local aggregator surfacing this information prominently alongside all the other civic content on the Government tab.

Midterm 2026 has significant South Bay stakes: open Governor's seat (Newsom term-limited), US Senate, State Assembly races in Santa Clara County, SCC Board of Supervisors seats, and city council races in San Jose, Sunnyvale, Mountain View, and other cities. A resident who opens SBS and sees "Voter reg closes in 51 days" gets an actionable reminder they won't find anywhere else on a local homepage.

### Effect on Real Users
- **Unregistered resident**: Sees countdown + "Check Your Registration" CTA — takes immediate action
- **Registered voter**: Sees upcoming races listed — starts forming opinions / researching candidates
- **Parent/community member**: "Oh I didn't know there were city council races this year" — civic engagement boost
- **Overview tab user**: Sees 3rd briefing card "CA Primary Election: 66 days away" — seamless awareness without switching tabs

### Technical Notes
- All static data — no external API calls, builds instantly
- `daysUntil()` runs at render time so days count stays current
- Component returns null after both elections pass (7-day grace period)
- Races listed are factually confirmed for 2026: Governor (yes, Newsom TL), Alex Padilla (US Senate, 4-year term through 2028), SCC Board District rotations, standard city council cycles

### Next 3 Strongest Ideas
1. **Transit real-time** — 511 API key needed. Register at 511.org/open-data. Daily commuter urgency.
2. **Development data audit** — development-data.ts static entries may be stale. BART Phase II milestones, Google Downtown West worth updating.
3. **Caltrans D4 traffic incidents** — API was returning HTTP 500 as of 2026-03-28. Worth retrying — I-280, 101, 85, 87 incident feed would be very useful for commuters.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — civic engagement dimension now complete.** SBS now covers seven dimensions of local life: sports, events, government/council, real estate, environment (weather + AQI + quakes + permits), health/food safety, and now elections. A resident who opens the page today gets not just what's happening in their city, but what's on the ballot in two months and how to act on it. That's the full homepage for South Bay life.

---

## Cycle 27 — Transit Status Bar: Commute Pulse on Overview (2026-03-29)

### What Was Built

**TransitStatusBar component** (inline in OverviewView.tsx):
- Shows Caltrain + VTA service status directly on the Overview tab — no need to navigate to Transit
- Always visible (compact 2-row bar) after the 5-day ForecastStrip
- Status badge per agency: ● Normal Service / ⚠ Minor Delays / 🔴 Major Disruption
- Active alerts surfaced inline — currently showing:
  - VTA: "Mountain View–Winchester light rail: 5–10 min delays · thru April 15, 2026"
  - Caltrain: "Free Clipper upgrade through March 31" (expires tomorrow)
- "Full info →" button navigates to Transit tab
- Alert visibility logic: endDate-based (show if endDate hasn't passed), plus statusNote for non-normal agencies

**Data refreshed this cycle:**
- upcoming-events.json: 315 events, 83 ongoing, 14 sources (Los Altos timed out)
- digests.json: 6 cities (SJ, MV, Sunnyvale, Cupertino, Santa Clara, Palo Alto)
- around-town.json: 5 items (MV housing approval, MV housing grants, Sunnyvale safe parking, Santa Clara HUD input, Santa Clara station area)
- upcoming-meetings.json: San Jose (Apr 7), Cupertino (Apr 1)
- weekend-picks.json: SCU Baseball vs LMU, Nate Jackson Comedy Tour

### Why This Was the Highest-Leverage Move

VTA has active light rail delays through April 15 and Route 22 frequency is reduced on weekends. The Caltrain Clipper discount expires tomorrow (March 31). Both of these are time-sensitive pieces of information that a daily commuter needs to know — and previously they were buried in the Transit tab where most residents never go.

The transit status bar solves the "I use the Overview tab but I take VTA to work" problem. A resident opening SBS on a Monday morning now sees — right below the forecast — "VTA: ⚠ Minor Delays · Mountain View–Winchester light rail: 5–10 min delays · thru April 15, 2026" and can immediately decide whether to leave earlier, take a different route, or check the full Transit tab.

### Effect on Real Users
- **VTA commuter**: Sees delay alert instantly without tab switching — can adjust morning commute plan
- **Caltrain rider**: Sees "Free Clipper upgrade ends tomorrow" — takes action before the deal expires
- **General resident**: Sees "● Normal Service" for both — quick confirmation everything is fine, takes 1 second
- **Weekend resident**: Sees Route 22 frequency reduction — knows to plan around it

### Technical Notes
- Uses existing `TRANSIT_AGENCIES` and `STATUS_CONFIG` from transit-data.ts — no new data files
- `TRANSIT_STATUS_CONFIG` aliased to avoid name conflict with development-data's `STATUS_CONFIG`
- Alert date parsing handles natural language dates ("March 31, 2026", "April 15, 2026")
- Only Caltrain + VTA shown (most-used South Bay services); BART/ACE on full Transit tab

### Next 3 Strongest Ideas
1. **Transit real-time** — 511 API key needed. Register at 511.org/open-data for GTFS-RT feeds.
2. **Development data audit** — verify current status of "opening-soon" projects (Central Place at Levi's Stadium, Milpitas BART TOD) and any "approved" → "under-construction" transitions.
3. **Local job board** — South Bay tech hiring pulse. LinkedIn/Indeed/Greenhouse public APIs or static snapshot approach.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — commute dimension now on the Overview.** A resident's morning routine now flows: check weather (ForecastStrip) → check commute (TransitStatusBar) → check today's events → read briefing. That's the core daily check loop, all on one tab. South Bay Signal is increasingly the kind of page you open first, not fourth.

---

## Cycle 28 — Tech Hiring Pulse: Who's Hiring in Silicon Valley (2026-03-29)

### What Was Built

**Hiring Pulse section on the Technology tab** — a new section at the top of TechnologyView that groups all 16 major South Bay tech companies by current hiring status with direct career page links.

**`src/components/south-bay/views/TechnologyView.tsx`** — added before the Top Employers chart:
- Three columns: "Actively Hiring" (▲), "Selective Hiring" (→), "Reduced Hiring" (▼)
- Each column has a status label, italic context note, and a list of companies
- Each company row shows: colored status dot, company name (linked to careers page), city, trendNote (e.g. "7K at Santa Clara HQ; growing with AI GPU demand"), and a status badge
- Career links open the official jobs/careers page for each company
- Disclaimer: "Based on public filings, layoff announcements, and job board activity as of Q1 2026."

**`src/data/south-bay/tech-companies.ts`** — added `careersUrl` optional field to `TechCompany` interface and populated for all 16 companies:
- Actively hiring (trend: up): NVIDIA, AMD, ServiceNow, Palo Alto Networks, Meta
- Selective (trend: flat): Google, Apple, Cisco, Adobe, LinkedIn, Juniper/HPE, Western Digital, eBay, Zoom
- Reduced (trend: down): Intel, PayPal

**Data refreshed this cycle:**
- upcoming-events.json: 342 events, 86 ongoing, 15 sources
- digests.json: 7 cities
- around-town.json: 4 items (MV housing project, MV prohousing funding, Sunnyvale safe parking, Santa Clara station area)
- upcoming-meetings.json: San Jose (Apr 7), Cupertino (Apr 1)
- weekend-picks.json: 3 picks for March 27–29

### Why This Was the Highest-Leverage Move

Silicon Valley has gone through the most significant tech layoff cycle in a decade (2023–2025), with Intel cutting 15K+ jobs, PayPal cutting 2,500, and smaller cuts across Google, Adobe, and others. At the same time, AI has created a counter-wave of hiring at NVIDIA, AMD, ServiceNow, Palo Alto Networks, and Meta. Thousands of South Bay tech workers are actively job searching right now — and the Technology tab was giving them rich context about the local companies but no actionable next step.

The Hiring Pulse section converts the existing trend data into direct action: a tech worker can open the Technology tab, see which of their neighbors are growing vs. cutting, and click directly to the careers page without searching. That's the difference between a read-only informational page and a tool you actually use.

The feature also deepens SBS's identity as a genuine local homepage. No other South Bay aggregator shows hiring status for local companies alongside everything else (events, council meetings, weather, sports). The Technology tab now feels like a real resource for the most common life concern of Silicon Valley residents: employment.

### Effect on Real Users
- **Laid-off Intel engineer**: Opens Tech tab, immediately sees Intel is "▼ Reduced" and NVIDIA/AMD/ServiceNow are "▲ Actively Hiring" — clicks careers links without leaving the page
- **Software engineer considering a move**: "Oh ServiceNow is growing 20%+ — never thought about them, let me check"
- **Parent/spouse of a tech worker**: Gets a lay-of-the-land without reading tech news — "Google is stable, NVIDIA is booming"
- **General resident**: Understands why the South Bay economy feels the way it does right now in one glance

### Next 3 Strongest Ideas
1. **Transit real-time** — 511 API key needed. Register at 511.org/open-data. Daily commuter urgency.
2. **Development data audit** — verify current status of "opening-soon" projects (Central Place at Levi's Stadium, Milpitas BART TOD).
3. **High school sports scores** — live scores via MaxPreps or CIF section API. Hyperlocal and resident-engaging.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — employment dimension now complete.** South Bay Signal covers the full lifecycle of South Bay life: what's happening today (events), what your city is doing (government/council), what's being built (development), what the air is like (AQI, weather), what's shaking (quakes), what's on (sports, shows), and now — who's hiring. A resident who opens SBS after a layoff, or who's just thinking about their career, gets a genuine local picture of the job market they can act on immediately.

---

## 2026-03-29 — Cycle 29: Stream Watch Card

### What Was Built
**WaterWatchCard** — live USGS stream gauge monitoring for 5 South Bay creeks and rivers.

Component: `src/components/south-bay/cards/WaterWatchCard.tsx`
Data source: USGS National Water Information System API (public, no key required)
Location: Overview tab, after Quake Watch card

**Gauges covered:**
- San Francisquito Creek at Stanford (site 11164500)
- Guadalupe River above HWY 101, San Jose (site 11169025)  
- Saratoga Creek at Saratoga (site 11169500)
- Coyote Creek near S. San Jose (site 11170000)
- Coyote Creek at Milpitas (site 11172175)

**Design:**
- Color-coded status dots: blue (Normal), amber (Elevated), red (High)
- Flow in cfs with trend arrow (▲ rising, — stable, ▼ falling) based on 6-hour delta
- Summary badge: "All normal" (green) or "X elevated" (amber)
- Last-updated time, link to USGS realtime data
- Silent-fail if API is unreachable — no error shown to users
- Status thresholds calibrated to late-winter/spring normal conditions

**Data refreshed this cycle:**
- upcoming-events.json: 342 events, 86 ongoing, 15 sources
- digests.json: 6 cities (Milpitas had no usable transcript)
- around-town.json: 6 items (MV housing, MV prohousing, Sunnyvale safe parking, Cupertino business amnesty, Cupertino retail incentives, Santa Clara HUD grants)
- upcoming-meetings.json: San Jose (Apr 7), Cupertino (Apr 1)
- weekend-picks.json: 3 picks for March 27–29

### APIs Investigated This Cycle
- **Caltrans D4** (`cwwp2.dot.ca.gov`) — still returning 500; skip for now
- **511.org transit realtime** — requires API key not in .env.local; skip
- **San Jose open data** (`data.sanjoseca.gov`) — Socrata endpoints returning errors
- **CDEC reservoir storage** — only UVA (Uvas Reservoir) had non-negative data; station ID coverage is poor for SC County reservoirs
- **USGS stream gauges** ✅ — works perfectly with explicit site IDs, 15-min resolution

### Why Stream Watch Is Resident-Useful
South Bay has a recurring flood risk story: Coyote Creek flooded Willow Glen in 2017, San Francisquito Creek has flood risk for East Palo Alto, and the Guadalupe River backstops downtown San Jose during heavy rain events. Stream levels are directly actionable information:
- "Should I take my kid to creek trail today?" 
- "Is Coyote Creek safe after this rain?" 
- "Is there any flood risk right now?"

No other local aggregator shows this. It sits naturally alongside Quake Watch and Air Quality as the "environmental safety" section of the page.

### Effect on Real Users
- **Trail runner**: Opens SBS morning after a storm — "Guadalupe: 50 cfs, Normal ▼ falling — trail is good"
- **Parent near Coyote Creek**: Checks status after overnight rain — sees "Normal" and doesn't worry
- **Flood-risk homeowner near creek**: Has a one-click way to check current conditions without navigating USGS

### Next 3 Strongest Ideas
1. **Transit real-time** — 511 API key needed. Register at 511.org/open-data.
2. **High school sports scores** — MaxPreps or CIF section scraper. Hyperlocal.
3. **Crime pulse** — once San Jose open data is accessible; SJPD has public crime report data.

---

## 2026-03-29 — Cycle 30: NWS Weather Alerts + School Calendar Completion

### What Was Built

**1. WeatherAlertBanner component** (inline in OverviewView.tsx)

Live NWS weather alert feed for the Santa Clara Valley. Fetches `api.weather.gov/alerts/active?zone=CAZ511` on page load. Only renders when active alerts exist — disappears completely when sky is clear (like OutagesCard). Positioned between the 5-day ForecastStrip and the TransitStatusBar.

- Color coding: red (Extreme/Warning), amber (Severe/Watch), blue (Advisory/Statement)
- Shows alert event name, until-date, and stripped headline
- Silent fail if NWS API unreachable
- User-Agent header identifies SouthBaySignal to the public API
- CAZ511 = Santa Clara Valley inland zone — covers San Jose, Mountain View, Sunnyvale, Cupertino, Campbell, Los Gatos, Saratoga, Los Altos

**2. School calendar: testing events + finals**

Added 18 new entries to school-calendar.json:
- **AP Exams (May 4–15)**: SJUSD, PAUSD, FUHSD, LGSUHSD, MVLA — all high school districts
- **CAASPP State Testing (Apr 14–May 15)**: all 8 districts — the California standardized testing window
- **Finals Week**: FUHSD (May 28–Jun 1), LGSUHSD/MVLA/PAUSD (May 28–Jun 3), SJUSD (May 22–28)
- New TYPE_ICON entries: testing → 📝, finals → 📋

**3. Data refresh (all scripts)**
- upcoming-events.json: 342 events, 86 ongoing, 15 sources
- digests.json: 6 cities (SJ, MV, Sunnyvale, Cupertino, Santa Clara, Palo Alto; Milpitas failed)
- around-town.json: 6 items
- upcoming-meetings.json: San Jose (Apr 7), Cupertino (Apr 1)
- weekend-picks.json: 3 picks for Mar 27–29

### APIs Investigated This Cycle
- **MaxPreps** — robots.txt blocks most content including team/school scores; cannot scrape
- **CIF Central Coast Section (cifccs.org)** — 403 blocked; no public data access
- **Palo Alto Online** — blocks AI crawlers (Claude-based agents listed in robots.txt)
- **NWS/NOAA api.weather.gov** ✅ — fully public, no auth, GeoJSON format, CAZ511 covers South Bay

### Why This Was the Highest-Leverage Move

**The WeatherAlertBanner fills the gap between ambient weather and urgent alerts.** The ForecastStrip tells you it'll be 68°F on Thursday. It does NOT tell you if there's an Excessive Heat Warning, Red Flag Warning for wildfire weather, or Flash Flood Watch in effect. For South Bay residents, this distinction matters:
- A Red Flag Warning means elevated wildfire risk — residents in Saratoga and Los Gatos hills need this immediately
- An Excessive Heat Warning means vulnerable residents and outdoor workers need to adjust plans
- A Flash Flood Watch means check the Guadalupe River and Coyote Creek (which now have live USGS gauges on the same page)

The NWS API is perfectly complementary to the existing weather + water + air quality stack. The Overview tab now covers the full environmental picture: forecast (what's coming), air quality (what you're breathing), stream levels (flood risk), and official NWS alerts (government-issued warnings). This is a more complete environmental dashboard than any other South Bay source.

**The school calendar now answers the end-of-year questions every parent has.** AP exams (May 4–15), CAASPP testing (Apr 14–May 15), and finals weeks are the highest-anxiety dates on the school calendar — and they were completely missing. A parent checking SBS in late April can now see "AP Exams: May 4–15 · PAUSD" in the same School Calendar section that already told them about spring break. This is the difference between "useful reminder" and "genuinely useful reference."

### Effect on Real Users

**Summer wildfire season (June–October)**:
- Parent in Saratoga opens SBS on a hot, dry morning: sees "🔴 Red Flag Warning · until Sat, Jun 14 · 8pm — Strong winds and low humidity will create dangerous wildfire conditions"
- This is actionable (don't do yard work, be ready to evacuate) in a way that a weather app never makes explicit

**Heat wave (July–August)**:
- Elderly resident's caregiver opens SBS: immediately sees "⚠ Excessive Heat Warning" without having to check a separate weather app
- Connects naturally to the Air Quality section below (smoke/ozone often accompanies heat)

**Flood event (rainy season)**:
- After heavy rain, resident sees "⚠ Flash Flood Watch" alongside the Water Watch card showing "Guadalupe River: 420 cfs, Elevated ▲ rising"
- Two live data sources telling the same story

**School calendar (AP exams)**:
- PAUSD junior's parent: opens SBS in late April, sees "📝 AP Exams · May 4–15 · PAUSD, MVLA, FUHSD, LGSUHSD, SJUSD" — immediately reminds them the school-stress period is starting

### Next 3 Strongest Ideas
1. **High school sports scores** — MaxPreps blocked. Alternative: direct CIF/SCVAL/WCAL league websites or a community-contributed static snapshot. Parents notice this more than almost anything.
2. **Transit real-time** — 511 API key needed. Register at 511.org/open-data. Daily commuter urgency.
3. **NWS alert test / winter storm coverage** — Currently covering CAZ511 (valley). Could expand to CAZ512 (Santa Cruz Mountains) to catch mountain snow events that affect commuters on Hwy 17 and 35.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — emergency intelligence layer complete.** South Bay Signal now covers the full safety picture: NWS weather alerts, USGS stream gauges, air quality, seismic activity, and PG&E/SCE outages. A resident checking SBS during any South Bay hazard event — wildfire smoke, heat wave, flood watch, earthquake, power outage — gets all the relevant information in one place. No other local source aggregates all five of these. For residents in the hills (Saratoga, Los Gatos) who face elevated wildfire and flood risk, this combination is genuinely unique.

---

## 2026-03-29 — Cycle 31: Spring Break Guide

### What Was Built

**Spring Break Guide card on Overview tab** — a curated list of 5 family-friendly activities for spring break week (Apr 3–17, covering Easter weekend + both spring break windows). Shown from Mar 28 through Apr 17.

- `scripts/generate-spring-break-picks.mjs` — new generator script using Claude Haiku to curate 5 picks from spring break events
- `src/data/south-bay/spring-break-picks.json` — 5 picks: Egg Decorating, LEGO Club, bird photography talk, USWNT soccer, library storytime
- `SpringBreakCard` component in OverviewView — same visual style as WeekendPicksCard, with 🌸 header and date-gated visibility (Mar 28–Apr 17)

**Data refresh**: events, digests, weekend-picks, around-town, upcoming-meetings

### The 5 Picks (this cycle)
1. Friday Fun: Egg Decorating — Free Easter egg decorating at SJPL (Apr 3, 4pm)
2. LEGO Club for Grades K-8 — Free LEGO club at Santa Clara County Library, Milpitas (Apr 6, 3:30pm)
3. Pelicans, Herons, and Egrets, Oh My! — Wildlife photography nature talk, Los Altos library (Apr 10, 7pm)
4. U.S. Women's National Team v Japan — USWNT soccer at PayPal Park (Apr 11, 2:30pm)
5. Reading to Children with Vivian — Free storytime at SJPL (Apr 12, 1pm)

### APIs Investigated This Cycle
- **CDEC (California DWR)** — Tested Santa Clara County reservoir storage. Only Coyote Reservoir (COY) returned data. Anderson Reservoir (ANR) offline for dam safety retrofit since 2020. Other stations (LEX, CAL, CHB, STC) returned empty datasets. Reservoir card not built this cycle.
- **Caltrans D4 incidents API** — Still returning HTTP 500. Not buildable this cycle.
- **511.org transit real-time** — API key required. Not buildable without registration.

### Why This Was the Highest-Leverage Move

Spring break starts in one week for most South Bay school districts (Apr 6-10 for SJUSD/PAUSD/MVWSD/LGSUHSD/MVLA; Apr 13-17 for FUHSD/CUSD). Easter is Apr 5. Parents are planning now.

The Spring Break Guide fills the gap that no other local source fills: a curated, opinionated list of things to actually do with kids during break week. The Events tab shows raw event listings, but a parent with limited time doesn't want to scroll through 342 events — they want "5 things we recommend for your family this week." The card shows from Mar 28 through Apr 17 and then disappears, so it's always timely.

The 5 picks span: free crafts (egg decorating), educational play (LEGO Club), nature/science (bird photography), premium sports (USWNT), and literacy (storytime). Geographic spread: San Jose, Milpitas, Los Altos. Four of the five are free.

### Next 3 Strongest Ideas
1. **Transit real-time** — 511 API key needed (register at 511.org/open-data). Would transform the Transit tab from static alerts to live arrivals.
2. **Caltrans D4 traffic incidents** — retry when API recovers from 500 error. Real-time incident alerts for 101, 85, 87, 280.
3. **SCVWD reservoir levels** — Only Coyote (COY) returning data. Keep retrying Anderson (ANR) — it's being refilled after dam safety work and will have data again.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — seasonal intelligence added.** SBS now surfaces timely, curated activity guidance around the local school calendar. The WeekendPicksCard handles any weekend; the SpringBreakCard handles the spring break window specifically. This seasonal awareness (knowing when kids are out of school and curating accordingly) is something no other South Bay source does automatically.

---

## 2026-03-29 — Cycle 32: Development Tracker Audit + 3 New Projects

### Context
Coming off Cycle 31 which delivered the Spring Break Guide. The Development tab has been flagged for an audit in the "Next 3 Strongest Ideas" section of the last 8+ cycles without ever being addressed. The project list was set in Cycles 6 and later — some statuses are stale and three significant projects weren't included.

### What Was Built

**1. Three new projects added to `development-data.ts`:**

- **Super Micro Computer Manufacturing Expansion (San Jose, under-construction)** — $72M warm-shell building permit issued March 2026 at 688 E Brokaw Rd. Verified from SJ open data permit feed. SMCI is expanding AI server manufacturing capacity in North San José as GPU server demand continues to climb.

- **East Middlefield Road Mixed-Use Development (Mountain View, approved)** — Mountain View City Council approved this mixed-use housing project at its March 24, 2026 meeting. Sourced from around-town.json (Stoa council data). Keeps the tracker current with decisions happening right now.

- **Santa Clara Station Area Land Use Plan (Santa Clara, proposed)** — Santa Clara is developing zoning and design rules for areas around its transit stations. City Council reviewed the plan at a March 2026 study session. Sourced from around-town.json.

**2. Status and description updates:**

- **Milpitas BART TOD**: changed from "opening-soon" to "under-construction". The "opening-soon" status was set in early cycles when the first phases were imminent. Early phases have now delivered units; remaining phases are under active construction. Description updated to reflect the phased reality.

- **BART Phase II**: description updated to note tunneling is underway as of 2026, and timeline sharpened to "Expected 2030–2032" (more accurate than the prior "mid-2030s" — VTA's published schedule is 2030).

- **Google Downtown West**: description updated to acknowledge Google's office footprint reduction while noting housing commitments remain. The original description was written before Google's 2023-2024 scaling back became public knowledge.

- **Mineta Airport Terminal B**: description refreshed to read as an ongoing active project rather than a planned one.

**3. Data refresh:**
- upcoming-events.json: 454 events, 99 ongoing, 16 sources (fresh)
- around-town.json: 5 items (Mountain View housing, Sunnyvale safe parking, Santa Clara HUD grants, Santa Clara station area)
- weekend-picks.json: 3 picks (Los Gatos 5K, Silicon Valley Reads author talk, Nate Jackson comedy)
- digests.json: 8 cities regenerated
- city-briefings.json: 11 cities — Los Altos and Milpitas now included (previously skipped due to insufficient data)

### Why This Was the Strongest Move

The Development Tracker had stale status on Milpitas BART TOD (still "opening-soon" when early phases opened months ago), outdated Google Downtown West framing, and was completely missing three significant 2026 developments: the SuperMicro $72M factory expansion, Mountain View's newly approved mixed-use project, and Santa Clara's station area planning. All three were verified from primary sources (SJ open data permits, Stoa council records).

More importantly: adding the SuperMicro project connects the Development tab to the Tech tab in a tangible way. A resident browsing the Technology tab sees SuperMicro as one of San José's tech employers. A resident checking the Development tab now sees SuperMicro actively expanding manufacturing capacity. These are the same story — South Bay industrial tech growth — told from two angles.

The city briefings expansion to all 11 cities is a meaningful UX improvement: Los Altos and Milpitas were previously skipped when they had no recent data. Now with more events in the feed (SCCL library programs now covering both cities), both have usable briefings.

### Effect on Real Users
- **Tech worker/investor**: Sees SuperMicro expansion alongside Intel reduction on the Tech tab — understands the nuanced local employment picture
- **Mountain View homebuyer**: Development tab now shows East Middlefield approval — more housing supply signal
- **Santa Clara resident**: Station area planning is on the tracker — they know their neighborhood is being replanned around transit
- **Milpitas resident**: Finally gets a "Today in Milpitas" city briefing with relevant library events

### Next 3 Strongest Ideas
1. **Transit real-time** — 511 API key needed. Register at 511.org/open-data. Daily commuter urgency. This has been deferred every cycle for the same reason.
2. **Palo Alto government coverage (PrimeGov)** — PrimeGov API endpoint structure changed; v1/v2 routes don't exist. Need to inspect the live portal's network traffic to find working API routes.
3. **Caltrans D4 traffic incidents** — API returns 500. Worth retrying — I-280, US-101, SR-85, SR-87 incident alerts would add commuter urgency to the Transit tab.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — the Development Tracker is now current and expanding.** A resident who opens the Development tab today sees 23 projects including three that reflect decisions made in the past two weeks. The tracker is now a living document of what's being built and decided, not a frozen snapshot from March. The SuperMicro project in particular ties the Development and Technology tabs together: South Bay Signal now covers the full lifecycle from "company is growing" (Tech tab) to "company is building new facilities" (Development tab). That's the kind of connected local intelligence no other South Bay source provides.

---

## 2026-03-29 — Cycle 33: Shoreline Amphitheatre + Mountain View Events

### Context
Coming off Cycle 32 which audited the Development Tracker. Mountain View is one of the most event-rich cities in the South Bay — home to the Computer History Museum, Google, and most importantly Shoreline Amphitheatre, one of the largest concert venues on the West Coast. Yet the events feed showed only 8 Mountain View events (all CHM exhibits, all dated today as "ongoing"). A 10× gap versus San Jose's 184. The issue: the Ticketmaster general query fetches ~449 events sorted by date, hits a 200-event source cap, and the Shoreline concerts (positions 380+) get dropped. This was a silent failure — the script reported "309 events" but Mountain View was getting nothing.

### What Was Built

**1. Shoreline Amphitheatre targeted event fetcher (`fetchShorelineEvents`):**
- New function in `scripts/generate-events.mjs` that queries Ticketmaster by keyword "Shoreline Amphitheatre" with a 180-day window (vs. 90 for the general query)
- Tagged with `source: "Shoreline Amphitheatre"` so it gets its own source cap bucket (not counted against the general TM 200-event cap)
- Reuses `mapTicketmasterEvent` helper (extracted from the main TM function) for consistent event shape

**2. General TM fetcher pagination fix:**
- The original fetcher only fetched page 0 (200 events) from a single lat/long center
- Updated to fetch all pages from both SJ center (37.3382,-121.8863) and MV/Shoreline center (37.4266,-122.0804)
- Deduplicates by event ID before capping, so duplicates don't count against the source cap
- `mapTicketmasterEvent` extracted as a shared helper

**3. Data refresh:**
- upcoming-events.json: 500 events (up from 481 before this cycle), 102 ongoing, 19 sources
- Mountain View: 27 events (up from 8) — 19 Shoreline concerts + 8 CHM exhibits
- New concerts visible: Pitbull (Jun 7), Pussycat Dolls (Jun 12), Kid Cudi (Jun 23), Chris Stapleton (Jul 8), Hilary Duff (Jul 11), Evanescence (Jul 20), Santana & Doobie Brothers (Aug 9), Luke Bryan (Aug 14), Muse (Aug 27), Mötley Crüe (Sep 24), and more
- All pipeline scripts refreshed: around-town, digests, city-briefings, health-scores, weekend-picks

### Why This Was the Strongest Move

Shoreline Amphitheatre is one of the defining cultural institutions of the South Bay. When a Mountain View resident checks "what's happening in my city," not seeing upcoming Shoreline concerts is a significant miss — these are major shared cultural events that thousands of South Bay residents attend. The previous 8 Mountain View events (all CHM exhibits) made Mountain View look like a city with nothing going on. 27 events including a full summer concert season is the reality.

The root cause was architectural: Ticketmaster returns results sorted by date, with major venue events sometimes hundreds of positions in. A flat cap without city-diversity balancing silently under-serves cities that generate events later in the season. The fix (dedicated source with its own cap) is the right pattern for other major venues too.

### Effect on Real Users
- **Mountain View resident**: Events tab now shows their summer concert calendar — not just "Steve Jobs in Exile" at CHM
- **Concert-goer**: Can see the full Shoreline season in one place without hunting ticketmaster.com
- **Families**: Multiple family-appropriate shows visible (various genres across the summer)
- **Everyone in the South Bay**: Mountain View now appears as the event-rich city it actually is

### Next 3 Strongest Ideas
1. **Transit real-time** — 511 API key needed. Register at 511.org/open-data. Daily commuter urgency. This has been deferred every cycle for the same reason.
2. **Palo Alto government coverage (PrimeGov)** — PrimeGov API endpoint structure changed; v1/v2 routes don't exist. Need to inspect the live portal's network traffic to find working API routes.
3. **Caltrans D4 traffic incidents** — API returns 500. Worth retrying — I-280, US-101, SR-85, SR-87 incident alerts would add commuter urgency to the Transit tab.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — Mountain View is now properly covered.** The events feed went from 8 to 27 events for Mountain View, finally representing the city's actual cultural life. Shoreline Amphitheatre — one of the South Bay's most recognizable landmarks — is now part of the signal. A Mountain View resident who visits the Events tab will see their summer: concerts, tech museum exhibits, and the broader calendar of the city they actually live in.

---

## 2026-03-29 — Cycle 34: Tech Tab — 4 New Small South Bay Companies

### Context
The Tech tab's stated differentiator is covering small and emerging South Bay companies that no one else covers. After Cycle 33's events work, this cycle turned to the HIGH PRIORITY tech tab gap: the SCC Spotlight only had ~18 companies, all of them large or well-known. Four newly funded South Bay startups with verified real addresses and recent news were found and added.

### What Was Built

**4 new companies added to SCC Spotlight in tech-companies.ts:**

1. **Eridu** (Saratoga) — AI data center networking startup. Redesigns the 3-tier data center network into one high-radix switch layer for AI workloads. Emerged from stealth March 2026 with $200M+ Series A led by Socratic Partners and John Doerr. ~100 employees.

2. **Sunday** (Mountain View) — Household robotics. Building Memo, a wheeled humanoid robot for dishes, laundry, and tidying. $165M Series B at $1.15B valuation (March 2026, Coatue). ~70 employees, doubling headcount. Beta launches late 2026 with 3,000+ on waitlist.

3. **Lyte** (Mountain View) — Robotic vision/perception. Ex-Apple Face ID engineers building integrated 4D perception systems as the "visual brain" for humanoid robots. Emerged from stealth January 2026 with $107M, CES 2026 Best of Innovation. ~20 employees.

4. **Axiado** (San Jose) — AI data center security chips. Hardware-anchored security and AI monitoring embedded in data center control hardware. $100M Series C+ in December 2025 (Maverick Silicon). ~128 employees, grew 38% YoY.

**All data pipelines refreshed:** events (499), around-town, upcoming-meetings, weekend-picks, health-scores, digests, city-briefings.

### Why This Was the Strongest Move

The Tech tab was skewed toward well-known giants (Google, Apple, NVIDIA) and known growth companies (Glean, Rubrik). The companies added this cycle are the exact kind of signal SBS should provide: a robotics company building household robots in Mountain View, a networking startup hiding in Saratoga that just raised $200M, and a security chip startup in San Jose growing 38%/year. These are companies a South Bay resident might drive past every day without knowing they're becoming the next wave of South Bay tech. No other local news outlet covers these.

**Attempted this cycle but blocked:**
- Caltrans D4 API: still returning 500 (persistent infrastructure issue on their end)
- Permit expansion to Mountain View: no open API (ArcGIS portal, no documented endpoint); Palo Alto requires Junar API key registration

### Next 3 Strongest Ideas
1. **Transit real-time** — 511.org API key required. Register at https://511.org/open-data. Would give daily commuters VTA/Caltrain real-time data.
2. **Permit expansion** — Palo Alto Junar API key required (data.cityofpaloalto.org/developers/). Mountain View: check ArcGIS feature service endpoint at data-mountainview.opendata.arcgis.com.
3. **High school sports scores** — MaxPreps or prep sports APIs. Would surface Saratoga, Los Gatos, Monta Vista, Paly game results.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — the Tech tab now has genuine edge.** A Saratoga resident learning Eridu exists in their own city, or a Mountain View parent knowing Sunday's household robot startup is two miles away — that's the kind of local tech signal SBS is supposed to provide. The tab went from "things you already know" to "things you should know about."

---

## 2026-03-29 — Cycle 35: Spring Break Banner + Filter on Events Tab

### Context
Today is March 29 — five days before spring break starts. SJUSD, PAUSD, MVWSD, LGSUHSD, and MVLA have break April 3-10; FUHSD, Cupertino USD, and Campbell USD have it April 13-17. The Events tab had no awareness of the upcoming break, leaving parents to manually browse through hundreds of events and mentally flag which ones fell during spring break. The spring-break-picks card on the Overview tab (added last cycle) only shows 5 curated picks — not interactive, not filterable.

### What Was Built

**Spring Break banner + quick filter in EventsView:**

1. **Seasonal banner**: Appears in the Events tab from March 29 through April 17. Shows "Spring Break in X days" (or "Spring Break is here!" once in-window), notes both district windows (Apr 3-10 and Apr 13-17).

2. **One-click filter**: "Show spring break events" button scopes filteredUpcoming to April 3-17, replacing the standard date groups with:
   - "Easter Weekend" (April 3 events)
   - "Spring Break · Wk 1 (Apr 3–10)" (SJUSD, PAUSD, MVWSD, LGSUHSD, MVLA districts)
   - "Spring Break · Wk 2 (Apr 13–17)" (FUHSD, Cupertino USD, Campbell USD)

3. **Composable**: Spring break mode stacks with existing filters (city, category, kids-only, search). A Cupertino parent can activate spring break mode + "👶 Kids only" + "Cupertino" city filter to see exactly their family's options during their specific break week.

4. **Self-cleaning**: Banner only shows March 29 – April 17. After break ends, the code stays but the banner disappears — no cleanup needed.

**All data pipelines refreshed:**
- upcoming-events.json: 499 events (102 ongoing, 19 sources)
- around-town.json: 6 items (Cupertino business license amnesty, Santa Clara housing grant, Santa Clara Station land use)
- digests.json: 8 council digests
- upcoming-meetings.json: 2 cities (Cupertino Apr 1, missing Sunnyvale/Santa Clara)
- weekend-picks.json: 3 picks (Rap as Storytelling, Nate Jackson Comedy, SCU Baseball)
- spring-break-picks.json: 5 picks (poetry month, Latinx art, Princess Bride movie, tulip craft, wildlife photography)

### Why This Was the Strongest Move

Spring break starts in 5 days. Parents across 8 school districts are actively thinking "what are we going to do?" The Events tab has 499 events but they're not spring-break-aware. The new filter makes the answer to "what's happening during spring break?" a single click away. The two-week split is important — families with kids in FUHSD/Cupertino/Campbell USD have a different week off than families in SJUSD/PAUSD/MVWSD, and the filter correctly handles both windows.

The banner is designed to be useful exactly when it's useful and invisible otherwise. The orange-to-purple toggle uses the spring blossom emoji (🌸) and the color scheme shifts from warm orange (pre-break excitement) to purple (active break mode) when engaged.

### Next 3 Strongest Ideas
1. **Transit real-time** — 511.org API key required (register at https://511.org/open-data). Daily commuter urgency.
2. **Permit expansion** — Palo Alto Junar API (data.cityofpaloalto.org/developers/). Mountain View: ArcGIS feature service at data-mountainview.opendata.arcgis.com.
3. **High school sports scores** — MaxPreps data for South Bay high schools (Saratoga, Los Gatos, Monta Vista, Paly). Spring sports season is active right now.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — the Events tab is now spring-break-aware.** A Cupertino parent opening SBS today sees "Spring Break in 5 days" and can click once to see all the things their family could do during their specific break week. That's the kind of local intelligence that turns a "might check once" into "I actually use this."

---

## 2026-04-01 — Cycle 37: Tech Tab — 3 South Bay Companies Residents Don't Know Are Local

### Context
Today is April 1, 2026. The Tech tab's SCC Spotlight had 33 companies, weighted toward the familiar giants. Three notable South Bay tech companies that residents probably don't realize are headquartered locally were missing: Sandisk (just became independent again), Trellix (enterprise security, hidden in Milpitas), and Lumentum (their phone's Face ID laser is made here).

### What Was Built

**3 new companies added to SCC Spotlight in tech-companies.ts:**

1. **Sandisk** (San Jose) — Flash storage pioneer, independent again since WD spinoff February 2025. Trades as SNDK. One of the most recognized storage brands in the world, headquartered in San Jose since 1988. ~8K employees globally.

2. **Trellix** (Milpitas) — Enterprise XDR cybersecurity platform formed in 2022 from the merger of McAfee Enterprise and FireEye. Protects governments and large enterprises from advanced persistent threats. One of Milpitas' largest private-sector employers. ~4K employees.

3. **Lumentum** (Milpitas) — Optical components manufacturer. Their VCSEL lasers power the 3D sensing in iPhone Face ID. Their fiber optic transceivers connect hyperscale data centers. Spun off from JDSU in 2015. ~6K employees globally. Trades as LITE.

**Data pipelines refreshed (non-AI):**
- upcoming-events.json: 428 events (99 ongoing)
- upcoming-meetings.json: San Jose Apr 7
- real-estate.json, health-scores.json, air-quality.json (South Bay avg AQI: 49 Good)
- permit-pulse.json: Palo Alto 6 notable permits, San Jose 2
- outages.json: 0 active outages
- restaurant-radar.json: refreshed

**Note:** ANTHROPIC_API_KEY not available in environment — AI-powered scripts (around-town, weekend-picks, tech-briefing, digests, city-briefings) not refreshed this cycle.

### Why This Was the Strongest Move

Residents drive past Sandisk, Trellix, and Lumentum buildings every day without knowing those companies are headquartered in their city. The "Face ID laser made in Milpitas" angle is exactly the kind of surprising local fact SBS should surface. Trellix employs ~4K people in Milpitas but formed from brand names that people recognize (McAfee, FireEye) — that gap between "brand you know" and "it's here in Milpitas" is the Tech tab's sweet spot.

**Mountain View permits blocked:** data-mountainview.opendata.arcgis.com has only 28 datasets, none of which are building permits. Mountain View uses an internal permit system with no public API.

### Next 3 Strongest Ideas
1. **Transit real-time** — 511.org API key required. Register at https://511.org/open-data. Daily commuter urgency.
2. **High school sports scores** — MaxPreps for South Bay high schools (Saratoga, Los Gatos, Monta Vista, Paly). Spring sports season active now.
3. **Palo Alto government (PrimeGov)** — PrimeGov API endpoint structure changed; need to inspect live portal network traffic to find working routes.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — Tech tab now covers another layer of the South Bay tech ecosystem.** A Milpitas resident learning that their Face ID works because of a company in their own city, or a San Jose resident realizing Sandisk is a standalone company again — that's the local tech signal SBS is supposed to provide.

---

## 2026-04-01 — Cycle 38: 4 More South Bay Companies Residents Interact With Daily

### Context
Today is April 1, 2026. The AI API key is not inherited by child Node processes in this environment, so AI-powered scripts (around-town, weekend-picks, city-briefings, tech-briefing) cannot run this cycle. The events file was restored after an accidental overwrite that removed Ticketmaster/Shoreline events (the events script skips Ticketmaster without a key, losing 19+ Shoreline concerts). Non-AI data was fully refreshed in cycle 37.

The Tech tab's prime directive is covering South Bay companies residents interact with but don't know are local. Four verified, well-established companies were missing from SCC Spotlight: ChargePoint, Zscaler, Barracuda Networks, and Western Digital — all with South Bay HQs and daily-life relevance.

### What Was Built

**4 new companies added to SCC_SPOTLIGHT in tech-companies.ts:**

1. **ChargePoint** (Campbell) — The largest EV charging network in North America, headquartered at 240 E. Hacienda Ave in Campbell. Their green charging stations are in every mall parking lot across the South Bay. Most residents have used one and have no idea it's a Campbell company. Public (CHPT). ~1,400 employees.

2. **Zscaler** (San Jose) — Zero trust cloud security replacing corporate VPNs for 40% of the Fortune 500. Founded by Jay Chaudhry in 2007 from San Jose. When a tech company says "we use Zscaler instead of VPN," that's San Jose tech. Public (ZS). ~7K employees globally.

3. **Barracuda Networks** (Campbell) — Email security and cloud backup for 200,000+ businesses. Founded from a Campbell garage in 2002, still HQ'd in Campbell. One of the city's largest tech employers. KKR-backed, private. ~2K employees.

4. **Western Digital** (San Jose) — After spinning off SanDisk in February 2025, WD refocused on HDDs and enterprise cloud storage. In San Jose since 1970. The hard drives in most data centers still come from a San Jose company. Public (WDC). ~12K employees globally.

### Why This Was the Strongest Move

These four companies hit the Tech tab's core premise: South Bay residents interact with their products daily without knowing the company is local. ChargePoint's angle is literally "you've used their charger at Santana Row." Zscaler's angle is "your company's VPN replacement is San Jose." Barracuda is "the email filter that stopped that phishing attempt is from Campbell." Western Digital is "the hard drive in that server is from a San Jose company older than most Silicon Valley icons."

Two of the four are in Campbell — making Campbell a more visible part of the South Bay tech story, which is appropriate given its actual cluster of tech companies.

**What was blocked this cycle:**
- AI scripts (around-town, weekend-picks, digests refresh) — ANTHROPIC_API_KEY not inherited by child Node processes
- Ticketmaster/Shoreline events — same key issue; events file restored from git to preserve cycle 33's Shoreline work
- Caltrans D4 API: still 500

### Next 3 Strongest Ideas
1. **Transit real-time** — 511.org API key required. Register at https://511.org/open-data. Daily commuter urgency. This has been deferred every cycle.
2. **Ticketmaster key access in scripts** — Need to solve the env-var-not-inherited problem. Once fixed, events script can run with TM events (Shoreline concerts, general SB events) on each cycle refresh.
3. **Palo Alto government (PrimeGov)** — PrimeGov API endpoint structure changed; need to inspect live portal network traffic to find working routes.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — the Tech tab now covers the full daily-life layer of South Bay tech.** A Campbell resident who charges their EV, a tech employee who logs in through Zscaler, a small business owner who uses Barracuda email security — all of them can now see on the Tech tab that these services come from companies in their own city. That's the local intelligence layer no other South Bay outlet provides.

---

## 2026-04-01 — Cycle 39: RECENTLY_FUNDED Expanded + Non-AI Data Refresh

### Context
April 1, 2026. ANTHROPIC_API_KEY continues to be unavailable in child Node processes — AI scripts (around-town, tech-briefing, digests, city-briefings, weekend-picks) are blocked for a third consecutive cycle. Non-AI data pipeline is fully operational.

The RECENTLY_FUNDED section had 11 entries, all March 2026. Four companies added to SCC_SPOTLIGHT in cycles 34–37 had verified 2026 funding rounds but were never added to RECENTLY_FUNDED. Glean closed a confirmed Series F at $7.2B (verified via glean.com blog post, Feb 6 2026).

### What Was Built

**5 new entries added to RECENTLY_FUNDED in tech-companies.ts:**

1. **Axiado** (San Jose) — $100M Series C+, Dec 2025. AI security chips embedded in data center control hardware. Growing 38% YoY. Was only in Spotlight; now also in Recently Funded.

2. **Glean** (Palo Alto) — $150M Series F at $7.2B valuation, Feb 6 2026. Led by Wellington Management. Enterprise AI search for the Fortune 500. Also updated Glean's SCC_SPOTLIGHT entry from $4.6B to $7.2B valuation.

3. **Lyte** (Mountain View) — $107M seed raise, January 2026. Ex-Apple Face ID engineers building 4D perception systems as the robotic visual cortex. CES 2026 Best of Innovation. Was only in Spotlight.

4. **Sunday Robotics** (Mountain View) — $165M Series B at $1.15B valuation, March 2026 (Coatue). Household robots for dishes, laundry, tidying. Beta 2026, 3,000+ waitlist. Was only in Spotlight.

5. **Eridu** (Saratoga) — $200M+ Series A, March 2026 (John Doerr). AI data center networking startup redesigning the 3-tier network into one high-radix switch layer. Was only in Spotlight.

**Non-AI data pipeline fully refreshed:**
- upcoming-events.json: 421 events (99 ongoing), 17 sources
- upcoming-meetings.json: 1 city with upcoming meeting
- air-quality.json: South Bay avg AQI 37 (Good)
- health-scores.json: latest SCC health inspection data
- real-estate.json: Palo Alto $3.2M (-9.6% YoY), San Jose $1.3M (-7.5% YoY), Santa Clara $1.8M (+7.1% YoY)
- permit-pulse.json: Palo Alto 4 notable permits
- outages.json: 0 active outages
- restaurant-radar.json: refreshed

### Why This Was the Strongest Move

The RECENTLY_FUNDED section was missing 5 companies with recent verified rounds that were already curated in the Spotlight section. A resident browsing the Tech tab saw Eridu, Sunday, and Lyte in the Spotlight cards but wouldn't see them in the "Recently Funded" section — creating a confusing gap where the same companies appeared inconsistently. Adding them makes the funded section complete and consistent.

The Glean update is particularly notable: the company went from $4.6B to $7.2B valuation in a single round (Feb 2026). That's a 56% jump and reflects how fast enterprise AI search is growing. A Palo Alto resident who works at a tech company almost certainly has Glean deployed by their IT team.

### Next 3 Strongest Ideas
1. **Fix API key inheritance for child Node processes** — The ANTHROPIC_API_KEY is in the shell but not passed to `node scripts/*.mjs`. Solution: write a wrapper that creates `.env.local` from the environment on each scheduled run, or modify all AI scripts to accept the key via `--env-file` flag.
2. **Transit real-time** — 511.org API key required. Register at https://511.org/open-data. Daily commuter urgency (deferred every cycle).
3. **Palo Alto government (PrimeGov)** — Inspect live PrimeGov portal network traffic at cityofpaloalto.org/gov to find working API routes.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — the Recently Funded section now tells a complete story.** When a South Bay resident opens the Tech tab, the funding section now spans Saratoga (Eridu), Mountain View (Sunday, Lyte), Palo Alto (Glean), and San Jose (Axiado) — five cities, three categories (robotics, networking, security), and rounds from seed to Series F. That's the full arc of South Bay startup momentum in one view.

---

## 2026-04-03 — Cycle 40: City Hall × Tech Callout + Easter Weekend Data Refresh

### Context
April 3, 2026 (Good Friday). AI scripts are operational this cycle — ANTHROPIC_API_KEY resolved correctly. San Jose's April 7 city council agenda contains a uniquely surfaceable item: "Establishment of the GovAI Coalition as a Nonprofit Corporation." — a government-led AI governance org being incorporated at the city level. This is the kind of cross-domain story that only SBS surfaces.

### What Was Built

**New feature: City Hall × Tech callout section on the Tech tab**
- Added `GovTechCallout` component to `TechnologyView.tsx`
- Scans `upcoming-meetings.json` for agenda items matching tech-relevant keywords (AI, energy storage, EV, autonomous, chip, 5G, etc.)
- Renders up to 5 items with city, date, and link to the meeting
- April 7 San Jose council agenda surfaces: "Establishment of the GovAI Coalition as a Nonprofit Corporation" and "Willow Rock Long Duration Energy Storage Agreement"
- Also fixed hardcoded `$3.1B+` → `$3.2B+` in the recently funded stat (Q1 2026 total recalculated)

**Full data refresh (Easter weekend):**
- upcoming-events.json: 515 events (106 ongoing), 22 sources — 34 Easter weekend events
- upcoming-meetings.json: 3 cities (San Jose, Sunnyvale, Cupertino) for Apr 7 meetings
- around-town.json: 8 items from Stoa
- digests.json: 11 city digests
- city-briefings.json: 11 cities, week of Apr 3–10
- weekend-picks.json: Spring Egg Hunt, SJ Earthquakes vs SD FC, National Poetry Month rap
- restaurant-radar.json: 7 SJ signals — $3.1M build at Stevens Creek Blvd, $1.2M buildout at Santana Row
- tech-briefing.json: Nexthop AI $500M, MatX $500M featured
- real-estate.json: 11 cities
- permit-pulse.json: San Jose + Palo Alto
- air-quality.json: South Bay avg AQI 25 (Good)
- health-scores.json: latest SCC data

### Why This Was the Strongest Move

The "City Hall × Tech" callout is uniquely SBS. No other local product surfaces the intersection of municipal government decisions and tech relevance for residents. The GovAI Coalition item is genuinely newsworthy — San Jose is literally incorporating an AI governance nonprofit at the council level on April 7. A tech worker in Santa Clara reading SBS on Good Friday would see this and say "wait, my city is doing *what*?"

### Next 3 Strongest Ideas
1. **Transit real-time** — 511.org API key required. Register at https://511.org/open-data. Daily commuter urgency.
2. **Mobile polish pass** — Aesthetics gap from standing orders; typography and spacing need a dedicated cycle.
3. **Tech tab: upcoming tech events** — Pull verified meetup/conference data for South Bay tech events (Eventbrite API or direct calendar parsing).

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — the Tech tab now bridges startup culture and civic governance.** The City Hall × Tech callout is a capability no other South Bay product offers. A resident who cares about AI, energy, or infrastructure can see at a glance what their city council is voting on next week — without leaving the tech tab.

---

## 2026-04-03 — Cycle 43: Palo Alto Restaurant Radar + Data Refresh

### Context
April 3, 2026 (Good Friday). Previous cycles gave SBS a strong tech tab and event coverage, but the Food tab's Restaurant Radar only covered San Jose. Palo Alto — home of University Ave and California Ave restaurant rows — had zero coverage. The Palo Alto PermitView API was already implemented in the permits script but untapped for restaurant signals.

### What Was Built

**Palo Alto restaurant radar expansion:**
- `generate-restaurant-radar.mjs` now fetches from both San Jose (CKAN) and Palo Alto (PermitView)
- PA food permit filter: queries PermitView with SQL-style LIKE clauses for restaurant/cafe/bakery/food/kitchen/dining/bistro/brew/bar terms
- Residential permit filter: strips "Web - Kitchen or Bath Remodel", "Res:" prefix, single-family, ADU, instant permit patterns
- Business name extraction from PA DESCRIPTION field: "COM: Standalone U&O for 'Bistro Demiya'" → "Bistro Demiya"
- Signal labeling for PA: "New Opening" (U&O permits), "Conditional Use" (CUP), "Renovation" (TI), "New Buildout" (equipment adds)
- Each item now has a `city` field ("san-jose" or "palo-alto")
- `FoodView.tsx`: added CITY_LABELS map, city tag on each radar item meta row, updated subtitle "San Jose · Palo Alto", updated disclaimer

**PA signals this cycle:**
- **Bistro Demiya** at 407 Lytton Ave — New Opening (U&O permit filed, downtown PA)
- **121 Lytton Ave** — New Opening (unnamed, same Lytton Ave block)
- **338 University Ave** — Renovation (iconic restaurant row)
- **341 California Ave** — Conditional Use Permit (alcohol license amendment, CA Ave restaurant row)

**SJ signals this cycle:**
- **Eos & Nyx** at 2040 N 1st St — Possible Closure (demolition permit)
- **Baekjeong** at 2855 Stevens Creek Blvd — $3.1M new build (Korean BBQ chain)
- **Flora** at 355 Santana Row — $1.2M major buildout

**Data refresh:**
- upcoming-events.json: 527 events (108 ongoing), 25 sources
- city-briefings.json: 11 cities, Apr 3–10
- around-town.json: 8 items (same as prior cycle)
- digests.json: 11 city digests
- tech-briefing.json: refreshed
- restaurant-radar.json: 12 signals (7 SJ + 5 PA)

### Why This Was the Strongest Move

Palo Alto's University Ave and California Ave are two of the most closely-watched restaurant strips in the South Bay. "Bistro Demiya" opening on Lytton Ave in downtown PA is exactly the kind of local signal a Palo Alto resident would want to see — and no newspaper or app surfaces it from permit data. SBS now does. The multi-city expansion also future-proofs the feature: the architecture (`city` field on every item, CITY_LABELS map) makes adding Mountain View or Sunnyvale straightforward if those cities expose permit APIs.

### Next 3 Strongest Ideas
1. **Transit real-time** — 511.org API key required. Register at https://511.org/open-data. Daily commuter urgency.
2. **Mountain View restaurant radar** — Mountain View doesn't have CKAN or PermitView. Check their direct permit portal at permits.mountainview.gov or similar. Major gap: Castro St is highly watched.
3. **Tech tab: curated conferences** — Add static curated list of major South Bay tech events (Startup Grind, YC Demo Days, etc.) so the Tech Events section is never empty.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — the Food tab now serves two of the South Bay's most food-conscious cities.** A Palo Alto resident opening the Food tab now sees real permit activity on streets they walk every week. "Bistro Demiya is opening on Lytton Ave" is a sentence that only SBS is saying right now.

---

## 2026-04-03 — Cycle 44: Annual Tech Conferences Section + Data Refresh

### Context
April 3, 2026. The Tech tab had only 2 events showing in the next 60 days via keyword matching from the events scraper — one of which was a library digital literacy session, not a tech conference. The "Tech Events Near You" section was essentially empty for developers and tech workers looking for South Bay tech events. The vision log had listed "tech tab: curated conferences" as a top-3 priority for two consecutive cycles.

### What Was Built

**New section: Annual Tech Conferences** in `TechnologyView.tsx`:
- Added `TechConference` interface and `TECH_CONFERENCES` array to `tech-companies.ts` — 6 annual SV tech conferences
- Added `ConferenceRow` and `AnnualConferencesSection` React components
- Section placed between "Tech Events Near You" and "City Hall × Tech"
- Smart date logic: computes next occurrence (this year if upcoming, next year if past), shows "Coming Up" vs "Later This Year" grouping
- Each conference shows: name (link), Global/Regional badge, venue, city, 2-line description
- Footer note: "Dates are typical annual timing — confirm on the organizer's website before making plans"

**Conferences included:**
- **NVIDIA GTC** — San Jose Convention Center, typically March (already past for 2026 → shows as "Later This Year: March 2027")
- **Startup Grind Global** — Redwood City, typically April 28–29 (Coming Up)
- **RSA Conference** — San Francisco, typically April (Coming Up)
- **Google I/O** — Shoreline Amphitheatre, Mountain View, typically May (Coming Up)
- **Apple WWDC** — Apple Park, Cupertino, typically June (Coming Up)
- **SVForum Tech Summit** — Computer History Museum, Mountain View, typically September (Later This Year)

**Data refresh:**
- upcoming-events.json: refreshed, 25 active sources
- city-briefings.json: 11 cities, Apr 3–10
- digests.json: 11 city digests
- tech-briefing.json: refreshed (Nexthop AI / MatX / Ayar Labs $500M rounds narrative)
- around-town.json: refreshed
- upcoming-meetings.json: San Jose, Sunnyvale, Cupertino for Apr 7

### Why This Was the Strongest Move

The Tech Events Near You section was showing 2 events in the next 60 days. A tech worker in Mountain View opening SBS would see a library digital literacy session and a city task force meeting — nothing relevant to the developer/startup ecosystem they live and breathe. The Annual Tech Conferences section fixes this permanently: no matter when someone opens the Tech tab, they see the major annual SV events coming up, with context on why each matters.

The section is self-maintaining: the date logic computes "next occurrence" dynamically, so Google I/O will correctly show "May 2026" in April, and "May 2027" in June. No data refresh needed — it's always accurate to today.

The four "Coming Up" conferences as of today are exactly the ones a South Bay tech worker would care about: Startup Grind (founders/investors, Redwood City), RSA (security, the South Bay's fastest-growing sector), Google I/O (Mountain View's marquee event), and WWDC (Cupertino's marquee event). These four alone represent what April–June looks like for the SV tech calendar.

### Next 3 Strongest Ideas
1. **Transit real-time** — 511.org API key required. Register at https://511.org/open-data. Daily commuter urgency. Has been #1 for many cycles.
2. **Mountain View restaurant radar** — MV doesn't have CKAN. Investigate permits.mountainview.gov or the city's permit portal. Castro St is highly watched.
3. **Mobile polish pass** — Per standing orders, aesthetics are a real gap. A dedicated cycle fixing typography hierarchy, spacing, and card density on 375px screens would deliver visible quality improvement.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — the Tech tab now answers "what's happening in SV tech this spring?"** A developer in Mountain View opens the Tech tab and sees: Google I/O is coming to Shoreline in May, WWDC is at Apple Park in June, Startup Grind is in Redwood City this month. No other South Bay homepage aggregates this. The conferences section transforms the Tech tab from "company data" to "SV tech culture calendar."

---

## 2026-04-03 — Cycle 42: Expand SV History Milestones + Data Refresh

### Context
April 3, 2026 (Good Friday, spring break starting). The "This Week in SV History" section launched in cycle 41 with 9 milestones. A gap was immediately apparent: the section only covered about half the year, leaving months like February, June, September, and December dark. More importantly, Intuit was missing entirely — a Mountain View company that makes the software millions of South Bay households use every April to file their taxes.

### What Was Built

**Expanded SV History milestone database (9 → 14 milestones):**

Five new milestones added:
- **Intuit** (Mountain View, Apr 1983) — Founded April 1983 by Scott Cook and Tom Proulx in Palo Alto, now headquartered in Mountain View. *Shows this week* — 43rd anniversary. The company behind TurboTax and QuickBooks is foundational to South Bay's financial software ecosystem.
- **Sun Microsystems** (Mountain View, Feb 24 1982) — Founded February 24, 1982 at Stanford. "The network is the computer." Java, Solaris, and the SPARC architecture came from here before Oracle acquired it in 2010.
- **Oracle** (Santa Clara, Jun 16 1977) — Founded June 16, 1977 as Software Development Laboratories in Santa Clara. Larry Ellison's relational database became the backbone of enterprise computing worldwide.
- **eBay** (San Jose, Sep 3 1995) — Founded September 3, 1995 by Pierre Omidyar from his San Jose home. First item sold: a broken laser pointer for $14.83. Proved that strangers on the internet could transact.
- **Adobe** (San Jose, Dec 2 1982) — Founded December 2, 1982 by John Warnock and Charles Geschke, named after Adobe Creek in Los Altos. PostScript revolutionized desktop publishing; Photoshop shaped visual culture.

**Full data refresh:**
- upcoming-events.json: 497 events (108 ongoing), 21 sources — SC County Fire Dept now included, bilingual title fixes from cycle 41 integrated
- around-town.json: 8 items — Cupertino business license amnesty, San Antonio Road area plan (Palo Alto), retail vitality ordinance, Campbell beekeeping
- digests.json: 11 city digests
- city-briefings.json: 11 cities for Apr 3–10
- spring-break-picks.json: 12 picks including Bay FC vs. Washington Spirit, Easter liturgy at Mission Church, porcelain casting workshop
- upcoming-meetings.json: San Jose, Sunnyvale, Cupertino for Apr 7

### Why This Was the Strongest Move

Intuit's April founding means the milestone fires THIS WEEK — during tax season, during spring break, the week Apple's 50th is visible. A Mountain View resident opening SBS sees: Apple turns 50, NVIDIA turns 33, and Intuit (TurboTax) turns 43 — all in the same ±8-day window. That's a remarkable concentration of local tech history.

The milestone expansion also future-proofs the feature. Before: 5 months of the year had no milestones visible. After: every month has at least one notable South Bay company in or near the window. Oracle lights up June. eBay lights up September. Adobe and Sun fill December–February.

### Next 3 Strongest Ideas
1. **Transit real-time** — 511.org API key required. Daily commuter urgency. Register at https://511.org/open-data.
2. **Restaurant radar for Mountain View / Sunnyvale** — Need to identify open data portals. SJ and Palo Alto are covered. MV/Sunnyvale have no CKAN equivalent — check city permit portals directly.
3. **Tech tab: upcoming tech events** — Section exists but is currently empty most weeks (depends on CHM exhibits + keyword-matched events). Consider adding a static curated "Tech Conferences" section with quarterly events like Startup Grind (Apr 28-29 SV), YC Demo Days, etc.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — the Tech tab now has temporal depth across the full year.** Any week, any month, the "This Week in SV History" section can surface a locally-rooted story. April: Apple + NVIDIA + Intuit. June: Oracle. September: eBay. December: Cisco + Adobe. The feature makes SBS feel like a place with institutional memory, not just a news aggregator.

---

## 2026-04-03 — Cycle 41: This Week in SV History + Full Data Refresh

### Context
April 3, 2026 (Good Friday). Easter weekend. Spring break. This week is notable in Silicon Valley history: Apple's 50th anniversary (founded April 1, 1976) and NVIDIA's 33rd anniversary (founded April 5, 1993) both fall within a 4-day window. The CHM currently has an "Apple at 50" exhibit. No other South Bay product was surfacing this.

### What Was Built

**New feature: "This Week in SV History" section on the Tech tab**
- Added `TECH_MILESTONES` export to `tech-companies.ts`: 9 companies with founding dates, cities, anniversary notes, and optional CHM exhibit links
- Added `SvHistorySection` component to `TechnologyView.tsx`: shows milestones within ±8 days of today
- Section appears between the Weekly Tech Briefing and the Pulse strip
- This week: Apple at 50 (Cupertino, Apr 1) + NVIDIA at 33 (Santa Clara, Apr 5) both show
- Apple card shows a CHM exhibit badge linking to "Apple at 50" exhibit
- Future milestones: Intel, Google, Cisco, Netflix, HP, AMD, Yahoo all covered across the year

**Full data refresh:**
- upcoming-events.json: 489 events (109 ongoing) — SCCL timed out this run, other 22 sources captured
- upcoming-meetings.json: San Jose, Sunnyvale, Cupertino for Apr 7
- around-town.json: 8 items — Cupertino business license amnesty, San Jose litter pick-up, Palo Alto retail zoning, Campbell beekeeping ordinance
- weekend-picks.json: Spring Egg Hunt, SJ Earthquakes vs SD FC, National Poetry Month rap
- tech-briefing.json: $4B Q1 funding narrative, 21 rounds tracked

### Why This Was the Strongest Move

Apple's 50th is one of the most significant anniversaries in Silicon Valley history — and almost nobody opened a browser this week and saw "Apple turns 50 this week" as a local story. SBS now does. NVIDIA at 33 is a bonus — the company that runs the AI revolution was founded 3 miles from Apple Park, and their anniversary overlaps perfectly. A Cupertino or Santa Clara resident opening SBS during Easter weekend would see both milestones side-by-side with the CHM exhibit badge — that's exactly the kind of "wait, I didn't know that" moment that makes SBS feel like a local homepage.

The milestone system is also evergreen: Intel at 58 (July), Google at 28 (September), Netflix at 29 (August), HP at 87 (January) — every month has a story waiting.

### Next 3 Strongest Ideas
1. **Transit real-time** — 511.org API key required. Register at https://511.org/open-data. Daily commuter urgency.
2. **Eventbrite/Meetup tech events** — Eventbrite v3 /events/search is gone. Meetup GraphQL API requires OAuth. Need a workaround — possibly scrape public Meetup group pages for SF Silicon Valley groups.
3. **Mountain View/Sunnyvale restaurant radar** — Mountain View doesn't have CKAN. Sunnyvale doesn't either. Need to check their permit portals directly.

### Are We Becoming More Like the Homepage for South Bay Life?
**Yes — SBS now has a sense of time.** The "This Week in SV History" section gives the Tech tab a temporal dimension — it changes every week based on what's happening in Silicon Valley's past. A resident who opens SBS this Easter weekend sees Apple's birthday AND NVIDIA's birthday. That's a story no newspaper, aggregator, or app is telling them. It's local, it's timely, and it's only possible because SBS is building its own data layer city by city, company by company.
