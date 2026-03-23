import type { PluginContext } from '../../src/plugins/types';

export default {
  name: 'weather',

  async initialize(context: PluginContext): Promise<void> {
    context.logger.info('Weather plugin initialized');
  },

  tools: {
    async get_weather(args: Record<string, unknown>): Promise<unknown> {
      const city = args.city as string;
      if (!city) {
        return { error: 'City parameter is required' };
      }

      try {
        const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
        if (!response.ok) {
          return { error: `Failed to fetch weather: HTTP ${response.status}` };
        }

        const data = await response.json();
        const current = data.current_condition?.[0];
        if (!current) {
          return { error: 'No weather data available for this city' };
        }

        return {
          city,
          temperature_c: current.temp_C,
          temperature_f: current.temp_F,
          condition: current.weatherDesc?.[0]?.value ?? 'Unknown',
          humidity: `${current.humidity}%`,
          wind_speed_kmh: current.windspeedKmph,
          wind_direction: current.winddir16Point,
          feels_like_c: current.FeelsLikeC,
        };
      } catch (err: any) {
        return { error: `Failed to fetch weather: ${err.message}` };
      }
    },

    async get_forecast(args: Record<string, unknown>): Promise<unknown> {
      const city = args.city as string;
      if (!city) {
        return { error: 'City parameter is required' };
      }

      const days = Math.min(Math.max(Number(args.days) || 3, 1), 3);

      try {
        const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
        if (!response.ok) {
          return { error: `Failed to fetch forecast: HTTP ${response.status}` };
        }

        const data = await response.json();
        const weatherDays = data.weather;
        if (!weatherDays || weatherDays.length === 0) {
          return { error: 'No forecast data available for this city' };
        }

        const forecast = weatherDays.slice(0, days).map((day: any) => ({
          date: day.date,
          max_temp_c: day.maxtempC,
          min_temp_c: day.mintempC,
          max_temp_f: day.maxtempF,
          min_temp_f: day.mintempF,
          avg_temp_c: day.avgtempC,
          condition: day.hourly?.[4]?.weatherDesc?.[0]?.value ?? 'Unknown',
          humidity: `${day.hourly?.[4]?.humidity ?? 'N/A'}%`,
          chance_of_rain: `${day.hourly?.[4]?.chanceofrain ?? 'N/A'}%`,
          total_snow_cm: day.totalSnow_cm,
          sun_hours: day.sunHour,
        }));

        return { city, days: forecast.length, forecast };
      } catch (err: any) {
        return { error: `Failed to fetch forecast: ${err.message}` };
      }
    },
  },

  async shutdown(): Promise<void> {
    // No cleanup needed
  },
};
