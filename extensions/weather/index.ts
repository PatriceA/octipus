import type { PluginContext } from '../../src/plugins/types';

export default {
  name: 'weather',

  async initialize(context: PluginContext): Promise<void> {
    context.logger.info('Weather plugin initialized');
  },

  tools: {
    async get_weather(args: Record<string, unknown>): Promise<unknown> {
      try {
        // Validate input
        const city = args.city as string;
        if (!city || typeof city !== 'string' || city.trim() === '') {
          return { error: 'City parameter is required and must be a non-empty string' };
        }

        // Fetch weather data from wttr.in
        const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
        const response = await fetch(url);
        
        if (!response.ok) {
          return { 
            error: `Failed to fetch weather data: HTTP ${response.status}`,
            status: response.status
          };
        }

        const data = await response.json();
        
        // Extract current weather information
        const currentCondition = data.current_condition?.[0];
        if (!currentCondition) {
          return { error: 'No current weather data available for this location' };
        }

        return {
          city: city,
          temperature: {
            celsius: currentCondition.temp_C,
            fahrenheit: currentCondition.temp_F
          },
          condition: currentCondition.weatherDesc?.[0]?.value || 'Unknown',
          humidity: currentCondition.humidity,
          wind: {
            speed_kph: currentCondition.windspeedKmph,
            speed_mph: currentCondition.windspeedMiles,
            direction: currentCondition.winddir16Point
          },
          feels_like: {
            celsius: currentCondition.FeelsLikeC,
            fahrenheit: currentCondition.FeelsLikeF
          },
          pressure: currentCondition.pressure,
          visibility: currentCondition.visibility,
          cloud_cover: currentCondition.cloudcover,
          last_updated: currentCondition.localObsDateTime || currentCondition.observation_time
        };
      } catch (err: any) {
        return { 
          error: `Error fetching weather data: ${err.message}`,
          details: err.toString()
        };
      }
    },

    async get_forecast(args: Record<string, unknown>): Promise<unknown> {
      try {
        // Validate inputs
        const city = args.city as string;
        const days = args.days as number || 3;
        
        if (!city || typeof city !== 'string' || city.trim() === '') {
          return { error: 'City parameter is required and must be a non-empty string' };
        }
        
        if (typeof days !== 'number' || days < 1 || days > 7) {
          return { error: 'Days parameter must be a number between 1 and 7' };
        }

        // Fetch weather data from wttr.in
        const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
        const response = await fetch(url);
        
        if (!response.ok) {
          return { 
            error: `Failed to fetch forecast data: HTTP ${response.status}`,
            status: response.status
          };
        }

        const data = await response.json();
        
        // Extract forecast information
        const weatherData = data.weather;
        if (!weatherData || !Array.isArray(weatherData)) {
          return { error: 'No forecast data available for this location' };
        }

        // Limit to requested number of days
        const forecastDays = weatherData.slice(0, days);
        
        const forecast = forecastDays.map((day: any, index: number) => {
          const date = day.date;
          const avgTemp = day.avgtempC;
          const maxTemp = day.maxtempC;
          const minTemp = day.mintempC;
          const condition = day.hourly?.[0]?.weatherDesc?.[0]?.value || 'Unknown';
          
          return {
            day: index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : `Day ${index + 1}`,
            date: date,
            temperature: {
              average_celsius: avgTemp,
              max_celsius: maxTemp,
              min_celsius: minTemp
            },
            condition: condition,
            sunrise: day.astronomy?.[0]?.sunrise,
            sunset: day.astronomy?.[0]?.sunset,
            moon_phase: day.astronomy?.[0]?.moon_phase,
            uv_index: day.uvIndex
          };
        });

        return {
          city: city,
          days_requested: days,
          days_returned: forecast.length,
          forecast: forecast
        };
      } catch (err: any) {
        return { 
          error: `Error fetching forecast data: ${err.message}`,
          details: err.toString()
        };
      }
    },
  },

  async shutdown(): Promise<void> {
    // Optional cleanup
  },
};