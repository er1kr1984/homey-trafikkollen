# Trafikkollen (Homey app)

Live public transport departures, delay alerts, leave-now reminders and road traffic for anywhere in Sweden.
Data: Trafiklab Realtime APIs (CC BY 4.0, credit Trafiklab.se) and Trafikverket open API.

## Features

Trafikkollen brings Swedish public transport, road traffic, ferries and weather into Homey, for every stop, station, road and road ferry in Sweden.

### Departures near me
Add the "Departures near me" widget to a dashboard and see the next buses, trams and trains from the stops closest to your home, with walking times. No setup needed.

### Departure boards
Add any stop or station as a device and see the next departures with live delays, cancellations and messages from the operator, such as delay reasons and replacement buses. Trains get their track and the reason for a delay from Trafikverket. Filter by line, direction, transport type and platform. Set your walking time and Homey tells you when it is time to leave.

### Watch one particular trip
Want to know if the school bus is late? Enter its departure time, for example 07:40, and the board and all alerts are only about that trip. Then send an alert to the whole family with a Flow.

### Door-to-door commutes
Set up your daily trip once: type the address of your workplace and pick from the suggested nearby stops and change points, and the traffic cameras along the way. The Commute widget shows the best connections right now: when to leave home, every leg with live delays, the change time and when you arrive. Add an "arrive by" time and it picks the latest trip that still gets you there in time. It also shows the car route with road conditions, road surface temperature, traffic messages, live speeds and traffic cameras, and the weather for your commute hours. One tap adds the trip home.

### Smart mornings
Flow cards for your commute: "Time to leave", a ready-written morning briefing to send as a notification or let Homey say, "Public transport gets me there in time", "Frost is likely when I leave", and "Time to turn on the engine heater", timed from the forecast temperature when you leave by car. "Weekdays only" skips Swedish public holidays.

Problem alerts: turn them on for a commute and Homey sends a notification to your phone in the commute hours when a trip is cancelled or late, your lines have a message, or there is an accident, slippery roads or a queue on the car route. Each problem is sent once a day. Roadworks are left out. Want it louder, or only on some days? Use the Flow card "There is a problem on a commute" instead.

### Road traffic
Watch the roads you use: accidents, roadworks, queues and slippery-road warnings from Trafikverket, with a live traffic camera as the device image. To choose the camera from a list with photos, open the device's settings and tap Repair (that is where Homey puts the camera picker; nothing is broken).

### Road ferries
Add any of Trafikverket's road ferries (Hönö, Vaxholm, Visingsö, Gräsö and about 35 more) as a device: next departures, a reminder when it is time to leave, and alerts when the ferry is disrupted.

### Getting started
Trafikkollen uses two free API keys, one from Trafiklab (public transport) and one from Trafikverket (roads, trains and ferries). The app settings explain step by step how to get them; it takes about five minutes.

### Good to know
- Sweden only. Needs a Homey Pro with Homey 12.1 or later.
- The free Trafiklab key allows 25 requests a minute and 100,000 a month. That is plenty for a few departure boards and a commute or two; with many devices, set them to update less often. The app spreads its requests out so it stays under the limit.
- Commutes follow real trips through the change stops you choose. It is not a full journey planner: if a good route is missing, add its change stop yourself.
- The driving time in a commute is the normal time you type in. The widget shows live road messages, speeds and cameras, but does not recalculate the driving time.
- "Find cameras along the way" looks near a straight line between start and destination. For cameras on a road that curves away, search for them by place name.
- A ferry's Disruption alarm also turns on for disruptions Trafikverket has announced for later.
- Notifications reach your phone only if notifications are turned on for Trafikkollen in the Homey app.

### Privacy
Your keys and settings stay on your Homey. When you use the address search in the settings, the address you type is sent to OpenStreetMap's public address search (Nominatim) to find the place. Nothing else leaves your Homey except the requests to Trafiklab, Trafikverket and SMHI that fetch the traffic and weather data.

Data: Trafiklab.se (CC BY 4.0), Trafikverket (open data), SMHI (CC BY 4.0) and © OpenStreetMap contributors (address search). Trafikkollen is an independent app and is not affiliated with Trafiklab, Trafikverket, SMHI, OpenStreetMap or any transport operator.

## Support
Questions, bugs or ideas: open an issue at https://github.com/er1kr1984/homey-trafikkollen/issues
or join the discussion on the Homey Community forum: https://community.homey.app/t/160770
(include the app version, your Homey model/version and what you expected to happen).

## Setup
1. Keys (free): Trafiklab (trafiklab.se, project with "Trafiklab Realtime APIs", Bronze) and Trafikverket (data.trafikverket.se).
2. Homey: Apps > Trafikkollen > Configure > paste keys > "Save and test".
3. Add devices: "Departure board" (search a stop; set lines/direction/walking time/active hours in device settings)
   and "Road traffic" (roads + centre + radius).

## Commutes (Commute widget)
Set up in the app settings (stop search, change stops, destination stops + walk, car route cameras/sensors, weather).
Stored as JSON in app setting `commutes`. Journeys are built by following trip ids across Trafiklab departure/arrival
boards (lib/journey.js). ~9 Trafiklab calls per refresh (+4 per extra change stop), only while a widget is open, cached
90 s in commute hours / 15 min otherwise; on errors (e.g. the 25/min Bronze limit) the last good data is shown, marked ⚠.
Store texts: README.txt / README.sv.txt. Translations: locales/en.json + sv.json and "sv" in all compose JSON.

## 0.6 additions
- lib/plan.js: arrive-by target trip, engine heater lead time (≥+10: 0, ≥0: 30, ≥-10: 60, ≥-20: 90, else 120 min), frost, briefing text.
- App-level Flow cards per commute (commute_leave, commute_heater, commute_frost, commute_late, commute_briefing with returned tokens);
  app.watchCommutes() runs every minute: heater on commute days (SMHI only), leave alert only in commute hours with an arrive-by plan.
- lib/trains.js: Trafikverket TrainAnnouncement (track, cancellations, reasons) matched by train number ±3 min at the station near the stop.
- Trafiklab `alerts` -> departure `notes`; trigger departure_disruption (also for ferries).
- lib/ferries.js + drivers/ferry: Trafikverket FerryRoute/FerryAnnouncement 1.2, disruptions from Situation (MessageType Färjor).
- widgets/nearby: nearest stops to the Homey (stop index once, cached in setting nearby_stops), duplicates skipped.
- departures setting `times` (watch single trips), Swedish public holidays in isActive(weekdaysOnly).

## Flow cards
Triggers: departure delayed, departure cancelled, time to leave, new road incident, road incident cleared, slippery roads on/off.
Conditions: next departure delayed by >= N min, road incidents present, roads slippery. Action: refresh now.
Triggers only fire during the device's active hours, once per trip, and never for things already true at app start.

## Quota
Trafiklab Bronze: 25 calls/min, 100 000/month. One board at 2-min updates in active hours and 10-min outside is ~10-20k/month.

## Dev
    npm test                 # unit tests (no Homey needed)
    homey app validate       # passes level `publish`
    homey app install        # install on the active Homey
Trafikverket query variants (schema versions / geo filter) are tried in order in lib/trafikverket.js; the first that works is used.

## License
MIT, see [LICENSE](LICENSE). Data from Trafiklab, Trafikverket, SMHI and OpenStreetMap is used under their own terms (see README.txt).
