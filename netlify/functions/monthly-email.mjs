// Scheduled function: on the 1st of each month, emails every member of each
// carpool whose owner turned on monthly emails their schedule for the month.
// Uses Netlify's native function format, which sets up Blobs automatically
// (no connectLambda needed, unlike the Express-based api function).
import notify from '../../src/notify.js';

export default async () => {
  const result = await notify.sendMonthlyEmails((process.env.URL || '').replace(/\/$/, ''));
  console.log('Monthly emails:', JSON.stringify(result));
};

// 13:00 UTC on the 1st = morning across US time zones (and still the 1st
// everywhere in the US, so "this month" is the right month).
export const config = {
  schedule: '0 13 1 * *',
};
