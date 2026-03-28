import { useState, useCallback } from "react";
import type { Tab, City } from "../../lib/south-bay/types";
import { TABS } from "../../lib/south-bay/types";
import { CITIES, getCityName } from "../../lib/south-bay/cities";
import SportsView from "./views/SportsView";
import OverviewView from "./views/OverviewView";
import GovernmentView from "./views/GovernmentView";
import EventsView from "./views/EventsView";
import TechnologyView from "./views/TechnologyView";
import DevelopmentView from "./views/DevelopmentView";
import TransitView from "./views/TransitView";
import PlanView from "./views/PlanView";

const TODAY = new Date().toLocaleDateString("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "America/Los_Angeles",
});

export default function SignalApp() {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
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
          <a href="/south-bay" className="sb-brand">
            <span className="sb-brand-name">South Bay Signal</span>
          </a>
          <div className="sb-date">
            {TODAY}
            {homeCity && (
              <span style={{ marginLeft: 8, color: "var(--sb-accent)", fontWeight: 600 }}>
                · {getCityName(homeCity)}
              </span>
            )}
          </div>
        </div>
      </header>

      <hr className="sb-masthead-rule" />

      {/* Navigation */}
      <nav className="sb-nav">
        <div className="sb-nav-inner">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`sb-tab${activeTab === tab.id ? " sb-tab--active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              aria-current={activeTab === tab.id ? "page" : undefined}
            >
              {tab.label}
            </button>
          ))}
        </div>
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
          <OverviewView homeCity={homeCity} setHomeCity={setHomeCity} onNavigate={setActiveTab} />
        )}
        {activeTab === "sports" && <SportsView />}
        {activeTab === "events" && (
          <EventsView selectedCities={selectedCities} homeCity={homeCity} />
        )}
        {activeTab === "government" && (
          <GovernmentView selectedCities={selectedCities} homeCity={homeCity} />
        )}
        {activeTab === "technology" && <TechnologyView />}
        {activeTab === "development" && <DevelopmentView />}
        {activeTab === "transit" && <TransitView />}
        {activeTab === "plan" && <PlanView />}
      </main>

      {/* Footer */}
      <footer className="sb-footer">
        Sports data via ESPN and MLB. Scores update every 30 seconds during live games.
        <br />
        <a href="/">stanwood.dev</a>
      </footer>
    </>
  );
}
