// How a date's drop-off and pick-up times are worked out, shared by the
// server (require) and the pages (a plain <script>, as window.ActivityTimes)
// so the rule lives in one place.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ActivityTimes = factory();
})(this, function () {
  // Resolves the effective {there, back} times for a date, falling back from
  // the most specific override (exact date) to the least (uniform for all days).
  function resolveActivityTimes(activityTimes, date, weekday) {
    const times = activityTimes || {};
    const perDate = (times.perDate && times.perDate[date]) || {};
    const perWeekday = (times.perWeekday && times.perWeekday[weekday]) || {};
    const uniform = times.uniform || {};
    return {
      there: perDate.there || perWeekday.there || uniform.there || null,
      back: perDate.back || perWeekday.back || uniform.back || null,
    };
  }

  return { resolveActivityTimes };
});
