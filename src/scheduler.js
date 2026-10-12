const { resolveActivityTimes } = require('../public/activity-times');
const { weekdayOf } = require('./dates');

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
 * For each date, the scheduler considers a single parent who is eligible
 * and has enough seats to drive BOTH legs (so the same person handles drop-
 * off and pickup), and compares that with filling the two legs
 * independently. The single driver is used only if it doesn't make the
 * schedule less fair: their drive count so far must be no higher than the
 * average of the drivers the split would use (or the split must leave a ride
 * without a driver / short on seats). Otherwise someone who can always do
 * both legs would take every such date and others would never drive.
 * Each leg is filled using the same fairness rule as before: lowest
 * running drive-count so far (ties broken by longest time since last
 * drove), adding more drivers only while the seats so far aren't enough. If
 * children need a ride on a leg but no parent can drive it, that leg is
 * recorded with noDriverAvailable: true.
 *
 * `history` carries on from drives already done: `counts` (rides driven per
 * member id) and `lastDriven` (each member's latest "YYYY-MM-DD"). Without it
 * everyone would start from zero at the first date given, so every time a
 * date passed the whole future schedule could reshuffle. The returned
 * `driveCounts` only count rides within `dates`.
 *
 * Per-date overrides (`dateOverrides[date]`), besides `excludedChildIds`:
 * `unavailableDriverIds: { there: [ids], back: [ids] }` takes members off a
 * ride they can't make, and `volunteers: { there: [ids], back: [ids] }` puts
 * members on one they've offered to drive. `lockedDrives[date]` (same
 * `{ there, back }` shape) are the drivers a date was locked to shortly
 * before it (see store.lockUpcomingDrives). Volunteers and then locked
 * drivers keep their rides, only as many as are needed to seat everyone;
 * if they aren't enough, the fairest of the others are added.
 */
