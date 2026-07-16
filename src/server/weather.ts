/**
 * Route-facing weather server function (Open-Meteo via adapters/weather.ts).
 * Auth-gated like other personal server functions; GPS coords come from the client.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireAuthSession } from "@/lib/auth";
import { fetchTodayWeather, type WeatherForecast } from "@/server/adapters/weather";

export type { WeatherConditionKey, WeatherForecast } from "@/server/adapters/weather";

export type TodayWeatherResult = WeatherForecast | null;

export interface TodayWeatherInput {
  latitude: number;
  longitude: number;
}

function validateCoords(data: TodayWeatherInput): TodayWeatherInput {
  const latitude = Number(data?.latitude);
  const longitude = Number(data?.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error("latitude must be a number between -90 and 90");
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("longitude must be a number between -180 and 180");
  }
  return { latitude, longitude };
}

export const getTodayWeather = createServerFn({ method: "POST" })
  .validator((data: TodayWeatherInput) => validateCoords(data))
  .handler(async ({ data }): Promise<TodayWeatherResult> => {
    await requireAuthSession();
    return fetchTodayWeather(data.latitude, data.longitude);
  });
