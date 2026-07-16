/**
 * Client hook: geolocation → getTodayWeather with sessionStorage cache.
 * Denies/unavailable GPS or failed fetch → weather null (UI can ignore).
 */

import { useCallback, useEffect, useState } from "react";
import { todayISO } from "@/lib/domain";
import { getTodayWeather, type WeatherForecast } from "@/server/weather";

export type { WeatherConditionKey, WeatherForecast } from "@/server/weather";

export type WeatherStatus = "idle" | "locating" | "loading" | "ready" | "unavailable";

export interface UseWeatherState {
  status: WeatherStatus;
  weather: WeatherForecast | null;
  error: string | null;
  /** Re-run geolocation + fetch (bypasses session cache). */
  refresh: () => void;
}

const CACHE_PREFIX = "today-weather:v1:";

function roundCoord(n: number): number {
  // ~1km precision — enough for daily weather, reduces cache key churn.
  return Math.round(n * 100) / 100;
}

function cacheKey(date: string, lat: number, lon: number): string {
  return `${CACHE_PREFIX}${date}:${roundCoord(lat)},${roundCoord(lon)}`;
}

function readCache(key: string): WeatherForecast | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WeatherForecast;
    if (
      parsed &&
      typeof parsed.currentTempF === "number" &&
      typeof parsed.highF === "number" &&
      typeof parsed.lowF === "number" &&
      typeof parsed.condition === "string"
    ) {
      return parsed;
    }
  } catch {
    // ignore corrupt cache
  }
  return null;
}

function writeCache(key: string, weather: WeatherForecast): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(weather));
  } catch {
    // quota / private mode — ignore
  }
}

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("Geolocation unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 10_000,
      maximumAge: 15 * 60_000,
    });
  });
}

/**
 * Load today's weather for the user's current GPS position.
 * Caches by date + rounded coords in sessionStorage.
 */
export function useWeather(enabled = true): UseWeatherState {
  const [status, setStatus] = useState<WeatherStatus>(enabled ? "idle" : "unavailable");
  const [weather, setWeather] = useState<WeatherForecast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus("unavailable");
      setWeather(null);
      setError(null);
      return;
    }

    let cancelled = false;

    (async () => {
      setStatus("locating");
      setError(null);

      let lat: number;
      let lon: number;
      try {
        const pos = await getPosition();
        lat = pos.coords.latitude;
        lon = pos.coords.longitude;
      } catch {
        if (!cancelled) {
          setStatus("unavailable");
          setWeather(null);
          setError("Location unavailable");
        }
        return;
      }

      if (cancelled) return;

      const date = todayISO();
      const key = cacheKey(date, lat, lon);
      // nonce > 0 after refresh(); still use cache on first mount (nonce === 0).
      if (nonce === 0) {
        const cached = readCache(key);
        if (cached) {
          setWeather(cached);
          setStatus("ready");
          return;
        }
      }

      setStatus("loading");
      try {
        const result = await getTodayWeather({
          data: { latitude: lat, longitude: lon },
        });
        if (cancelled) return;
        if (result) {
          writeCache(key, result);
          setWeather(result);
          setStatus("ready");
        } else {
          setWeather(null);
          setStatus("unavailable");
          setError("Weather unavailable");
        }
      } catch (e) {
        if (cancelled) return;
        setWeather(null);
        setStatus("unavailable");
        setError(e instanceof Error ? e.message : "Weather unavailable");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, nonce]);

  return { status, weather, error, refresh };
}
