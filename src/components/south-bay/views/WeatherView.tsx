import ForecastCard from "../cards/ForecastCard";
import AirQualityCard from "../cards/AirQualityCard";
import QuakeWatchCard from "../cards/QuakeWatchCard";
import WaterWatchCard from "../cards/WaterWatchCard";

// Regional anchor for forecast/AQI — South Bay Today is area-wide, not
// city-specific. San Jose is a reasonable stand-in for the whole region.
const REGIONAL_ANCHOR = "san-jose" as const;

export default function WeatherView() {
  return (
    <>
      <ForecastCard homeCity={REGIONAL_ANCHOR} />
      <AirQualityCard homeCity={REGIONAL_ANCHOR} />
      <QuakeWatchCard />
      <WaterWatchCard />
    </>
  );
}
