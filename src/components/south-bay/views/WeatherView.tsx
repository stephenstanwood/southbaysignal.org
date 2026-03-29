import ForecastCard from "../cards/ForecastCard";
import AirQualityCard from "../cards/AirQualityCard";
import QuakeWatchCard from "../cards/QuakeWatchCard";
import WaterWatchCard from "../cards/WaterWatchCard";
import type { City } from "../../../lib/south-bay/types";

interface Props {
  homeCity: City | null;
}

export default function WeatherView({ homeCity }: Props) {
  return (
    <>
      <ForecastCard homeCity={homeCity} />
      <AirQualityCard homeCity={homeCity} />
      <QuakeWatchCard />
      <WaterWatchCard />
    </>
  );
}
