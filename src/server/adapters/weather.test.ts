import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTodayWeather, mapWmoWeatherCode } from "./weather";

describe("mapWmoWeatherCode", () => {
  it("maps clear and cloudy bands", () => {
    expect(mapWmoWeatherCode(0)).toEqual({ condition: "clear", label: "Clear" });
    expect(mapWmoWeatherCode(1).condition).toBe("partly-cloudy");
    expect(mapWmoWeatherCode(2).condition).toBe("partly-cloudy");
    expect(mapWmoWeatherCode(3)).toEqual({ condition: "cloudy", label: "Overcast" });
  });

  it("maps fog, rain, snow, and thunderstorm codes", () => {
    expect(mapWmoWeatherCode(45).condition).toBe("fog");
    expect(mapWmoWeatherCode(61).condition).toBe("rain");
    expect(mapWmoWeatherCode(80).condition).toBe("rain");
    expect(mapWmoWeatherCode(71).condition).toBe("snow");
    expect(mapWmoWeatherCode(85).condition).toBe("snow");
    expect(mapWmoWeatherCode(95).condition).toBe("thunderstorm");
    expect(mapWmoWeatherCode(99).condition).toBe("thunderstorm");
  });

  it("falls back for unknown codes", () => {
    expect(mapWmoWeatherCode(999).condition).toBe("cloudy");
  });
});

describe("fetchTodayWeather", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a successful Open-Meteo payload into Fahrenheit fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          current: { temperature_2m: 72.4, weather_code: 0 },
          daily: {
            time: ["2026-07-16"],
            temperature_2m_max: [81.2],
            temperature_2m_min: [64.8],
            precipitation_probability_max: [15],
            weather_code: [0],
          },
        }),
        { status: 200 },
      ),
    );

    const result = await fetchTodayWeather(40.7, -74.0);
    expect(result).toEqual({
      currentTempF: 72,
      highF: 81,
      lowF: 65,
      precipitationProbability: 15,
      weatherCode: 0,
      label: "Clear",
      condition: "clear",
      date: "2026-07-16",
    });
  });

  it("returns null on HTTP failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    expect(await fetchTodayWeather(40.7, -74.0)).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    expect(await fetchTodayWeather(40.7, -74.0)).toBeNull();
  });
});