function buildSchedule(members, dates, dateOverrides = {}, activityTimes = {}, history = {}, lockedDrives = {}) {
  const sortedDates = Array.from(new Set(dates)).sort();
  const startCounts = (history && history.counts) || {};
  const startLast = (history && history.lastDriven) || {};
  const driveCount = new Map(members.map((m) => [m.id, startCounts[m.id] || 0]));
  const lastDriven = new Map(members.map((m) => [m.id, startLast[m.id] || '']));
  const schedule = [];

  const byFairness = (a, b) => {
    const countDiff = driveCount.get(a.id) - driveCount.get(b.id);
    if (countDiff !== 0) return countDiff;
    const recency = lastDriven.get(a.id).localeCompare(lastDriven.get(b.id));
    if (recency !== 0) return recency;
    return a.id.localeCompare(b.id);
  };

  function pickDrivers(candidates, totalChildren) {
    if (totalChildren === 0) return { drivers: [], noDriverAvailable: false, overCapacity: false, strandedCount: 0 };
    if (candidates.length === 0) {
      return { drivers: [], noDriverAvailable: true, overCapacity: false, strandedCount: 0 };
    }
    const sorted = candidates.slice().sort(byFairness);
    const capacityOf = (m) => m.seats;

    // The fairest driver who fits everyone alone; otherwise start with the
    // fairest and keep adding the fairest one who covers the rest (or, if
    // nobody can, the fairest remaining) until everyone has a seat.
    let drivers;
    const soloCandidate = sorted.find((m) => capacityOf(m) >= totalChildren);
    if (soloCandidate) {
      drivers = [soloCandidate];
    } else {
      drivers = [sorted[0]];
      let rest = sorted.slice(1);
      let capacity = capacityOf(sorted[0]);
      while (capacity < totalChildren && rest.length) {
        const next = rest.find((m) => capacity + capacityOf(m) >= totalChildren) || rest[0];
        drivers.push(next);
        capacity += capacityOf(next);
        rest = rest.filter((m) => m !== next);
      }
    }

    const totalCapacity = drivers.reduce((sum, d) => sum + capacityOf(d), 0);
    const overCapacity = totalCapacity < totalChildren;
    const strandedCount = overCapacity ? totalChildren - totalCapacity : 0;
    return { drivers, noDriverAvailable: false, overCapacity, strandedCount };
  }

  // Keeps `fixed` drivers (in order) until everyone has a seat, then tops up
  // from `candidates` by fairness if they fall short.
  function fillLeg(fixed, candidates, totalChildren) {
    if (totalChildren === 0) return pickDrivers([], 0);
    const kept = [];
    let capacity = 0;
    fixed.forEach((m) => {
      if (capacity >= totalChildren) return;
      kept.push(m);
      capacity += m.seats;
    });
    if (!kept.length) return pickDrivers(candidates, totalChildren);
    if (capacity >= totalChildren) return { drivers: kept, noDriverAvailable: false, overCapacity: false, strandedCount: 0 };
    const extra = pickDrivers(candidates.filter((m) => !kept.includes(m)), totalChildren - capacity);
    const drivers = [...kept, ...extra.drivers];
    const stranded = Math.max(0, totalChildren - drivers.reduce((sum, d) => sum + d.seats, 0));
    return { drivers, noDriverAvailable: false, overCapacity: stranded > 0, strandedCount: stranded };
  }

  const memberById = new Map(members.map((m) => [m.id, m]));

  function markDriven(members, dateStr) {
    members.forEach((m) => {
      driveCount.set(m.id, driveCount.get(m.id) + 1);
      lastDriven.set(m.id, dateStr);
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

  sortedDates.forEach((dateStr) => {
    const weekday = weekdayOf(dateStr);
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

    const override = dateOverrides[dateStr] || {};
    const unavailable = {
      there: new Set((override.unavailableDriverIds && override.unavailableDriverIds.there) || []),
      back: new Set((override.unavailableDriverIds && override.unavailableDriverIds.back) || []),
    };
    // Volunteers first, then the drivers the date was locked to.
    const fixedFor = (leg) => {
      const ids = [
        ...((override.volunteers && override.volunteers[leg]) || []),
        ...((lockedDrives[dateStr] && lockedDrives[dateStr][leg]) || []),
      ];
      const out = [];
      ids.forEach((id) => {
        const m = memberById.get(id);
        if (m && m.seats > 0 && !unavailable[leg].has(id) && !out.includes(m)) out.push(m);
      });
      return out;
    };
    const thereFixed = fixedFor('there');
    const backFixed = fixedFor('back');

    // No seats means not driving, whatever days are saved.
    const canDrive = (m, leg) =>
      m.seats > 0 && (m[leg === 'there' ? 'canDriveThereDays' : 'canDriveBackDays'] || []).includes(weekday) && !unavailable[leg].has(m.id);
    const thereEligible = members.filter((m) => canDrive(m, 'there'));
    const backEligible = members.filter((m) => canDrive(m, 'back'));

    // A single driver who can cover both legs solo, if any (not when anyone
    // is already set for either ride).
    const bothEligible = thereFixed.length || backFixed.length ? [] : members.filter((m) => canDrive(m, 'there') && canDrive(m, 'back'));
    const soloBoth = bothEligible
      .slice()
      .sort(byFairness)
      .find((m) => (thereChildren.length === 0 || m.seats >= thereChildren.length) && (backChildren.length === 0 || m.seats >= backChildren.length));

    // Fill the legs independently first (the back leg sees the there leg's
    // drives, as it would for real), remembering the counts beforehand so
    // this can be undone if the solo driver turns out to be the fairer pick.
    const countsBefore = new Map(driveCount);
    const lastBefore = new Map(lastDriven);
    let thereResult = fillLeg(thereFixed, thereEligible, thereChildren.length);
    if (thereResult.drivers.length) markDriven(thereResult.drivers, dateStr);
    let backResult = fillLeg(backFixed, backEligible, backChildren.length);
    if (backResult.drivers.length) markDriven(backResult.drivers, dateStr);

    if (soloBoth && (thereChildren.length > 0 || backChildren.length > 0)) {
      const splitDrivers = [...thereResult.drivers, ...backResult.drivers];
      const splitFallsShort =
        thereResult.noDriverAvailable || backResult.noDriverAvailable || thereResult.overCapacity || backResult.overCapacity;
      const splitAverage = splitDrivers.length
        ? splitDrivers.reduce((sum, d) => sum + countsBefore.get(d.id), 0) / splitDrivers.length
        : Infinity;

      if (splitFallsShort || countsBefore.get(soloBoth.id) <= splitAverage) {
        countsBefore.forEach((v, k) => driveCount.set(k, v));
        lastBefore.forEach((v, k) => lastDriven.set(k, v));
        const solo = (count) =>
          count ? { drivers: [soloBoth], noDriverAvailable: false, overCapacity: false, strandedCount: 0 } : pickDrivers([], 0);
        thereResult = solo(thereChildren.length);
        backResult = solo(backChildren.length);
        const legsDriven = [];
        if (thereChildren.length) legsDriven.push(soloBoth);
        if (backChildren.length) legsDriven.push(soloBoth);
        markDriven(legsDriven, dateStr);
      }
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

  const driveCounts = Object.fromEntries(members.map((m) => [m.id, driveCount.get(m.id) - (startCounts[m.id] || 0)]));
  return { schedule, driveCounts };
}

module.exports = { buildSchedule };
