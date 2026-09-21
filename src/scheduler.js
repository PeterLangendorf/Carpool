const { resolveActivityTimes } = require('./store');

/**
 * Builds a fair driving schedule for an explicit list of activity dates
 * (owner-picked, "YYYY-MM-DD" strings). Every active date has two
 * independent rides — "there" (drop-off) and "back" (pickup) — each with
 * its own attendee list, time, and driver assignment.
 *
 * Ride need and driving availability are tracked independently per leg: a
 * child needs a ride on the weekdays listed in `child.needsRideThereDays` /
 * `needsRideBackDays` (minus any per-date exclusion, which applies to both
 * legs), while a parent can only be picked as a driver on the weekdays
 * listed in `member.canDriveThereDays` / `canDriveBackDays`. Seats are the
 * driver's direct passenger capacity (no seat is reserved for the driver).
 *
 * For each date, the scheduler first tries to find a single parent who is
 * eligible and has enough seats to drive BOTH legs (preferred, so the same
 * person handles drop-off and pickup); if no one qualifies solo, the two
 * legs are resolved independently and may end up with different drivers.
 * Each leg is filled using the same fairness rule as before: lowest
 * running drive-count so far (ties broken by longest time since last
 * drove), adding a second driver only if one person's capacity isn't
 * enough. If children need a ride on a leg but no parent can drive it, that
 * leg is recorded with noDriverAvailable: true.
 */
function buildSchedule(members, dates, dateOverrides = {}, activityTimes = {}) {
  const sortedDates = Array.from(new Set(dates)).sort();
  const driveCount = new Map(members.map((m) => [m.id, 0]));
  const lastDrivenIndex = new Map(members.map((m) => [m.id, -1]));
  const schedule = [];

  const byFairness = (a, b) => {
    const countDiff = driveCount.get(a.id) - driveCount.get(b.id);
    if (countDiff !== 0) return countDiff;
    const recencyDiff = lastDrivenIndex.get(a.id) - lastDrivenIndex.get(b.id);
    if (recencyDiff !== 0) return recencyDiff;
    return a.id.localeCompare(b.id);
  };

  function pickDrivers(candidates, totalChildren) {
    if (totalChildren === 0) return { drivers: [], noDriverAvailable: false, overCapacity: false, strandedCount: 0 };
    if (candidates.length === 0) {
      return { drivers: [], noDriverAvailable: true, overCapacity: false, strandedCount: 0 };
    }
    const sorted = candidates.slice().sort(byFairness);
    const capacityOf = (m) => m.seats;

    let drivers;
    const soloCandidate = sorted.find((m) => capacityOf(m) >= totalChildren);
    if (soloCandidate) {
      drivers = [soloCandidate];
    } else {
      const first = sorted[0];
      const rest = sorted.slice(1);
      const combinedEnough = (second) => capacityOf(first) + capacityOf(second) >= totalChildren;
      const second = rest.find(combinedEnough) || rest[0];
      drivers = second ? [first, second] : [first];
    }

    const totalCapacity = drivers.reduce((sum, d) => sum + capacityOf(d), 0);
    const overCapacity = totalCapacity < totalChildren;
    const strandedCount = overCapacity ? totalChildren - totalCapacity : 0;
    return { drivers, noDriverAvailable: false, overCapacity, strandedCount };
  }

  function markDriven(members, index) {
    members.forEach((m) => {
      driveCount.set(m.id, driveCount.get(m.id) + 1);
      lastDrivenIndex.set(m.id, index);
    });
  }

  function finalizeLeg(result, childrenList) {
    return {
      drivers: result.drivers.map((d) => ({ id: d.id, name: d.name })),
      children: childrenList,
      noDriverAvailable: result.noDriverAvailable,
      overCapacity: result.overCapacity,
      strandedCount: result.strandedCount,
    };
  }

  sortedDates.forEach((dateStr, i) => {
    const weekday = new Date(dateStr + 'T00:00:00').getDay();
    const excludedChildIds = new Set(
      (dateOverrides[dateStr] && dateOverrides[dateStr].excludedChildIds) || []
    );

    const thereChildren = [];
    const backChildren = [];
    members.forEach((parent) => {
      (parent.children || []).forEach((child) => {
        if (excludedChildIds.has(child.id)) return;
        const entry = { id: child.id, name: child.name, parentId: parent.id, parentName: parent.name };
        if ((child.needsRideThereDays || []).includes(weekday)) thereChildren.push(entry);
        if ((child.needsRideBackDays || []).includes(weekday)) backChildren.push(entry);
      });
    });

    const thereEligible = members.filter((m) => (m.canDriveThereDays || []).includes(weekday));
    const backEligible = members.filter((m) => (m.canDriveBackDays || []).includes(weekday));

    let thereResult;
    let backResult;

    // Prefer a single driver who can cover both legs solo.
    const bothEligible = members.filter(
      (m) => (m.canDriveThereDays || []).includes(weekday) && (m.canDriveBackDays || []).includes(weekday)
    );
    const soloBoth = bothEligible
      .slice()
      .sort(byFairness)
      .find((m) => (thereChildren.length === 0 || m.seats >= thereChildren.length) && (backChildren.length === 0 || m.seats >= backChildren.length));

    if (soloBoth && (thereChildren.length > 0 || backChildren.length > 0)) {
      thereResult = thereChildren.length
        ? { drivers: [soloBoth], noDriverAvailable: false, overCapacity: false, strandedCount: 0 }
        : { drivers: [], noDriverAvailable: false, overCapacity: false, strandedCount: 0 };
      backResult = backChildren.length
        ? { drivers: [soloBoth], noDriverAvailable: false, overCapacity: false, strandedCount: 0 }
        : { drivers: [], noDriverAvailable: false, overCapacity: false, strandedCount: 0 };
      const legsDriven = [];
      if (thereChildren.length) legsDriven.push(soloBoth);
      if (backChildren.length) legsDriven.push(soloBoth);
      markDriven(legsDriven, i);
    } else {
      thereResult = pickDrivers(thereEligible, thereChildren.length);
      if (thereResult.drivers.length) markDriven(thereResult.drivers, i);
      backResult = pickDrivers(backEligible, backChildren.length);
      if (backResult.drivers.length) markDriven(backResult.drivers, i);
    }

    const times = resolveActivityTimes(activityTimes, dateStr, weekday);

    schedule.push({
      date: dateStr,
      weekday,
      thereTime: times.there,
      backTime: times.back,
      there: finalizeLeg(thereResult, thereChildren),
      back: finalizeLeg(backResult, backChildren),
    });
  });

  const driveCounts = Object.fromEntries(driveCount);
  return { schedule, driveCounts };
}

module.exports = { buildSchedule };
