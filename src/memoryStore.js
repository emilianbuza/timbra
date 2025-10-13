/**
 * Simpler In-Memory-Store.
 * Für Produktion: echte DB (Postgres/Supabase).
 */

const leadsByPhone = new Map(); // key: phone, value: lead object

export function upsertLead({ name, phone, service }) {
  const lead = leadsByPhone.get(phone) || { createdAt: new Date().toISOString() };
  const updated = { ...lead, name, phone, service, status: "contacted" };
  leadsByPhone.set(phone, updated);
  return updated;
}

export function getLeadByPhone(phone) {
  return leadsByPhone.get(phone) || null;
}

export function setLeadStatus(phone, status, extra = {}) {
  const lead = getLeadByPhone(phone) || { phone };
  const updated = { ...lead, status, ...extra, updatedAt: new Date().toISOString() };
  leadsByPhone.set(phone, updated);
  return updated;
}

export function listLeads() {
  return Array.from(leadsByPhone.values());
}
