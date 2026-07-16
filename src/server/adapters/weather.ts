/**
 * Open-Meteo forecast adapter (no API key).
 * US units: Fahrenheit temperatures per AGENTS.md.
 */

export type WeatherConditionKey =
  | "clear"
  | "partly-cloudy"
  | "cloudy"
  | "fog"
  | "rain"
  | "snow"
  | "thunderstorm";

export interface WeatherForecast {
  currentTempF: number;
  highF: number;
  lowF: number;
  precipitationProbability: number;
  weatherCode: number;
  label: string;
  condition: WeatherConditionKey;
  /** ISO date (local to the forecast timezone) for "today". */
  date: string;
}

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    weather_code?: number;
  };
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
    weather_code?: number[];
  };
}

/** Map WMO weather interpretation codes to a simple condition + label. */
export function mapWmoWeatherCode(code: number): { condition: WeatherConditionKey; label: string } {
  const c = Number.isFinite(code) ? Math.trunc(code) : 0;
  if (c === 0) return { condition: "clear", label: "Clear" };
  if (c === 1) return { condition: "partly-cloudy", label: "Mainly clear" };
  if (c === 2) return { condition: "partly-cloudy", label: "Partly cloudy" };
  if (c === 3) return { condition: "cloudy", label: "Overcast" };
  if (c === 45 || c === 48) return { condition: "fog", label: "Fog" };
  if (c === 51 || c === 53 || c === 55) return { condition: "rain", label: "Drizzle" };
  if (c === 56 || c === 57) return { condition: "rain", label: "Freezing drizzle" };
  if (c === 61 || c === 63 || c === 65) return { condition: "rain", label: "Rain" };
  if (c === 66 || c === 67) return { condition: "rain", label: "Freezing rain" };
  if (c === 71 || c === 73 || c === 75) return { condition: "snow", label: "Snow" };
  if (c === 77) return { condition: "snow", label: "Snow grains" };
  if (c === 80 || c === 81 || c === 82) return { condition: "rain", label: "Rain showers" };
  if (c === 85 || c === 86) return { condition: "snow", label: "Snow showers" };
  if (c === 95) return { condition: "thunderstorm", label: "Thunderstorm" };
  if (c === 96 || c === 99) return { condition: "thunderstorm", label: "Thunderstorm with hail" };
  return { condition: "cloudy", label: "Unknown" };
}

function finiteOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch today's forecast for a lat/lon from Open-Meteo.
 * Returns null on network/parse failure (never throws).
 */
export async function fetchTodayWeather(
  latitude: number,
  longitude: number,
): Promise<WeatherForecast | null> {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
    current: "temperature_2m,weather_code",
    timezone: "auto",
    temperature_unit: "fahrenheit",
    forecast_days: "1",
  });
  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as OpenMeteoResponse;

    const currentTemp = finiteOrNull(data.current?.temperature_2m);
    const high = finiteOrNull(data.daily?.temperature_2m_max?.[0]);
    const low = finiteOrNull(data.daily?.temperature_2m_min?.[0]);
    if (currentTemp === null || high === null || low === null) return null;

    const code =
      finiteOrNull(data.current?.weather_code) ?? finiteOrNull(data.daily?.weather_code?.[0]) ?? 0;
    const precip = finiteOrNull(data.daily?.precipitation_probability_max?.[0]) ?? 0;
    const { condition, label } = mapWmoWeatherCode(code);
    const date = data.daily?.time?.[0] || new Date().toISOString().slice(0, 10);

    return {
      currentTempF: Math.round(currentTemp),
      highF: Math.round(high),
      lowF: Math.round(low),
      precipitationProbability: Math.max(0, Math.min(100, Math.round(precip))),
      weatherCode: Math.trunc(code),
      label,
      condition,
      date,
    };
  } catch (e) {
    console.warn("[weather] Open-Meteo fetch failed", e);
    return null;
  }
}
