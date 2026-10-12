'use strict';

// SMHI open point forecast (no key). snow1g replaced pmp3g in 2025.
// Docs: https://opendata.smhi.se/metfcst/snow1gv1  - data CC BY 4.0, credit "SMHI".

const http = require('./http');

const URL = 'https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point';

// symbol_code 1-27 -> [text, emoji]
const SYMBOLS = [null,
  ['Clear', '☀️'], ['Nearly clear', '🌤️'], ['Variable cloud', '⛅'], ['Half clear', '⛅'], ['Cloudy', '☁️'], ['Overcast', '☁️'],
  ['Fog', '🌫️'], ['Light showers', '🌦️'], ['Showers', '🌦️'], ['Heavy showers', '🌧️'], ['Thunderstorm', '⛈️'],
  ['Light sleet showers', '🌨️'], ['Sleet showers', '🌨️'], ['Heavy sleet showers', '🌨️'],
  ['Light snow showers', '🌨️'], ['Snow showers', '🌨️'], ['Heavy snow showers', '❄️'],
  ['Light rain', '🌧️'], ['Rain', '🌧️'], ['Heavy rain', '🌧️'], ['Thunder', '⛈️'],
  ['Light sleet', '🌨️'], ['Sleet', '🌨️'], ['Heavy sleet', '🌨️'], ['Light snow', '🌨️'], ['Snow', '❄️'], ['Heavy snow', '❄️'],
];

const SV = [null, 'klart', 'nästan klart', 'växlande molnighet', 'halvklart', 'molnigt', 'mulet', 'dimma', 'lätta regnskurar', 'regnskurar',
  'kraftiga regnskurar', 'åska', 'lätta byar av snöblandat regn', 'byar av snöblandat regn', 'kraftiga byar av snöblandat regn',
  'lätta snöbyar', 'snöbyar', 'kraftiga snöbyar', 'lätt regn', 'regn', 'kraftigt regn', 'åska', 'lätt snöblandat regn', 'snöblandat regn',
  'kraftigt snöblandat regn', 'lätt snöfall', 'snöfall', 'kraftigt snöfall'];

/** Hourly forecast: [{ time (epoch ms), temp, wind, gust, precip (mm/h), precipProb (%), frozen (%), text, icon }] */
async function forecast(lat, lon) {
  const res = await http.request(`${URL}/lon/${(+lon).toFixed(4)}/lat/${(+lat).toFixed(4)}/data.json`, { timeout: 15000 });
  if (!res.ok) throw new Error(`SMHI HTTP ${res.status}`);
  const json = await res.json();
  return (json.timeSeries || []).map((t) => {
    const d = t.data || {};
    const sym = SYMBOLS[d.symbol_code] || ['', ''];
    return {
      time: Date.parse(t.time),
      temp: d.air_temperature,
      wind: d.wind_speed,
      gust: d.wind_speed_of_gust,
      precip: d.precipitation_amount_mean ?? 0,
      precipProb: d.probability_of_precipitation ?? null,
      frozen: d.probability_of_frozen_precipitation ?? null,
      text: sym[0],
      textSv: SV[d.symbol_code] || '',
      icon: sym[1],
    };
  });
}

module.exports = { forecast, SYMBOLS };
