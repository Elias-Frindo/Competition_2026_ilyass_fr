/* Solar position — NOAA solar calculator (simplified), good to ~0.1° for this purpose.
   Used by the SOLAR_GEOMETRY rule: production is only physically possible when the
   solar elevation exceeds -0.5° (refraction-corrected horizon) at the installation's
   latitude/longitude for that interval. No hardcoded UTC night window. */
(function (global) {
  'use strict';
  const RAD = Math.PI / 180;

  function julianDay(date) {
    return date.getTime() / 86400000 + 2440587.5;
  }

  /** Solar elevation in degrees for a UTC Date at lat/lon (degrees, east positive). */
  function elevation(dateUTC, latDeg, lonDeg) {
    const jd = julianDay(dateUTC);
    const n = jd - 2451545.0;               // days since J2000
    const L = (280.460 + 0.9856474 * n) % 360;       // mean longitude
    const g = ((357.528 + 0.9856003 * n) % 360) * RAD; // mean anomaly
    const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD; // ecliptic longitude
    const eps = (23.439 - 0.0000004 * n) * RAD;       // obliquity
    const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));

    // Greenwich mean sidereal time -> local hour angle
    const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    const utHours = dateUTC.getUTCHours() + dateUTC.getUTCMinutes() / 60 + dateUTC.getUTCSeconds() / 3600;
    let ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / RAD / 15; // hours
    if (ra < 0) ra += 24;
    let ha = (gmst + lonDeg / 15 - ra) * 15 * RAD;
    void utHours;
    const lat = latDeg * RAD;
    const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
    return Math.asin(Math.max(-1, Math.min(1, sinAlt))) / RAD;
  }

  /** Clear-sky capacity factor from elevation, with a soft low-sun cut-in. */
  function clearSkyFactor(elevDeg) {
    if (elevDeg <= 0) return 0;
    const airMassLoss = Math.pow(Math.sin(elevDeg * RAD), 0.72);
    return Math.max(0, Math.min(1, airMassLoss * 0.94));
  }

  global.Solar = { elevation, clearSkyFactor };
})(window);
