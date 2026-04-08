import { useState, useCallback, useRef, useEffect } from "react";
import type { Tab, City } from "../../lib/south-bay/types";
import { TABS } from "../../lib/south-bay/types";
import { CITIES, getCityName } from "../../lib/south-bay/cities";
import SportsView from "./views/SportsView";
import HomepageView from "./homepage/HomepageView";
import SouthBayTodayView from "./homepage/SouthBayTodayView";
import GovernmentView from "./views/GovernmentView";
import EventsView from "./views/EventsView";
import TechnologyView from "./views/TechnologyView";
import DevelopmentView from "./views/DevelopmentView";
import WeatherView from "./views/WeatherView";
import FoodView from "./views/FoodView";
import CampsView from "./views/CampsView";

const TODAY = new Date().toLocaleDateString("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "America/Los_Angeles",
});

const TAB_IDS = new Set<string>(TABS.map((t) => t.id));

function getTabFromHash(): Tab {
  const hash = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
  return TAB_IDS.has(hash) ? (hash as Tab) : "overview";
}

export default function SignalApp() {
  const [activeTab, setActiveTab] = useState<Tab>(getTabFromHash);

  const navigateTo = useCallback((tab: Tab) => {
    setActiveTab(tab);
    window.location.hash = tab === "overview" ? "" : tab;
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onHashChange = () => { setActiveTab(getTabFromHash()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const [selectedCities, setSelectedCities] = useState<Set<City>>(
    () => new Set(CITIES.map((c) => c.id)),
  );
  const [homeCity, setHomeCityState] = useState<City | null>(() => {
    if (typeof window === "undefined") return null;
    return (localStorage.getItem("sb-home-city") as City | null) ?? null;
  });

  const setHomeCity = useCallback((city: City | null) => {
    setHomeCityState(city);
    if (city) {
      localStorage.setItem("sb-home-city", city);
    } else {
      localStorage.removeItem("sb-home-city");
    }
  }, []);

  const allSelected = selectedCities.size === CITIES.length;

  const toggleCity = useCallback((city: City) => {
    setSelectedCities((prev) => {
      const next = new Set(prev);
      if (next.has(city)) {
        next.delete(city);
      } else {
        next.add(city);
      }
      return next;
    });
  }, []);

  const navInnerRef = useRef<HTMLDivElement>(null);
  const [showNavArrow, setShowNavArrow] = useState(false);

  useEffect(() => {
    const el = navInnerRef.current;
    if (!el) return;
    const check = () => setShowNavArrow(el.scrollWidth > el.clientWidth + 4 && el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
    check();
    el.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check, { passive: true });
    return () => { el.removeEventListener("scroll", check); window.removeEventListener("resize", check); };
  }, []);

  const scrollNavRight = () => {
    navInnerRef.current?.scrollBy({ left: 120, behavior: "smooth" });
  };

  const toggleAll = useCallback(() => {
    setSelectedCities((prev) => {
      if (prev.size === CITIES.length) return new Set();
      return new Set(CITIES.map((c) => c.id));
    });
  }, []);

  // Only show city filter on government/events tabs (sports and tech are regional)
  const showCityFilter = activeTab === "government" || activeTab === "events";

  return (
    <>
      {/* Masthead */}
      <header className="sb-header">
        <div className="sb-header-inner">
          <a href="/" className="sb-brand">
            <span className="sb-logo">
              <span className="sb-logo-main-row">
                <span className="sb-logo-the">the</span>
                <span className="sb-logo-south-bay">South Bay</span>
              </span>
              <span className="sb-logo-signal-row">
                <span className="sb-logo-signal-rule" />
                <span className="sb-logo-signal-word">Signal</span>
                <span className="sb-logo-signal-rule" />
              </span>
            </span>
          </a>
          <div className="sb-date">
            <div>{TODAY}</div>
            {homeCity && (
              <div style={{ color: "var(--sb-muted)", fontWeight: 600, marginTop: 2 }}>
                {getCityName(homeCity).toUpperCase()}
              </div>
            )}
          </div>
          <div className="sb-slogan">Local news. Good vibes. No ads.</div>
          <div className="sb-social-links">
            <a href="https://x.com/southbaytoday" target="_blank" rel="noopener" aria-label="Follow on X" className="sb-social-icon">
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            </a>
            <a href="https://bsky.app/profile/southbaytoday.bsky.social" target="_blank" rel="noopener" aria-label="Follow on Bluesky" className="sb-social-icon">
              <svg viewBox="0 0 568 501" fill="currentColor" width="16" height="16"><path d="M123.121 33.664C188.241 82.553 258.281 181.68 284 234.873c25.719-53.192 95.759-152.32 160.879-201.21C491.866-1.611 568-28.906 568 57.947c0 17.346-9.945 145.713-15.778 166.555-20.275 72.453-94.155 90.933-159.875 79.748C507.222 323.8 536.444 388.56 473.333 453.32c-119.86 122.992-172.272-30.859-185.702-70.281-2.462-7.227-3.614-10.608-3.631-7.733-.017-2.875-1.169.506-3.631 7.733-13.43 39.422-65.842 193.273-185.702 70.281-63.111-64.76-33.89-129.52 80.986-149.071-65.72 11.186-139.6-7.295-159.875-79.748C10.945 203.659 1 75.291 1 57.946 1-28.906 76.135-1.612 123.121 33.664z"/></svg>
            </a>
            <a href="https://www.threads.net/@southbaytoday" target="_blank" rel="noopener" aria-label="Follow on Threads" className="sb-social-icon">
              <svg viewBox="0 0 192 192" fill="currentColor" width="16" height="16"><path d="M141.537 88.988a66.667 66.667 0 0 0-2.518-1.143c-1.482-27.307-16.403-42.94-41.457-43.1h-.34c-14.986 0-27.449 6.396-35.12 18.036l13.779 9.452c5.73-8.695 14.724-10.548 21.348-10.548h.229c8.249.053 14.474 2.452 18.503 7.129 2.932 3.405 4.893 8.111 5.864 14.05a115.6 115.6 0 0 0-24.478-2.858c-28.007-1.607-46.005 15.011-47.216 38.578-.644 12.533 4.729 24.311 15.12 33.166 8.778 7.476 20.099 11.267 31.853 10.67 15.495-.787 27.603-7.456 35.993-19.826 6.387-9.418 10.354-21.472 11.924-36.3 7.155 4.318 12.465 10.04 15.411 17.073 5.017 11.96 5.312 31.586-10.652 47.553-13.98 13.98-30.815 20.048-56.158 20.265-28.12-.241-49.353-9.259-63.072-26.79C16.942 147.523 9.843 121.705 9.6 91.987c.243-29.718 7.342-55.536 21.101-76.725C44.42 -2.014 65.653-10.772 93.773-11.013c28.334.245 49.858 9.078 63.98 26.253 6.858 8.348 11.977 18.661 15.352 30.766l16.152-4.321c-3.944-14.132-9.916-26.243-17.94-36.254C154.617-14.588 128.85-25.777 93.727-26.047l-.063.001c-35.087.271-61.167 11.457-77.513 33.232C1.673 27.126-5.924 56.762-6.2 91.94v.103c.276 35.178 7.873 64.817 22.56 88.086 16.349 25.893 42.429 37.079 77.513 37.35l.063-.001c29.262-.243 49.742-8.024 66.422-24.707 22.003-22.007 21.348-49.591 14.04-66.993-5.242-12.494-15.077-22.591-28.36-29.79zm-49.427 61.071c-13.005.662-26.535-5.137-27.185-17.789-.482-9.396 6.68-19.87 31.246-18.462 2.742.157 5.384.4 7.922.72a91.476 91.476 0 0 1 3.859.582c-2.679 23.576-15.844 34.949-15.844 34.949z" transform="translate(2 2)"/></svg>
            </a>
            <a href="https://www.facebook.com/1057203394142664" target="_blank" rel="noopener" aria-label="Follow on Facebook" className="sb-social-icon">
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
            </a>
          </div>
        </div>
      </header>

      <hr className="sb-masthead-rule" />

      {/* Navigation */}
      <nav className="sb-nav" style={{ position: "relative" }}>
        <div className="sb-nav-inner" ref={navInnerRef}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`sb-tab${activeTab === tab.id ? " sb-tab--active" : ""}`}
              onClick={() => navigateTo(tab.id)}
              aria-current={activeTab === tab.id ? "page" : undefined}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {showNavArrow && (
          <button
            onClick={scrollNavRight}
            aria-label="Scroll tabs right"
            className="sb-nav-scroll-arrow"
          >
            ›
          </button>
        )}
      </nav>

      {/* City filter */}
      {showCityFilter && (
        <div className="sb-filters">
          <div className="sb-filters-inner">
            <span className="sb-filter-label">Cities</span>
            <button
              className={`sb-city-pill sb-city-pill--all${allSelected ? " sb-city-pill--active" : ""}`}
              onClick={toggleAll}
            >
              All
            </button>
            {CITIES.map((city) => (
              <button
                key={city.id}
                className={`sb-city-pill${selectedCities.has(city.id) ? " sb-city-pill--active" : ""}`}
                onClick={() => toggleCity(city.id)}
              >
                {city.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      <main className="sb-main">
        {activeTab === "overview" && (
          <SouthBayTodayView homeCity={homeCity} setHomeCity={setHomeCity} onNavigate={navigateTo} />
        )}
        {activeTab === "sports" && <SportsView />}
        {activeTab === "events" && (
          <EventsView selectedCities={selectedCities} homeCity={homeCity} />
        )}
        {activeTab === "government" && (
          <GovernmentView selectedCities={selectedCities} homeCity={homeCity} />
        )}
        {activeTab === "technology" && <TechnologyView />}
        {activeTab === "development" && <DevelopmentView homeCity={homeCity} />}
        {activeTab === "food" && <FoodView />}
        {activeTab === "weather" && <WeatherView homeCity={homeCity} />}
        {activeTab === "camps" && <CampsView />}
      </main>

      {/* Footer */}
      <footer className="sb-footer">
        <a href="/">southbaytoday.org</a>
      </footer>
    </>
  );
}
