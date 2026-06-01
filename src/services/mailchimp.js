const axios = require('axios');

// ─────────────────────────────────────────────
// Creates an Axios instance for a specific user's Mailchimp account
// ─────────────────────────────────────────────
function getMailchimpClient(user) {
  return axios.create({
    baseURL: `https://${user.mailchimp_server_prefix}.api.mailchimp.com/3.0`,
    headers: {
      Authorization: `Bearer ${user.mailchimp_access_token}`,
      'Content-Type': 'application/json',
    },
  });
}

// ─────────────────────────────────────────────
// getAllAudiences
// Returns all lists/audiences for the user
// ─────────────────────────────────────────────
async function getAllAudiences(user) {
  const client = getMailchimpClient(user);
  const response = await client.get('/lists', {
    params: { count: 100, fields: 'lists.id,lists.name,lists.stats' },
  });
  return response.data.lists || [];
}

// ─────────────────────────────────────────────
// getContactsPage
// Fetches one page of contacts from a Mailchimp audience
// Used for iterating through all contacts
// ─────────────────────────────────────────────
async function getContactsPage(user, audienceId, status, offset = 0, count = 1000) {
  const client = getMailchimpClient(user);
  const response = await client.get(`/lists/${audienceId}/members`, {
    params: {
      status,
      offset,
      count,
      fields: 'members.id,members.email_address,members.status,members.merge_fields,members.unique_email_id',
    },
  });
  return response.data;
}

// ─────────────────────────────────────────────
// getAllContactsByStatus
// Fetches ALL contacts with a given status (handles pagination)
// ─────────────────────────────────────────────
async function getAllContactsByStatus(user, audienceId, status) {
  const contacts = [];
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const page = await getContactsPage(user, audienceId, status, offset, pageSize);
    const members = page.members || [];
    contacts.push(...members);

    if (members.length < pageSize) break; // Last page
    offset += pageSize;
  }

  return contacts;
}

// ─────────────────────────────────────────────
// archiveContact
// Archives a single contact in Mailchimp
// "Archived" contacts don't count toward billing
// ─────────────────────────────────────────────
async function archiveContact(user, audienceId, subscriberHash) {
  const client = getMailchimpClient(user);
  // DELETE on a member = archive (not permanent delete)
  await client.delete(`/lists/${audienceId}/members/${subscriberHash}`);
}

// ─────────────────────────────────────────────
// restoreContact
// Restores an archived contact back to their original status
// ─────────────────────────────────────────────
async function restoreContact(user, audienceId, subscriberHash, originalStatus) {
  const client = getMailchimpClient(user);
  await client.put(`/lists/${audienceId}/members/${subscriberHash}`, {
    status: originalStatus,
  });
}

// ─────────────────────────────────────────────
// getAudienceInfo
// Gets detailed stats for a single audience
// ─────────────────────────────────────────────
async function getAudienceInfo(user, audienceId) {
  const client = getMailchimpClient(user);
  const response = await client.get(`/lists/${audienceId}`, {
    params: {
      fields: 'id,name,stats,visibility',
    },
  });
  return response.data;
}

// ─────────────────────────────────────────────
// estimateMonthlySavings
// Rough calculation of how much the user could save by archiving waste contacts
// Based on Mailchimp's contact-tier pricing
// ─────────────────────────────────────────────
function estimateMonthlySavings(currentBillableCount, wasteCount) {
  // Mailchimp pricing tiers (approximate, as of 2024 — Essentials plan)
  // This gives a rough estimate for the dashboard
  const tiers = [
    { max: 500, price: 1300 },     // $13/mo
    { max: 1500, price: 2000 },    // $20/mo
    { max: 2500, price: 3000 },    // $30/mo
    { max: 5000, price: 4500 },    // $45/mo
    { max: 10000, price: 7500 },   // $75/mo
    { max: 15000, price: 10000 },  // $100/mo
    { max: 20000, price: 13500 },  // $135/mo
    { max: 25000, price: 18000 },  // $180/mo
    { max: 50000, price: 27000 },  // $270/mo
    { max: Infinity, price: 29000 }, // $290/mo+
  ];

  function getPriceForCount(count) {
    const tier = tiers.find(t => count <= t.max);
    return tier ? tier.price : tiers[tiers.length - 1].price;
  }

  const currentPrice = getPriceForCount(currentBillableCount);
  const newPrice = getPriceForCount(currentBillableCount - wasteCount);
  const savings = Math.max(0, currentPrice - newPrice);

  return {
    current_price_cents: currentPrice,
    new_price_cents: newPrice,
    savings_cents: savings,
  };
}

// ─────────────────────────────────────────────
// findDuplicates
// Identifies duplicate email addresses in a contact list
// Returns the ones to archive (keeps the subscribed version if one exists)
// ─────────────────────────────────────────────
function findDuplicates(contacts) {
  const seen = new Map(); // email -> best contact
  const duplicates = [];

  for (const contact of contacts) {
    const email = contact.email_address.toLowerCase();

    if (seen.has(email)) {
      const existing = seen.get(email);
      // Keep subscribed over unsubscribed; keep the one we already have
      if (existing.status === 'subscribed' || contact.status !== 'subscribed') {
        duplicates.push(contact); // Archive the newcomer
      } else {
        duplicates.push(existing); // Archive the old one, keep the subscribed
        seen.set(email, contact);
      }
    } else {
      seen.set(email, contact);
    }
  }

  return duplicates;
}

module.exports = {
  getAllAudiences,
  getAllContactsByStatus,
  archiveContact,
  restoreContact,
  getAudienceInfo,
  estimateMonthlySavings,
  findDuplicates,
};
